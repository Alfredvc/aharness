/**
 * `aharness run <file>.fsm.ts` CLI adapter.
 *
 * The live-run boot sequence lives in `runtime/liveRunEngine.ts`. This module
 * keeps CLI-only behavior: terminal restore, CLI input flag parsing and
 * diagnostics, stdout status text, production browser defaults, signal/process
 * exit behavior, and the test-facing external-boundary hook surface.
 */
import { execFile } from 'node:child_process';
import { basename, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { JSONSchema7 } from 'json-schema';

import {
  spawnAppServer as realSpawnAppServer,
  type AppServerHandle,
  type SpawnAppServerOptions,
} from '../appServer/index.js';
import { checkCodexVersion, type VersionGateResult } from '../appServer/version.js';
import { resolveCodexAuthFile } from '../codexHome/index.js';
import { loadFsm } from '../loader/index.js';
import { camelToKebab, parseInputFlags } from '../loader/inputFlags.js';
import type { ArgFlagMeta } from '../loader/inputSchema.js';
import type { GitFactSyncExec, RunEventRecorder } from '../runEvents/index.js';
import type { ActiveThreadBinding } from '../runtime/activeThreadBinding.js';
import {
  runLiveRunEngine,
  type LiveRunAuthPrecheckResult,
  type LiveRunInputResult,
  type LiveRunLoadedFsm,
  type LiveRunPermissionMode,
  type LiveRunReporter,
} from '../runtime/liveRunEngine.js';
import { applyRunInputDefaults } from '../runtime/runInput.js';
import { connectHeadlessWs } from '../transport/wsClient.js';
import { launchBrowser } from '../ui/browserLauncher.js';
import type { ReplayableAppEvent } from '../ui/events.js';
import { startUiServer } from '../ui/server.js';

import type { OwnerInputProvider } from './ownerInputProvider.js';
import { emitReservedFlagWarnings } from './reservedFlags.js';
import { startSignalHandlers } from './signals.js';
import { runVerifyCli } from './verifyCli.js';

const exec = promisify(execFile);

const LIVE_UI_CLOSEOUT_GRACE_MS = 10_000;

export type RunPermissionMode = LiveRunPermissionMode;

const MAX_STDOUT_FAILURE_REASON_LENGTH = 160;

function stdoutFailureReason(message: string): string {
  const retainedLines: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (/^\s*(?:child\s+)?stderr\s*:/i.test(line)) break;
    if (/^\s+at\s/.test(line)) continue;
    retainedLines.push(line);
  }
  const withoutStackFrames = retainedLines.join(' ');
  const normalized = withoutStackFrames.replace(/\s+/g, ' ').trim();
  const reason = normalized.length > 0 ? normalized : 'unknown failure';
  if (reason.length <= MAX_STDOUT_FAILURE_REASON_LENGTH) return reason;
  return `${reason.slice(0, MAX_STDOUT_FAILURE_REASON_LENGTH - 3)}...`;
}

function createLiveStdoutReporter(
  stdout: NodeJS.WritableStream,
  runTargetLabel: string,
  runRoot: string,
): LiveRunReporter {
  let finalSummaryPrinted = false;
  const writeLine = (line: string): void => {
    stdout.write(`${line}\n`);
  };
  const writeFinalSummary = (line: string): void => {
    if (finalSummaryPrinted) return;
    finalSummaryPrinted = true;
    writeLine(line);
  };

  return {
    runStarting: ({ runId, runRoot }) => {
      writeLine(`aharness: run ${runId} starting ${runTargetLabel} dir=${runRoot}`);
    },
    browserReady: ({ url }) => {
      writeLine(`aharness: browser UI available at ${url}`);
    },
    codexLaunching: () => {
      writeLine('aharness: codex launching');
    },
    codexReady: ({ threadId, state }) => {
      writeLine(`aharness: codex ready thread=${threadId} state=${state}`);
    },
    transition: ({ from, exit, to }) => {
      writeLine(`aharness: transition ${from} --${exit}--> ${to}`);
    },
    completed: ({ state, terminal }) => {
      writeFinalSummary(
        `aharness: run completed state=${state} terminal=${terminal} dir=${runRoot}`,
      );
    },
    failed: ({ state, reason }) => {
      writeFinalSummary(
        `aharness: run failed${state !== undefined ? ` state=${state}` : ''} reason=${stdoutFailureReason(reason)} dir=${runRoot}`,
      );
    },
  };
}

