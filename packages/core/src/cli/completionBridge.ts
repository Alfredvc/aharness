/**
 * Per-Tab shell-completion bridge.
 *
 * Split out from `cli/completion.ts` so install/uninstall (exercised by a
 * subprocess integration test using Node's native TS-stripping) doesn't
 * pull internal `loader/` modules into its module graph. The subprocess
 * test only loads `cli/completion.ts`, never this file — so static
 * imports of `../loader/sidecar.js` / `../loader/inputFlags.js` are safe
 * here.
 *
 * AST-only path: flag-name + static value completion is served from
 * `loader/sidecar.ts`'s `extractSchemaSidecar` (TS compiler API walk,
 * no JavaScript execution). Dynamic-callback completion (Task 21)
 * escalates to full local or installed FSM loading.
 *
 * Silent-error policy: any failure during the per-Tab bridge emits
 * zero suggestions and returns exit 0. Stuck imports during the bridge
 * are bounded by a 500 ms watchdog installed by the CLI dispatcher in
 * `cli/main.ts` — NOT inside this file. Putting `process.exit` inside
 * the bridge would kill the test runner when the bridge is unit-tested.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tabtab from '@pnpm/tabtab';
import type { JSONSchema7 } from 'json-schema';
import { parse as shellParse } from 'shell-quote';
import { extractSchemaSidecar } from '../loader/sidecar.js';
import { camelToKebab } from '../loader/inputFlags.js';
import type { ArgFlagMeta, StaticCompletionKind } from '../loader/inputSchema.js';
import { loadFsm, loadInstalledFsm } from '../loader/index.js';
import type { ArgSentinel } from '../state/args.js';
import {
  checkInstalledLockFingerprint,
  readInstalledCompletionSnapshot,
  resolveInstalledCommand,
  type InstalledRuntimeSnapshot,
  type TrustedCommandIndexEntry,
} from '../installStore/index.js';

/**
 * Reachable shape of `machine.config.input` after `loadFsm()` returns. Phase 3
 * Task 12 leaves the runtime `arg<T>(meta?)` sentinel verbatim on the root
 * config — `aharness.machine()` does not strip the `input` field, and
 * `cloneConfigPreservingFns` keeps function references intact — so the
 * `{dynamic: fn}` callback survives at `machine.config.input?.[field]?.meta?.completion?.dynamic`.
 *
 * The cast at the call site is `as unknown as LoadedConfig`. `loadFsm`'s
 * declared return type is XState's type-erased `AnyStateMachine`; we are
 * recovering the user-typed sub-shape that `arg<T>()` knows about. This is
 * the single boundary where the typed/untyped worlds meet.
 */
type LoadedConfig = {
  readonly config: { readonly input?: Record<string, ArgSentinel<unknown>> };
};

/**
 * The per-Tab bridge. Reads tabtab env from `opts.env`, writes suggestions
 * via `opts.stdout`. Returns exit 0 always (silent-error policy).
 *
 * No `process.exit` calls inside this function — the binary's main()
 * owns process termination, including watchdog-driven termination.
 *
 * AST-only flag-name + static value completion (file, directory, {values})
 * runs without executing user code. The `{dynamic: true}` sentinel branch
 * in `emitValueCompletion` escalates into the appropriate FSM loader to
 * recover the live callback — that is the only path that runs user module
 * code at Tab time.
 */
export interface CompletionBridgeOpts {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
}

/**
 * Cap on the number of entries `enumerateFs` will scan from a single
 * directory. Without this cap, Tab on a `completion: 'file'` flag inside
 * a directory like `node_modules` would dominate the watchdog budget and
 * either time out or produce visibly slow Tab feel.
 */
const FILE_ENUMERATE_CAP = 1000;
const TABTAB_FILE_COMPLETION_SENTINEL = '__tabtab_complete_files__';
const FILE_PATH_SUBCOMMANDS = new Set(['verify', 'visualize']);
const ROOT_SUBCOMMANDS = [
  'completion',
  'doctor',
  'init',
  'install',
  'list',
  'run',
  'uninstall',
  'verify',
  'visualize',
] as const;

