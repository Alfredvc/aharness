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
 * escalates to full `loadFsm()`.
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
import { parse as shellParse } from 'shell-quote';
import { extractSchemaSidecar } from '../loader/sidecar.js';
import { camelToKebab, kebabToCamel } from '../loader/inputFlags.js';
import type { ArgFlagMeta, StaticCompletionKind } from '../loader/inputSchema.js';
import { loadFsm } from '../loader/index.js';
import type { ArgSentinel } from '../state/args.js';
import {
  readInstalledCompletionSnapshot,
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
 * in `emitValueCompletion` escalates into `loadFsm()` to recover the live
 * callback — that is the only path that runs user module code at Tab time.
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

type FlagsMap = Record<string, ArgFlagMeta | undefined>;

type CompletionInputTarget = { readonly kind: 'local'; readonly filePath: string };

type CompletionContext =
  | { readonly kind: 'root'; readonly partial: string }
  | { readonly kind: 'run-target'; readonly partial: string }
  | { readonly kind: 'direct-file-target' }
  | { readonly kind: 'post-target-input'; readonly target: CompletionInputTarget }
  | { readonly kind: 'other-subcommand' };

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
    const context = deriveCompletionContext(tokens, parsed.last, opts.cwd);
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
      const firstToken = tokens[1];
      if (firstToken && FILE_PATH_SUBCOMMANDS.has(firstToken) && parsed.last === '') {
        emitNativeFileCompletion(opts.stdout);
      }
      return { exitCode: 0 };
    }

    const fsmPath = context.target.filePath;
    const extraction = await extractSchemaSidecar({ filePath: fsmPath });
    const flags: FlagsMap = extraction.inputFlags ?? {};
    const flagNames = Object.keys(flags);

    const last = parsed.last;
    const prev = parsed.prev;
    const prevIsFlag = typeof prev === 'string' && prev.startsWith('--');
    const lastIsFlagPartial = last.startsWith('--') || last === '';

    // Cursor on a flag value (cursor token non-empty, prev was a flag).
    if (prevIsFlag && last !== '' && !last.startsWith('--')) {
      await emitValueCompletion(flags, prev, last, fsmPath, opts.cwd, opts.stdout);
      return { exitCode: 0 };
    }
    // Cursor on the empty value slot immediately after a flag name.
    if (prevIsFlag && last === '' && lookupFlagByKebab(flags, prev)) {
      await emitValueCompletion(flags, prev, '', fsmPath, opts.cwd, opts.stdout);
      return { exitCode: 0 };
    }
    // Flag-name completion. Renders `--<kebab-name>` per matching field;
    // if the field declares `meta.description`, append `:description` so
    // tabtab-aware shells (zsh, fish) render a per-suggestion hint.
    if (lastIsFlagPartial) {
      const partial = last;
      for (const fld of flagNames) {
        const kebab = `--${camelToKebab(fld)}`;
        if (kebab.startsWith(partial)) {
          const meta = flags[fld];
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
function deriveCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
  cwd: string,
): CompletionContext {
  const firstToken = tokens[1];
  if (!firstToken) return { kind: 'root', partial: '' };

  if (firstToken === 'run') {
    const runTarget = deriveRunTargetCompletionContext(tokens, last);
    if (runTarget) return runTarget;
  }

  if (tokens.length === 2 && last !== '') {
    if (isPathLikeToken(firstToken)) {
      const target = resolveLocalInputTarget(firstToken, cwd);
      return target ? { kind: 'post-target-input', target } : { kind: 'direct-file-target' };
    }
    return { kind: 'root', partial: firstToken };
  }

  if (isPathLikeToken(firstToken)) {
    const target = resolveLocalInputTarget(firstToken, cwd);
    return target ? { kind: 'post-target-input', target } : { kind: 'direct-file-target' };
  }

  return { kind: 'other-subcommand' };
}

function deriveRunTargetCompletionContext(
  tokens: ReadonlyArray<string>,
  last: string,
): CompletionContext | null {
  const afterRun = tokens.slice(2);
  if (afterRun.length === 0) {
    return last === '' ? { kind: 'run-target', partial: '' } : null;
  }

  const positional = afterRun.filter((token) => !token.startsWith('--'));
  const partial = positional.at(-1);
  if (partial !== undefined) return { kind: 'run-target', partial };
  if (last === '') return { kind: 'run-target', partial: '' };
  return null;
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

/**
 * Map a `--<kebab-name>` flag back to its declared field name and look
 * up its meta. Returns undefined when the flag name does not resolve to
 * a declared input field.
 */
function lookupFlagByKebab(flags: FlagsMap, kebabFlag: string): ArgFlagMeta | undefined {
  const camel = kebabToCamel(kebabFlag.replace(/^--/, ''));
  return flags[camel];
}

/**
 * Dispatch on a flag's `completion` static kind. `'file'` delegates to native
 * shell file completion, `'directory'` enumerates directories locally,
 * `{values: [...]}` emits prefix matches;
 * `{dynamic: true}` escalates to `loadFsm()` so the live callback (which
 * the JSON sidecar reduces to a `{dynamic: true}` sentinel) can be
 * resolved off `machine.config.input?.[field]?.meta?.completion?.dynamic`
 * and invoked.
 *
 * Spec §5.7 risk: the dynamic-callback path executes user module code at
 * Tab time. Phase 5 docs surface this; no inline mitigation here.
 */
async function emitValueCompletion(
  flags: FlagsMap,
  kebabFlag: string,
  partial: string,
  fsmPath: string,
  cwd: string,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  const meta = lookupFlagByKebab(flags, kebabFlag);
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
    const repoRoot = findRepoRoot(cwd) ?? cwd;
    let loaded;
    try {
      loaded = await loadFsm({ filePath: fsmPath, repoRoot });
    } catch {
      return;
    }
    const machine = loaded.machine as unknown as LoadedConfig;
    const field = kebabToCamel(kebabFlag.replace(/^--/, ''));
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
    try {
      out = dyn.dynamic(partial, { fsmFile: fsmPath, cwd });
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