export interface RunCliOpts {
  /** Path to the user's `<file>.fsm.ts`, absolute or relative to `cwd`. */
  readonly fsmPath: string;
  /** Project root used to resolve `fsmPath` and to host `.aharness/runs/…`. */
  readonly cwd: string;
  /** Sink for diagnostic lines (verifier output, fatal messages). */
  readonly stderr: NodeJS.WritableStream;
  /** Sink for minimal operator status lines for live runs. */
  readonly stdout: NodeJS.WritableStream;
  /**
   * Forwarded from the dispatcher: unknown `--<flag>` tokens collected
   * verbatim (kebab-case names + their values, in source order). Parsed
   * against the loaded FSM's `inputFlags` after `loadFsm`.
   */
  readonly inputArgs?: ReadonlyArray<string>;
  /** Runtime permission behavior for Codex approval handling. */
  readonly permissionMode?: RunPermissionMode;
  /** Suppress opening the browser window after the run UI server starts. */
  readonly noOpen?: boolean;
  /** Command prefix shown in input-flag diagnostics, excluding input flags. */
  readonly inputUsageCommand?: string;
  /** @internal Display-only target label used by installed command wrappers. */
  readonly runTargetLabel?: string;
}

export interface RunCliResult {
  readonly exitCode: number;
}

/**
 * Production-supported runtime overrides for trusted wrappers that need to
 * adapt the source of an FSM without duplicating the run boot sequence.
 */
export interface RunCliRuntimeOverrides {
  /**
   * Override direct FSM verification when the caller has already established
   * source trust, such as an installed command validated against its lock.
   */
  readonly verify?: (o: { fsmPath: string; repoRoot: string }) => Promise<{ exitCode: number }>;
  /**
   * Load an FSM through an alternate trusted source while preserving the
   * production run lifecycle.
   */
  readonly loadFsmImpl?: typeof loadFsm;
}

export type RunCliRuntimeOpts = RunCliOpts & RunCliRuntimeOverrides;

/**
 * Production entrypoint. Forwards to `runCliForTest` with production browser
 * defaults and any production-supported runtime overrides; unset
 * external-boundary hooks inside `runCliForTest` still wire each step to its
 * real implementation.
 */
export function runCli(o: RunCliRuntimeOpts): Promise<RunCliResult> {
  return runCliForTest({
    ...o,
    launchBrowserImpl: launchBrowser,
    _testLiveUiCloseoutGraceMs: LIVE_UI_CLOSEOUT_GRACE_MS,
  });
}

// ---------------------------------------------------------------------------
// Test seam.
// ---------------------------------------------------------------------------

/**
 * Test-facing hook set. It extends the production runtime override contract
 * so existing tests can reuse those fields; fields declared below are
 * test-only external-boundary seams.
 */