interface InputCompletionMetadata {
  readonly schema: JSONSchema7;
  readonly flags: Record<string, ArgFlagMeta>;
  readonly fieldTypes: ReadonlyMap<string, string | undefined>;
  readonly fieldsByKebab: ReadonlyMap<string, string>;
}

type CompletionInputTarget =
  | { readonly kind: 'local'; readonly filePath: string }
  | {
      readonly kind: 'installed';
      readonly identity: string;
      readonly entryFile: string;
      readonly packageName: string;
      readonly commandName: string;
      readonly packageRoot: string;
      readonly managedProjectRoot: string;
      readonly storeRoot: string;
      readonly lockFingerprint: string;
    };

type CompletionContext =
  | { readonly kind: 'root'; readonly partial: string }
  | { readonly kind: 'run-target'; readonly partial: string }
  | { readonly kind: 'direct-file-target' }
  | {
      readonly kind: 'post-target-input';
      readonly target: CompletionInputTarget;
      readonly inputArgs: ReadonlyArray<string>;
    }
  | { readonly kind: 'other-subcommand' };

type InputTailCompletion =
  | {
      readonly kind: 'flags';
      readonly partial: string;
      readonly consumedFields: ReadonlySet<string>;
    }
  | { readonly kind: 'value'; readonly flag: string; readonly partial: string }
  | { readonly kind: 'none' };

