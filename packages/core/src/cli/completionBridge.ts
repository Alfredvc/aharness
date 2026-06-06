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
import { pathToFileURL } from 'node:url';
import * as tabtab from '@pnpm/tabtab';
import type { JSONSchema7 } from 'json-schema';
import { parse as shellParse } from 'shell-quote';
import { camelToKebab } from '../loader/inputFlags.js';
import type { ArgFlagMeta, StaticCompletionKind } from '../loader/inputSchema.js';
import { cachePathsFor, hashSourceTree, readSerializedSidecarFromModule } from '../loader/cache.js';
import type { extractSchemaSidecar } from '../loader/sidecar.js';
import type { ArgSentinel } from '../state/args.js';
import { ROOT_SUBCOMMANDS } from './completionCommands.js';
import { readInstalledCompletionSnapshot } from '../installStore/completionSnapshot.js';
import {
  checkInstalledLockFingerprint,
  resolveInstalledCommand,
  type InstalledRuntimeSnapshot,
} from '../installStore/runtime.js';
import type { TrustedCommandIndexEntry } from '../installStore/types.js';

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
const FSM_TARGET_SUBCOMMANDS = new Set(['verify', 'visualize']);

interface InputCompletionMetadata {
  readonly schema: JSONSchema7;
  readonly flags: Record<string, ArgFlagMeta>;
  readonly fieldTypes: ReadonlyMap<string, string | undefined>;
  readonly fieldsByKebab: ReadonlyMap<string, string>;
  readonly cachedModulePath?: string;
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
  | { readonly kind: 'fsm-target'; readonly subcommand: string; readonly partial: string }
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
    if (context.kind === 'fsm-target') {
      const suggestions = new Set<string>();
      for (const candidate of enumerateLocalFsmTargets(context.partial, opts.cwd)) {
        suggestions.add(candidate);
      }
      const snapshot = await readInstalledCompletionSnapshot({ env: opts.env });
      for (const candidate of buildInstalledTargetSuggestions(
        snapshot,
        context.partial,
        opts.cwd,
      )) {
        suggestions.add(candidate);
      }
      for (const suggestion of suggestions) opts.stdout.write(`${suggestion}\n`);
      return { exitCode: 0 };
    }
    if (context.kind === 'other-subcommand') {
      return { exitCode: 0 };
    }

    const metadata = await extractInputCompletionMetadataForTarget(context.target, opts.cwd);
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
 * line for any later `.ts` token. Local FSM input completion is active through
 * `run <target.fsm.ts>` and `visualize <target>`; root direct-run forms are not
 * completion targets.
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

  if (FSM_TARGET_SUBCOMMANDS.has(firstToken)) {
    const fsmTarget = await deriveFsmTargetSubcommandCompletionContext(tokens, last, cwd, env);
    if (fsmTarget) return fsmTarget;
  }

  if (
    tokens.length === 2 &&
    last !== '' &&
    !firstToken.startsWith('-') &&
    !isPathLikeToken(firstToken)
  ) {
    return { kind: 'root', partial: firstToken };
  }

  return { kind: 'other-subcommand' };
}

async function deriveFsmTargetSubcommandCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CompletionContext | null> {
  const subcommand = tokens[1]!;
  const targetToken = tokens[2];
  if (!targetToken) {
    return last === '' ? { kind: 'fsm-target', subcommand, partial: '' } : null;
  }
  if (targetToken.startsWith('--')) return null;

  const cursorIsOnTarget = tokens.length === 3 && last === targetToken && last !== '';
  if (cursorIsOnTarget) {
    return { kind: 'fsm-target', subcommand, partial: targetToken };
  }

  if (subcommand === 'visualize') {
    const inputArgs = tokens.slice(3);
    if (!isValidInputCompletionTail(inputArgs)) return null;
    const target = await resolveCompletionInputTarget({ targetToken, cwd, env });
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

  let sawPermissionFlag = false;
  let sawNoOpen = false;
  while (true) {
    const flag = afterRun[targetIndex];
    if (isRuntimePermissionFlag(flag)) {
      if (sawPermissionFlag) return null;
      sawPermissionFlag = true;
      targetIndex++;
      continue;
    }
    if (flag === '--no-open') {
      if (sawNoOpen) return null;
      sawNoOpen = true;
      targetIndex++;
      continue;
    }
    break;
  }

  if (targetIndex === afterRun.length) {
    return last === '' ? { kind: 'fsm-target', subcommand: 'run', partial: '' } : null;
  }

  const targetToken = afterRun[targetIndex]!;
  if (targetToken.startsWith('--')) return null;

  const cursorIsOnTarget =
    targetIndex === afterRun.length - 1 && last === targetToken && last !== '';
  if (cursorIsOnTarget) return { kind: 'fsm-target', subcommand: 'run', partial: targetToken };

  const inputArgs = afterRun.slice(targetIndex + 1);
  if (!isValidInputCompletionTail(inputArgs)) return null;

  const target = await resolveCompletionInputTarget({ targetToken, cwd, env });
  if (target) return { kind: 'post-target-input', target, inputArgs };
  if (targetIndex === afterRun.length - 1) {
    return { kind: 'fsm-target', subcommand: 'run', partial: targetToken };
  }
  return null;
}

function isValidInputCompletionTail(inputArgs: ReadonlyArray<string>): boolean {
  for (let i = 0; i < inputArgs.length; i++) {
    const current = inputArgs[i]!;
    if (!current.startsWith('--')) return false;
    if (isRunRuntimeFlag(current)) return false;
    const next = inputArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) i++;
  }
  return true;
}