export interface RunCliTestHooks extends RunCliRuntimeOverrides {
  readonly versionGate?: () => Promise<VersionGateResult>;
  readonly spawnAppServer?: (opts: SpawnAppServerOptions) => Promise<AppServerHandle>;
  /** Test seam: override the auth.json existence check. */
  readonly authJsonExists?: () => boolean;
  /**
   * Test seam: substitute the WS connector. Lets a test simulate the
   * codex-side replay race (CF-22) without standing up an actual
   * app-server, by returning a `JsonRpcClient` wired to an in-process
   * transport. Production callers leave this unset.
   */
  readonly connectHeadlessWsImpl?: typeof connectHeadlessWs;
  /**
   * Phase 3a test seam: substitute the loopback UI server starter so
   * runCli lifecycle tests can observe ordering and cleanup without
   * binding a real port.
   */
  readonly startUiServerImpl?: typeof startUiServer;
  /**
   * Phase 3d test seam: substitute browser launch so boot-order tests
   * can observe best-effort launch timing without opening a real browser.
   */
  readonly launchBrowserImpl?: typeof launchBrowser;
  /**
   * Phase 3a test seam: observe events published into the run UI event
   * log. Production callers leave this unset.
   */
  readonly _testOnUiEvent?: (event: ReplayableAppEvent) => void;
  /**
   * Slice 1 test seam: inject a deterministic canonical run-event recorder
   * for append-failure and sequence-order tests. Production callers leave
   * this unset and use the shared per-run recorder.
   */
  readonly _testRunEventRecorder?: RunEventRecorder;
  /**
   * Slice 0 test seam: inject deterministic no-shell synchronous git probing
   * for canonical git fact ordering tests. Production uses execFileSync.
   */
  readonly _testGitFactSyncExec?: GitFactSyncExec;
  /**
   * Test seam: override the live-run UI closeout grace. Production
   * `runCli` passes `LIVE_UI_CLOSEOUT_GRACE_MS`; tests default to no
   * delay unless they opt into this behavior.
   */
  readonly _testLiveUiCloseoutGraceMs?: number;
  /**
   * Test seam for Slice 2 active-thread binding. Lets tests simulate a
   * future replacement-thread swap without enabling fresh-clear behavior.
   */
  readonly _testOnActiveThreadBinding?: (binding: ActiveThreadBinding) => void;
  /**
   * Test-only: when set, codex's model traffic is routed through a mock
   * `responses` provider whose base URL is this string. Mirrors the
   * `AHARNESS_MOCK_MODEL_BASE_URL` env var; the env var takes priority
   * over the option when both are present.
   */
  readonly _testMockModelBaseUrl?: string;
  /**
   * Owner-input provider test seam. Production callers leave this unset
   * and use the run-scoped browser reply path via `createBrowserOwnerInputProvider()`;
   * tests pass a `MockOwnerInputProvider` (or a stub) so the
   * `item/tool/requestUserInput` ServerRequest handler is observable
   * without a browser round trip.
   */
  readonly ownerInputProvider?: OwnerInputProvider;
  /**
   * Test seam: when set, the wrapper around
   * `pendingOwnerInputRequestCount > 0`
   * (the `isAwaiting` predicate fed to `createDriveForward`) invokes
   * this callback with the predicate's return value on every read. The
   * count-ordering test pins the contract this seam carries: a caller
   * that reads `isAwaiting()` sees `count > 0` while an owner-input
   * request is parked.
   */
  readonly _testObserveIsAwaiting?: (value: boolean) => void;
  /**
   * Test seam: when set, `runCliForTest` invokes this once during boot
   * and passes a getter that returns the current
   * `pendingOwnerInputRequestCount` value. The test stores the getter and
   * polls it across the run to observe in-flight count transitions.
   * Production callers leave this unset.
   */
  readonly _testReadPendingOwnerInputRequestCount?: (read: () => number) => void;
}

export type RunCliForTestOpts = RunCliRuntimeOpts & RunCliTestHooks;

/**
 * Test-facing adapter over the shared live-run engine. The type preserves
 * existing test-only hooks while the engine receives normalized runtime
 * inputs instead of CLI argv shape.
 */