export async function runCompletionBridge(
  opts: CompletionBridgeOpts,
): Promise<{ exitCode: number }> {
  // No watchdog inside this function — the dispatcher races us against a
  // 500 ms timeout (cli/main.ts). process.exit lives there, not here.
  // Silent-error policy: any throw inside the bridge becomes an empty
  // suggestion list with exit 0.
  try {
    const parsed = tabtab.parseEnv(opts.env);
    if (!parsed.complete) return { exitCode: 0 };

    const tokens = tokeniseLine(parsed.line, parsed.point);
    const context = await deriveCompletionContext(tokens, parsed.last, opts.cwd, opts.env);
    if (context.kind === 'root') {
      for (const command of ROOT_SUBCOMMANDS) {
        if (command.startsWith(context.partial)) opts.stdout.write(`${command}\n`);
      }
      return { exitCode: 0 };
    }
    if (context.kind === 'run-target') {
      const suggestions = new Set<string>();
      for (const candidate of enumerateLocalRunTargets(context.partial, opts.cwd)) {
        suggestions.add(candidate);
      }
      const snapshot = await readInstalledCompletionSnapshot({ env: opts.env });
      for (const candidate of buildInstalledCommandSuggestions(
        snapshot,
        context.partial,
        opts.cwd,
      )) {
        suggestions.add(candidate);
      }
      for (const suggestion of suggestions) opts.stdout.write(`${suggestion}\n`);
      return { exitCode: 0 };
    }
    if (context.kind === 'direct-file-target') {
      if (!parsed.last.startsWith('--')) {
        emitNativeFileCompletion(opts.stdout);
      }
      return { exitCode: 0 };
    }
    if (context.kind === 'other-subcommand') {
      return { exitCode: 0 };
    }

    const metadata = await extractInputCompletionMetadataForTarget(context.target);
    const tail = classifyInputTail(metadata, context.inputArgs, parsed.last);

    if (tail.kind === 'value') {
      await emitValueCompletion(
        metadata,
        tail.flag,
        tail.partial,
        context.target,
        opts.cwd,
        opts.stdout,
      );
      return { exitCode: 0 };
    }
    // Flag-name completion. Renders `--<kebab-name>` per matching field;
    // if the field declares `meta.description`, append `:description` so
    // tabtab-aware shells (zsh, fish) render a per-suggestion hint.
    if (tail.kind === 'flags') {
      for (const fld of Object.keys(metadata.flags)) {
        if (tail.consumedFields.has(fld)) continue;
        const kebab = `--${camelToKebab(fld)}`;
        if (kebab.startsWith(tail.partial)) {
          const meta = metadata.flags[fld];
          if (meta?.description) {
            opts.stdout.write(`${kebab}:${meta.description}\n`);
          } else {
            opts.stdout.write(`${kebab}\n`);
          }
        }
      }
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  } catch {
    return { exitCode: 0 };
  }
}

/**
 * Quote-aware tokenisation of the command line up to the cursor. Uses
 * `shell-quote` so paths with spaces (`"my idea.md"`) and escaped chars
 * survive intact. `shell-quote.parse` may emit operator objects (e.g. for
 * unbalanced redirections) — we filter those down to strings only. Falls
 * back to whitespace split on parse failure.
 */
function tokeniseLine(line: string, point: number): ReadonlyArray<string> {
  const upTo = line.slice(0, point);
  try {
    const parts = shellParse(upTo);
    return parts.filter((p): p is string => typeof p === 'string');
  } catch {
    return upTo.split(/\s+/).filter(Boolean);
  }
}

/**
 * Classify completion from the command grammar instead of scanning the whole
 * line for any later `.ts` token. Direct FSM input completion is only active
 * when the first user token itself resolves to an existing regular `.ts` file.
 */
async function deriveCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CompletionContext> {
  const firstToken = tokens[1];
  if (!firstToken) return { kind: 'root', partial: '' };

  if (firstToken === 'run') {
    const runTarget = await deriveRunTargetCompletionContext(tokens, last, cwd, env);
    if (runTarget) return runTarget;
  }

  if (FILE_PATH_SUBCOMMANDS.has(firstToken)) {
    const fileTarget = deriveFilePathSubcommandCompletionContext(tokens, last, cwd);
    if (fileTarget) return fileTarget;
  }

  const directRun = deriveDirectRunCompletionContext(tokens, last, cwd);
  if (directRun) return directRun;

  if (tokens.length === 2 && last !== '') {
    if (isPathLikeToken(firstToken)) {
      const target = resolveLocalInputTarget(firstToken, cwd);
      return target
        ? { kind: 'post-target-input', target, inputArgs: [] }
        : { kind: 'direct-file-target' };
    }
    return { kind: 'root', partial: firstToken };
  }

  if (isPathLikeToken(firstToken)) {
    if (tokens.length > 2) return { kind: 'other-subcommand' };
    const target = resolveLocalInputTarget(firstToken, cwd);
    return target
      ? { kind: 'post-target-input', target, inputArgs: [] }
      : { kind: 'direct-file-target' };
  }

  return { kind: 'other-subcommand' };
}

function deriveDirectRunCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
  cwd: string,
): CompletionContext | null {
  const args = tokens.slice(1);
  let targetIndex = 0;
  let consumedPermissionFlag: string | undefined;

  if (isRuntimePermissionFlag(args[targetIndex])) {
    consumedPermissionFlag = args[targetIndex];
    targetIndex++;
  }

  const targetToken = args[targetIndex];
  if (!targetToken) {
    return last === '' ? { kind: 'direct-file-target' } : null;
  }
  if (targetToken.startsWith('--')) return null;

  const cursorIsOnTarget = targetIndex === args.length - 1 && last === targetToken && last !== '';
  if (cursorIsOnTarget) {
    const target = resolveLocalInputTarget(targetToken, cwd);
    if (target) return { kind: 'post-target-input', target, inputArgs: [] };
    return consumedPermissionFlag || isPathLikeToken(targetToken)
      ? { kind: 'direct-file-target' }
      : null;
  }

  const inputArgs = stripDirectRunRuntimeFlags(args.slice(targetIndex + 1), consumedPermissionFlag);
  if (!inputArgs || !isValidInputCompletionTail(inputArgs)) return null;

  const target = resolveLocalInputTarget(targetToken, cwd);
  return target ? { kind: 'post-target-input', target, inputArgs } : null;
}

function deriveFilePathSubcommandCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
  cwd: string,
): CompletionContext | null {
  const subcommand = tokens[1];
  const targetToken = tokens[2];
  if (!targetToken) {
    return last === '' ? { kind: 'direct-file-target' } : null;
  }
  if (targetToken.startsWith('--')) return null;

  const cursorIsOnTarget = tokens.length === 3 && last === targetToken && last !== '';
  if (cursorIsOnTarget) {
    const target = resolveLocalInputTarget(targetToken, cwd);
    return target ? { kind: 'other-subcommand' } : { kind: 'direct-file-target' };
  }

  if (subcommand === 'visualize') {
    const inputArgs = tokens.slice(3);
    if (!isValidInputCompletionTail(inputArgs)) return null;
    const target = resolveLocalInputTarget(targetToken, cwd);
    if (target) return { kind: 'post-target-input', target, inputArgs };
  }

  return { kind: 'other-subcommand' };
}