function isRuntimePermissionFlag(flag: string | undefined): flag is '--ask' | '--yolo' {
  return flag === '--ask' || flag === '--yolo';
}

function isRunRuntimeFlag(flag: string | undefined): flag is '--ask' | '--yolo' | '--no-open' {
  return flag === '--ask' || flag === '--yolo' || flag === '--no-open';
}

async function resolveCompletionInputTarget(args: {
  readonly targetToken: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CompletionInputTarget | null> {
  if (isLocalFsmTarget(args.targetToken)) {
    return { kind: 'local', filePath: path.resolve(args.cwd, args.targetToken) };
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

function isLocalFsmTarget(target: string): boolean {
  return target.endsWith('.fsm.ts') && !target.startsWith('-');
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

function enumerateLocalFsmTargets(partial: string, cwd: string): readonly string[] {
  const { dirPart, displayDir, prefix } = splitFsmTargetPartial(partial);
  const absDir = path.resolve(cwd, dirPart);
  const out: string[] = [];
  try {
    const dirents = fs.readdirSync(absDir, { withFileTypes: true });
    let matched = 0;
    for (const dirent of dirents) {
      if (!dirent.name.startsWith(prefix)) continue;
      if (!dirent.isDirectory() && !dirent.isFile()) continue;
      if (dirent.isFile() && !dirent.name.endsWith('.fsm.ts')) continue;
      out.push(`${displayDir}${dirent.name}${dirent.isDirectory() ? '/' : ''}`);
      if (++matched >= FILE_ENUMERATE_CAP) break;
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function splitFsmTargetPartial(partial: string): {
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

function buildInstalledTargetSuggestions(
  snapshot: InstalledRuntimeSnapshot,
  partial: string,
  cwd: string,
): readonly string[] {
  const commands = snapshot.commands.commands;
  const bareCounts = new Map<string, number>();
  const targetEntries = Object.entries(commands).filter(
    ([identity, entry]) => !isPackageOnlyInstalledIdentity(identity, entry),
  );
  for (const [, entry] of targetEntries) {
    bareCounts.set(entry.commandName, (bareCounts.get(entry.commandName) ?? 0) + 1);
  }

  const bare: InstalledSuggestion[] = [];
  const qualified: InstalledSuggestion[] = [];
  for (const [identity, entry] of targetEntries) {
    if ((bareCounts.get(entry.commandName) ?? 0) === 1) {
      bare.push(formatInstalledSuggestion(entry.commandName, entry));
    }
    qualified.push(formatInstalledSuggestion(identity, entry));
  }

  return [...bare.sort(byValue), ...qualified.sort(byValue)]
    .filter((suggestion) => matchesInstalledPartial(suggestion, partial))
    .filter(
      (suggestion) =>
        !hasLocalFsmTargetCollision(cwd, suggestion.value) &&
        !hasLocalFsmTargetCollision(cwd, suggestion.commandName),
    )
    .map((suggestion) => suggestion.output);
}

function isPackageOnlyInstalledIdentity(
  identity: string,
  entry: TrustedCommandIndexEntry,
): boolean {
  return identity === entry.packageName;
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

function hasLocalFsmTargetCollision(cwd: string, target: string): boolean {
  if (!isLocalFsmTarget(target)) return false;
  try {
    return fs.statSync(path.resolve(cwd, target)).isFile();
  } catch {
    return false;
  }
}

async function extractInputCompletionMetadataForTarget(
  target: CompletionInputTarget,
  cwd: string,
): Promise<InputCompletionMetadata> {
  if (target.kind === 'local') {
    const cached = await readLocalCachedInputCompletionMetadata(target.filePath, cwd);
    if (cached) return cached;

    const extraction = await extractSchemaSidecarForCompletion({ filePath: target.filePath });
    return buildInputCompletionMetadata(extraction.inputSchema, extraction.inputFlags);
  }

  const extraction = await extractSchemaSidecarForCompletion({
    filePath: target.entryFile,
    packageResolution: {
      packageRoot: target.packageRoot,
      managedProjectRoot: target.managedProjectRoot,
    },
  });
  return buildInputCompletionMetadata(extraction.inputSchema, extraction.inputFlags);
}

type ExtractSchemaSidecarOptions = Parameters<typeof extractSchemaSidecar>[0];

async function extractSchemaSidecarForCompletion(
  opts: ExtractSchemaSidecarOptions,
): ReturnType<typeof extractSchemaSidecar> {
  const { extractSchemaSidecar } = await import('../loader/sidecar.js');
  return extractSchemaSidecar(opts);
}

async function readLocalCachedInputCompletionMetadata(
  filePath: string,
  cwd: string,
): Promise<InputCompletionMetadata | null> {
  const hash = await hashSourceTree(path.dirname(filePath), filePath);
  for (const repoRoot of completionCacheRepoRoots(cwd)) {
    const cachePaths = cachePathsFor(repoRoot, hash);
    const cached = await readSerializedSidecarFromModule(cachePaths.modulePath);
    if (!cached?.inputSchema) continue;
    try {
      return buildInputCompletionMetadata(cached.inputSchema, cached.inputFlags, {
        cachedModulePath: cachePaths.modulePath,
      });
    } catch {
      continue;
    }
  }
  return null;
}

function completionCacheRepoRoots(cwd: string): readonly string[] {
  const roots = [cwd];
  const packageRoot = findRepoRoot(cwd);
  if (packageRoot && path.resolve(packageRoot) !== path.resolve(cwd)) roots.push(packageRoot);
  return roots;
}

function buildInputCompletionMetadata(
  schema: JSONSchema7 | undefined,
  flags: Record<string, ArgFlagMeta> | undefined,
  source?: { readonly cachedModulePath: string },
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
  return {
    schema,
    flags,
    fieldTypes,
    fieldsByKebab,
    ...(source ? { cachedModulePath: source.cachedModulePath } : {}),
  };
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
    const machine = await loadDynamicCompletionMachine(metadata, target, cwd);
    if (!machine) return;
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

async function loadDynamicCompletionMachine(
  metadata: InputCompletionMetadata,
  target: CompletionInputTarget,
  cwd: string,
): Promise<LoadedConfig | null> {
  if (target.kind === 'local' && metadata.cachedModulePath) {
    const cached = await importCachedCompletionMachine(metadata.cachedModulePath);
    if (cached) return cached;
  }

  try {
    if (target.kind === 'local') {
      const { loadFsm } = await import('../loader/index.js');
      const loaded = await loadFsm({
        filePath: target.filePath,
        repoRoot: findRepoRoot(cwd) ?? cwd,
      });
      return loaded.machine as unknown as LoadedConfig;
    }

    const { loadInstalledFsm } = await import('../loader/index.js');
    const loaded = await loadInstalledFsm({
      entryFile: target.entryFile,
      packageName: target.packageName,
      commandName: target.commandName,
      packageRoot: target.packageRoot,
      managedProjectRoot: target.managedProjectRoot,
      storeRoot: target.storeRoot,
      lockFingerprint: target.lockFingerprint,
    });
    return loaded.machine as unknown as LoadedConfig;
  } catch {
    return null;
  }
}

async function importCachedCompletionMachine(modulePath: string): Promise<LoadedConfig | null> {
  try {
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      readonly default?: unknown;
      readonly machine?: unknown;
    };
    const candidate = mod.default ?? mod.machine;
    if (!isLoadedConfig(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function isLoadedConfig(value: unknown): value is LoadedConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'config' in value &&
    typeof (value as { readonly config?: unknown }).config === 'object' &&
    (value as { readonly config?: unknown }).config !== null
  );
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