export async function runCliForTest(o: RunCliForTestOpts): Promise<RunCliResult> {
  installTerminalRestore();

  const fsmAbs = resolve(o.cwd, o.fsmPath);
  const engineResult = await runLiveRunEngine({
    target: {
      filePath: fsmAbs,
      repoRoot: o.cwd,
    },
    verify: o.verify ?? defaultVerify,
    versionGate: o.versionGate ?? defaultVersionGate,
    loadFsm: o.loadFsmImpl ?? loadFsm,
    authPrecheck: () => runCliAuthPrecheck(o),
    resolveInput: (loaded) => resolveCliRunInput(o, loaded),
    ...(o.permissionMode !== undefined ? { permissionMode: o.permissionMode } : {}),
    ui: {
      serve: true,
      openBrowser: !o.noOpen,
      closeoutGraceMs: o._testLiveUiCloseoutGraceMs ?? 0,
    },
    diagnostics: o.stderr,
    createReporter: ({ runRoot }) =>
      createLiveStdoutReporter(o.stdout, o.runTargetLabel ?? o.fsmPath, runRoot),
    spawnAppServer: o.spawnAppServer ?? realSpawnAppServer,
    connectHeadlessWs: o.connectHeadlessWsImpl ?? connectHeadlessWs,
    startUiServer: o.startUiServerImpl ?? startUiServer,
    ...(o.launchBrowserImpl !== undefined ? { launchBrowser: o.launchBrowserImpl } : {}),
    ...(o._testOnUiEvent !== undefined ? { onUiEvent: o._testOnUiEvent } : {}),
    ...(o._testRunEventRecorder !== undefined ? { runEventRecorder: o._testRunEventRecorder } : {}),
    ...(o._testGitFactSyncExec !== undefined ? { gitFactSyncExec: o._testGitFactSyncExec } : {}),
    ...(o._testOnActiveThreadBinding !== undefined
      ? { onActiveThreadBinding: o._testOnActiveThreadBinding }
      : {}),
    ...(o._testMockModelBaseUrl !== undefined ? { mockModelBaseUrl: o._testMockModelBaseUrl } : {}),
    ...(o.ownerInputProvider !== undefined ? { ownerInputProvider: o.ownerInputProvider } : {}),
    ...(o._testObserveIsAwaiting !== undefined
      ? { observeIsAwaiting: o._testObserveIsAwaiting }
      : {}),
    ...(o._testReadPendingOwnerInputRequestCount !== undefined
      ? { readPendingOwnerInputRequestCount: o._testReadPendingOwnerInputRequestCount }
      : {}),
    startSignalHandlers,
    exitProcess: (code) => {
      process.exit(code);
    },
  });

  return { exitCode: engineResult.exitCode };
}

function runCliAuthPrecheck(o: RunCliForTestOpts): LiveRunAuthPrecheckResult {
  if (o.authJsonExists !== undefined) {
    if (o.authJsonExists()) return { ok: true };
    const message = '~/.codex/auth.json not found. Run `codex login` first.';
    return {
      ok: false,
      diagnostic: `aharness: ${message}\n`,
      failureReason: message,
      exitCode: 1,
    };
  }

  const auth = resolveCodexAuthFile({ cwd: o.cwd });
  if (auth.ok) return { ok: true };
  return {
    ok: false,
    diagnostic: auth.message,
    failureReason: auth.message,
    exitCode: 1,
  };
}

function resolveCliRunInput(o: RunCliForTestOpts, loaded: LiveRunLoadedFsm): LiveRunInputResult {
  emitReservedFlagWarnings(loaded.inputFlags, o.stderr);
  const userInputArgs = o.inputArgs ?? [];

  if (loaded.inputSchema && loaded.inputFlags) {
    const parsed = parseInputFlags({
      args: userInputArgs,
      schema: loaded.inputSchema,
      flags: loaded.inputFlags,
    });
    if (!parsed.ok) {
      const message = formatInputFlagError({
        errors: parsed.errors,
        fsmPath: o.fsmPath,
        schema: loaded.inputSchema,
        flags: loaded.inputFlags,
        ...(o.inputUsageCommand !== undefined ? { inputUsageCommand: o.inputUsageCommand } : {}),
      });
      return {
        ok: false,
        diagnostic: message,
        failureReason: message,
        exitCode: 2,
      };
    }
    return { ok: true, input: applyRunInputDefaults(parsed.values, loaded.inputFlags) };
  }

  if (userInputArgs.length > 0) {
    const unknownFlags = userInputArgs.filter((a) => a.startsWith('--')).join(' ');
    const message = `FSM declares no input fields; unknown flags: ${unknownFlags}`;
    return {
      ok: false,
      diagnostic: `aharness: ${message}\n`,
      failureReason: message,
      exitCode: 2,
    };
  }

  return { ok: true };
}