async function deriveRunTargetCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CompletionContext | null> {
  const afterRun = tokens.slice(2);
  let targetIndex = 0;

  if (isRuntimePermissionFlag(afterRun[targetIndex])) targetIndex++;

  if (targetIndex === afterRun.length) {
    return last === '' ? { kind: 'run-target', partial: '' } : null;
  }

  const targetToken = afterRun[targetIndex]!;
  if (targetToken.startsWith('--')) return null;

  const cursorIsOnTarget =
    targetIndex === afterRun.length - 1 && last === targetToken && last !== '';
  if (cursorIsOnTarget) return { kind: 'run-target', partial: targetToken };

  const inputArgs = afterRun.slice(targetIndex + 1);
  if (!isValidInputCompletionTail(inputArgs)) return null;

  const target = await resolveCompletionInputTarget({ targetToken, cwd, env });
  if (target) return { kind: 'post-target-input', target, inputArgs };
  if (targetIndex === afterRun.length - 1) return { kind: 'run-target', partial: targetToken };
  return null;
}

function isValidInputCompletionTail(inputArgs: ReadonlyArray<string>): boolean {
  for (let i = 0; i < inputArgs.length; i++) {
    const current = inputArgs[i]!;
    if (!current.startsWith('--')) return false;
    if (isRuntimePermissionFlag(current)) return false;
    const next = inputArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) i++;
  }
  return true;
}

function stripDirectRunRuntimeFlags(
  inputArgs: ReadonlyArray<string>,
  leadingPermissionFlag: string | undefined,
): readonly string[] | null {
  const stripped: string[] = [];
  let permissionFlag = leadingPermissionFlag;

  for (const current of inputArgs) {
    if (!isRuntimePermissionFlag(current)) {
      stripped.push(current);
      continue;
    }
    if (permissionFlag !== undefined && permissionFlag !== current) return null;
    permissionFlag = current;
  }

  return stripped;
}

function isRuntimePermissionFlag(flag: string | undefined): flag is '--ask' | '--yolo' {
  return flag === '--ask' || flag === '--yolo';
}