function formatInputFlagError(o: {
  readonly errors: ReadonlyArray<string>;
  readonly fsmPath: string;
  readonly inputUsageCommand?: string;
  readonly schema: JSONSchema7;
  readonly flags: Record<string, ArgFlagMeta>;
}): string {
  const required = new Set(o.schema.required ?? []);
  const lines = [`aharness: invalid input flags:`, ...o.errors.map((e) => `  ${e}`)];
  const requiredFields = Object.keys(o.flags).filter((field) => required.has(field));

  if (requiredFields.length > 0) {
    lines.push('', 'Required input flags:');
    for (const field of requiredFields) {
      lines.push(`  ${formatFlagUsage(field, o.schema, o.flags[field])}`);
    }
    lines.push(
      '',
      `Example: ${o.inputUsageCommand ?? defaultInputUsageCommand(o.fsmPath)} ${requiredFields
        .map((field) => formatExampleFlag(field, o.schema))
        .join(' ')}`,
    );
  }

  return lines.join('\n') + '\n';
}

function formatFlagUsage(
  field: string,
  schema: JSONSchema7,
  meta: ArgFlagMeta | undefined,
): string {
  const usage = formatExampleFlag(field, schema);
  return meta?.description ? `${usage}  ${meta.description}` : usage;
}

function formatExampleFlag(field: string, schema: JSONSchema7): string {
  const name = `--${camelToKebab(field)}`;
  const type = inputFlagTypeName(schema, field);
  return type === 'boolean' ? name : `${name} <${type}>`;
}

function inputFlagTypeName(schema: JSONSchema7, field: string): string {
  const fieldSchema = (schema.properties?.[field] ?? {}) as JSONSchema7;
  if (fieldSchema.type === 'string') return 'string';
  if (fieldSchema.type === 'number') return 'number';
  if (fieldSchema.type === 'integer') return 'integer';
  if (fieldSchema.type === 'boolean') return 'boolean';
  return 'value';
}

function defaultInputUsageCommand(fsmPath: string): string {
  return `aharness run ${displayFsmPath(fsmPath)}`;
}

function displayFsmPath(fsmPath: string): string {
  return isAbsolute(fsmPath) ? basename(fsmPath) : fsmPath;
}

async function defaultVerify(o: {
  fsmPath: string;
  repoRoot: string;
}): Promise<{ exitCode: number }> {
  const r = await runVerifyCli({
    fsmPath: o.fsmPath,
    repoRoot: o.repoRoot,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  return { exitCode: r.exitCode };
}

async function defaultVersionGate(): Promise<VersionGateResult> {
  try {
    return await checkCodexVersion(async (cmd, args) => {
      const r = await exec(cmd, args.slice());
      return { stdout: r.stdout, status: 0 };
    });
  } catch {
    return { ok: false, found: null, required: 'unknown', message: '`codex` not on PATH' };
  }
}

let terminalRestoreInstalled = false;
/**
 * Register a one-shot `process.on('exit')` handler that restores the
 * user's terminal mode. Idempotent across calls. Phase 1 does not spawn
 * a TUI, so the surface that pushes the kitty keyboard stack is
 * narrower than the prior multi-process design — but Phase 2 may
 * re-introduce it, and a buggy mid-Phase-1 child that leaves the
 * terminal in a weird state should still see this cleanup.
 */
function installTerminalRestore(): void {
  if (terminalRestoreInstalled) return;
  terminalRestoreInstalled = true;
  process.on('exit', () => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(
      '\x1b[<u' +
        '\x1b[=0u' +
        '\x1b[?2004l' +
        '\x1b[?1006l' +
        '\x1b[?1003l' +
        '\x1b[?1002l' +
        '\x1b[?1000l' +
        '\x1b[?1004l' +
        '\x1b[?25h' +
        '\x1b[?1049l',
    );
  });
}