async function resolveCompletionInputTarget(args: {
  readonly targetToken: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CompletionInputTarget | null> {
  const localPath = path.resolve(args.cwd, args.targetToken);
  if (isExistingRegularFileSync(args.cwd, args.targetToken)) {
    return { kind: 'local', filePath: localPath };
  }

  const snapshot = await readInstalledCompletionSnapshot({ env: args.env });
  const resolved = resolveInstalledCommand(args.targetToken, snapshot);
  if (!resolved.ok) return null;

  const lock = await checkInstalledLockFingerprint(resolved.value.install, snapshot.paths);
  if (!lock.ok) return null;

  return {
    kind: 'installed',
    identity: resolved.value.identity,
    entryFile: path.join(resolved.value.install.packageRoot, resolved.value.command.entry),
    packageName: resolved.value.install.packageName,
    commandName: resolved.value.command.commandName,
    packageRoot: resolved.value.install.packageRoot,
    managedProjectRoot: snapshot.paths.managedProjectRoot,
    storeRoot: snapshot.paths.storeRoot,
    lockFingerprint: lock.value,
  };
}

function resolveLocalInputTarget(token: string, cwd: string): CompletionInputTarget | null {
  if (!token.endsWith('.ts')) return null;
  const abs = path.resolve(cwd, token);
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return { kind: 'local', filePath: abs };
}

function isPathLikeToken(token: string): boolean {
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    token.includes('/')
  );
}

function emitNativeFileCompletion(stdout: NodeJS.WritableStream): void {
  stdout.write(`${TABTAB_FILE_COMPLETION_SENTINEL}\n`);
}

function enumerateLocalRunTargets(partial: string, cwd: string): readonly string[] {
  const { dirPart, displayDir, prefix } = splitRunTargetPartial(partial);
  const absDir = path.resolve(cwd, dirPart);
  const out: string[] = [];
  try {
    const dirents = fs.readdirSync(absDir, { withFileTypes: true });
    let matched = 0;
    for (const dirent of dirents) {
      if (!dirent.name.startsWith(prefix)) continue;
      if (!dirent.isDirectory() && !dirent.isFile()) continue;
      if (dirent.isFile() && !dirent.name.endsWith('.fsm.ts')) continue;
      out.push(`${displayDir}${dirent.name}`);
      if (++matched >= FILE_ENUMERATE_CAP) break;
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function splitRunTargetPartial(partial: string): {
  readonly dirPart: string;
  readonly displayDir: string;
  readonly prefix: string;
} {
  if (!partial.includes('/')) {
    return { dirPart: '.', displayDir: '', prefix: partial };
  }
  if (partial.endsWith('/')) {
    return { dirPart: partial, displayDir: partial, prefix: '' };
  }
  const slash = partial.lastIndexOf('/');
  const displayDir = partial.slice(0, slash + 1);
  return {
    dirPart: displayDir,
    displayDir,
    prefix: partial.slice(slash + 1),
  };
}

interface InstalledSuggestion {
  readonly value: string;
  readonly output: string;
  readonly commandName: string;
}

function buildInstalledCommandSuggestions(
  snapshot: InstalledRuntimeSnapshot,
  partial: string,
  cwd: string,
): readonly string[] {
  const commands = snapshot.commands.commands;
  const bareCounts = new Map<string, number>();
  for (const entry of Object.values(commands)) {
    bareCounts.set(entry.commandName, (bareCounts.get(entry.commandName) ?? 0) + 1);
  }

  const bare: InstalledSuggestion[] = [];
  const qualified: InstalledSuggestion[] = [];
  for (const [identity, entry] of Object.entries(commands)) {
    if ((bareCounts.get(entry.commandName) ?? 0) === 1) {
      bare.push(formatInstalledSuggestion(entry.commandName, entry));
    }
    qualified.push(formatInstalledSuggestion(identity, entry));
  }

  return [...bare.sort(byValue), ...qualified.sort(byValue)]
    .filter((suggestion) => matchesInstalledPartial(suggestion, partial))
    .filter((suggestion) => !isExistingRegularFileSync(cwd, suggestion.value))
    .map((suggestion) => suggestion.output);
}

function formatInstalledSuggestion(
  value: string,
  entry: TrustedCommandIndexEntry,
): InstalledSuggestion {
  return {
    value,
    output: entry.description ? `${value}:${entry.description}` : value,
    commandName: entry.commandName,
  };
}

function matchesInstalledPartial(suggestion: InstalledSuggestion, partial: string): boolean {
  return suggestion.value.startsWith(partial) || suggestion.commandName.startsWith(partial);
}

function byValue(a: InstalledSuggestion, b: InstalledSuggestion): number {
  return a.value.localeCompare(b.value);
}

function isExistingRegularFileSync(cwd: string, target: string): boolean {
  try {
    return fs.statSync(path.resolve(cwd, target)).isFile();
  } catch {
    return false;
  }
}

async function extractInputCompletionMetadataForTarget(
  target: CompletionInputTarget,
): Promise<InputCompletionMetadata> {
  if (target.kind === 'local') {
    const extraction = await extractSchemaSidecar({ filePath: target.filePath });
    return buildInputCompletionMetadata(extraction.inputSchema, extraction.inputFlags);
  }

  const extraction = await extractSchemaSidecar({
    filePath: target.entryFile,
    packageResolution: {
      packageRoot: target.packageRoot,
      managedProjectRoot: target.managedProjectRoot,
    },
  });
  return buildInputCompletionMetadata(extraction.inputSchema, extraction.inputFlags);
}

function buildInputCompletionMetadata(
  schema: JSONSchema7 | undefined,
  flags: Record<string, ArgFlagMeta> | undefined,
): InputCompletionMetadata {
  if (!schema || !flags) {
    throw new Error('input completion metadata unavailable');
  }
  const fieldTypes = new Map<string, string | undefined>();
  const fieldsByKebab = new Map<string, string>();
  const propEntries = Object.entries(schema.properties ?? {}) as Array<[string, JSONSchema7]>;
  for (const [field, fieldSchema] of propEntries) {
    fieldTypes.set(field, typeof fieldSchema.type === 'string' ? fieldSchema.type : undefined);
    fieldsByKebab.set(camelToKebab(field), field);
  }
  return { schema, flags, fieldTypes, fieldsByKebab };
}

function classifyInputTail(
  metadata: InputCompletionMetadata,
  inputArgs: ReadonlyArray<string>,
  last: string,
): InputTailCompletion {
  const consumedFields = new Set<string>();

  for (let i = 0; i < inputArgs.length; i++) {
    const token = inputArgs[i]!;
    if (!token.startsWith('--')) return { kind: 'none' };

    if (i === inputArgs.length - 1 && last.startsWith('--')) {
      return { kind: 'flags', partial: token, consumedFields };
    }

    const field = metadata.fieldsByKebab.get(token.slice(2));
    if (!field || !(field in metadata.flags)) return { kind: 'none' };

    const next = inputArgs[i + 1];
    if (metadata.fieldTypes.get(field) === 'boolean') {
      if (next === undefined) {
        if (last === '') {
          consumedFields.add(field);
          return { kind: 'flags', partial: '', consumedFields };
        }
        return { kind: 'flags', partial: token, consumedFields };
      }
      if (next === 'true' || next === 'false') {
        consumedFields.add(field);
        i++;
        continue;
      }
      if (next.startsWith('--')) {
        consumedFields.add(field);
        continue;
      }
      if (i + 1 === inputArgs.length - 1) {
        const matchesBoolean = 'true'.startsWith(next) || 'false'.startsWith(next);
        return matchesBoolean ? { kind: 'value', flag: token, partial: next } : { kind: 'none' };
      }
      return { kind: 'none' };
    }

    if (next === undefined) {
      return last === ''
        ? { kind: 'value', flag: token, partial: '' }
        : { kind: 'flags', partial: token, consumedFields };
    }
    if (next.startsWith('--')) return { kind: 'none' };
    if (i + 1 === inputArgs.length - 1 && last === next) {
      return { kind: 'value', flag: token, partial: next };
    }

    consumedFields.add(field);
    i++;
  }

  return { kind: 'flags', partial: last.startsWith('--') ? last : '', consumedFields };
}

/**
 * Map a `--<kebab-name>` flag back to its declared field name and look
 * up its meta. Returns undefined when the flag name does not resolve to
 * a declared input field.
 */
function lookupFlagByKebab(
  metadata: InputCompletionMetadata,
  kebabFlag: string,
): ArgFlagMeta | undefined {
  const field = metadata.fieldsByKebab.get(kebabFlag.replace(/^--/, ''));
  return field ? metadata.flags[field] : undefined;
}

/**
 * Dispatch on a flag's `completion` static kind. `'file'` delegates to native
 * shell file completion, `'directory'` enumerates directories locally,
 * `{values: [...]}` emits prefix matches;
 * `{dynamic: true}` escalates to the local or installed FSM loader so the
 * live callback (which the JSON sidecar reduces to a `{dynamic: true}`
 * sentinel) can be resolved off
 * `machine.config.input?.[field]?.meta?.completion?.dynamic` and invoked.
 *
 * Spec §5.7 risk: the dynamic-callback path executes user module code at
 * Tab time. Phase 5 docs surface this; no inline mitigation here.
 */
async function emitValueCompletion(
  metadata: InputCompletionMetadata,
  kebabFlag: string,
  partial: string,
  target: CompletionInputTarget,
  cwd: string,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  const field = metadata.fieldsByKebab.get(kebabFlag.replace(/^--/, ''));
  if (field && metadata.fieldTypes.get(field) === 'boolean') {
    for (const value of ['true', 'false']) {
      if (value.startsWith(partial)) stdout.write(`${value}\n`);
    }
    return;
  }

  const meta = lookupFlagByKebab(metadata, kebabFlag);
  const c: StaticCompletionKind | undefined = meta?.completion;
  if (c === undefined) return;
  if (c === 'file') {
    emitNativeFileCompletion(stdout);
    return;
  }
  if (c === 'directory') {
    enumerateFs(partial, true, stdout);
    return;
  }
  if ('values' in c) {
    for (const v of c.values) {
      if (v.startsWith(partial)) stdout.write(`${v}\n`);
    }
    return;
  }
  if ('dynamic' in c) {
    // c is { dynamic: true } — escalate to full loadFsm to recover the
    // live function reference (the JSON sidecar only persists the
    // sentinel). Silent-error policy: any failure on the load path or
    // inside the user-supplied callback emits nothing.
    let loaded;
    try {
      loaded =
        target.kind === 'local'
          ? await loadFsm({ filePath: target.filePath, repoRoot: findRepoRoot(cwd) ?? cwd })
          : await loadInstalledFsm({
              entryFile: target.entryFile,
              packageName: target.packageName,
              commandName: target.commandName,
              packageRoot: target.packageRoot,
              managedProjectRoot: target.managedProjectRoot,
              storeRoot: target.storeRoot,
              lockFingerprint: target.lockFingerprint,
            });
    } catch {
      return;
    }
    const machine = loaded.machine as unknown as LoadedConfig;
    const field = metadata.fieldsByKebab.get(kebabFlag.replace(/^--/, ''));
    if (!field) return;
    const sentinel = machine.config.input?.[field];
    const dyn = sentinel?.meta?.completion;
    if (
      !dyn ||
      typeof dyn !== 'object' ||
      !('dynamic' in dyn) ||
      typeof dyn.dynamic !== 'function'
    ) {
      return;
    }
    let out: ReadonlyArray<string>;
    const fsmFile = target.kind === 'local' ? target.filePath : target.entryFile;
    try {
      out = dyn.dynamic(partial, { fsmFile, cwd });
    } catch {
      return;
    }
    for (const v of out) {
      if (v.startsWith(partial)) stdout.write(`${v}\n`);
    }
    return;
  }
}

/**
 * Walk upward from `start` looking for a directory that contains
 * `package.json`; return the first match. Capped at 32 levels so a
 * pathological cwd cannot wedge the bridge inside its 500 ms watchdog
 * budget. Returns null when no ancestor matches — the caller falls back
 * to using `cwd` directly as the repo root.
 *
 * Used only on the dynamic-callback path: `loadFsm()` needs a repo root
 * to resolve the user's `node_modules` and the `.aharness/cache/` location.
 */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Synchronous filesystem enumeration. Capped at FILE_ENUMERATE_CAP to
 * avoid swamping Tab in directories like `node_modules`. Empty `partial`
 * means "list cwd"; partial with a slash means "list dirname(partial)
 * filtered by basename(partial) prefix".
 *
 * The cap is applied to MATCHED entries, not raw dirents: in dense
 * directories where prefix-matching entries sort past `FILE_ENUMERATE_CAP`
 * in `readdir` order, a cap-then-filter ordering would silently produce
 * zero suggestions even though matches exist. Filtering inside the
 * collection loop ensures the user sees matches as long as at least one
 * appears anywhere in the directory.
 *
 * Exported for direct unit testing of the dense-directory regression
 * (the bridge-level path is exercised by the public surface tests).
 */
export function enumerateFs(
  partial: string,
  dirsOnly: boolean,
  stdout: NodeJS.WritableStream,
): void {
  const dir = partial && partial.includes('/') ? path.dirname(partial) : '.';
  const prefix = partial && partial.includes('/') ? path.basename(partial) : partial;
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    let matched = 0;
    for (const e of dirents) {
      if (dirsOnly && !e.isDirectory()) continue;
      if (!e.name.startsWith(prefix)) continue;
      const full = path.join(dir === '.' ? '' : dir, e.name);
      stdout.write(`${full}\n`);
      if (++matched >= FILE_ENUMERATE_CAP) break;
    }
  } catch {
    return;
  }
}
