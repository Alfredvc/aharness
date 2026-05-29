/**
 * `aharness <file>.fsm.ts` — headless foreground CLI boot sequence.
 *
 * Spec §3 (boot sequence), §4.1, §4.2, §4.3.1, §4.3.2, §5.1, §5.6, §5.7.
 *
 * Single-process boot: no daemon child, no MCP server child, no `codex
 * --remote` TUI. The aharness CLI is the sole WS subscriber to its codex
 * `app-server`. The actor, the submit dispatcher, the drive-forward
 * listener, and the browser UI all run inside this process.
 *
 *   1. Verify the FSM (`runVerifyCli`).
 *   2. Version-gate `codex`.
 *   3. Resolve runDir: mint and create a fresh `runId`.
 *   4. Load the FSM via `loadFsm({filePath, repoRoot})`.
 *   5. Auth precheck: `~/.codex/auth.json` must exist.
 *   6. Parse `--<flag>` tokens against `inputFlags`; reserved-flag
 *      warnings; resolve to `Record<string, unknown>`.
 *   7. Discover declared per-state hook kinds and materialize wrappers
 *      only when at least one supported kind is declared.
 *   8. Construct `ActorHost` and the submit dispatcher BEFORE WS connect.
 *   9. Spawn the codex app-server (Unix listen) with `hooks.<Kind>`
 *      SessionFlags overrides for declared hook kinds.
 *  10. Connect WS via `connectHeadlessWs` — register the `item/tool/call`
 *      dispatcher inside `registerHandlers` (M18 invariant — handler
 *      registered synchronously before `initialize`).
 *  11. `thread/start({dynamicTools})`, then start the per-run hook UDS
 *      when hooks are declared.
 *  12. Wire notification router + drive-forward + agent-message stream.
 *  13. Inject the first-state nudge as a `turn/start`
 *      kickoff message.
 *  14. Block on terminal-reached or SIGINT/SIGTERM.
 *
 * Test seam: `runCliForTest` accepts injectable factories for verify,
 * the version gate, `loadFsm`, app-server spawn, and the auth precheck.
 * Production callers go through the public `runCli`, which forwards
 * with hooks unset and the defaults wired to the real implementations.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { JSONSchema7 } from 'json-schema';

import {
  spawnAppServer as realSpawnAppServer,
  type AppServerHandle,
  type SpawnAppServerOptions,
} from '../appServer/index.js';
import { checkCodexVersion, type VersionGateResult } from '../appServer/version.js';
import {
  escapeTomlBasicString,
  KIND_TO_SCRIPT_NAME,
  materializeHookScripts,
  renderHookCliOverride,
  resolveCodexAuthFile,
} from '../codexHome/index.js';
import { ActorHost } from '../runtime/actorHost.js';
import { composeStateNudge, type ExitSpec } from '../runtime/nudge.js';
import { resolveEntryPrompt } from '../runtime/resolvePrompt.js';
import {
  createPerStateHookDispatcher,
  type CanonicalBuiltinEventErrorInfo,
} from '../runtime/hookDispatchers.js';
import { createPermissionRequestDispatcher } from '../runtime/permissionRequest.js';
import {
  startHookSocket,
  type HookDispatchByType,
  type HookSocketHandle,
} from '../runtime/hookSocket.js';
import { JsonRpcClient, type ServerRequestMeta } from '../jsonrpc/client.js';
import { loadFsm } from '../loader/index.js';
import { camelToKebab, parseInputFlags } from '../loader/inputFlags.js';
import type { ArgFlagMeta } from '../loader/inputSchema.js';
import { METHOD } from '../protocol/methodNames.js';
import { SUBMIT_TOOL_NAME } from '../protocol/submitTool.js';
import { DAEMON_PROBE_CLIENT_NAME } from '../protocol/types.js';
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  RequestUserInputQuestion,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnStartParams,
} from '../protocol/types.js';
import { deriveRunId, ensureRunDir } from '../run.js';
import { writeArtifact } from '../artifact.js';
import { appendEventEntry } from '../events.js';
import { buildDynamicToolsRegistration } from '../transport/dynamicToolsRegistration.js';
import { createApprovalDispatcher } from '../transport/approvalDispatch.js';
import { createItemCompletedWatcherRegistry } from '../transport/itemCompletedWatcher.js';
import { startNotificationRouter } from '../transport/notificationRouter.js';
import { connectHeadlessWs } from '../transport/wsClient.js';
import { createAwaitResolver, type AwaitResolver } from '../runtime/awaitResolver.js';
import {
  createActiveThreadBinding,
  type ActiveThreadBinding,
} from '../runtime/activeThreadBinding.js';
import {
  buildAbandonedDynamicToolCallResponse,
  buildAbandonedToolRequestUserInputResponse,
} from '../runtime/abandonedThreadResponses.js';
import { createDriveForward, type DriveForwardHandle } from '../runtime/driveForward.js';
import { createSubmitDispatcher } from '../runtime/dispatchSubmit.js';
import { makeSerializeDispatch } from '../runtime/serializeDispatch.js';
import { scheduleCrossStateDance } from '../runtime/crossStateDance.js';
import { PHASE1_OPT_OUT_METHODS } from '../runtime/optOutNotificationMethods.js';
import { performFreshClear } from '../runtime/freshClear.js';
import { resolveClearOnEntryCwd } from '../runtime/clearOnEntryCwd.js';
import { flushHeadlessSnapshotEnvelope } from '../runtime/snapshotEnvelope.js';
import { discoverDeclaredHookKinds } from '../state/discoverHooks.js';
import {
  payloadWithCanonicalCommit,
  prepareCanonicalAwaitCommit,
} from '../state/canonicalTransition.js';
import { createAharnessOps, type AharnessOps } from '../state/aharnessOps.js';
import type { ClearOnEntryMeta } from '../state/exits.js';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import type { HookKind } from '../state/hooks.js';
import type { RunCtx, SchemaSidecar } from '../types.js';
import type { AppEvent, FsmState, Posture, ReplayableAppEvent, RunMeta } from '../ui/events.js';
import { launchBrowser } from '../ui/browserLauncher.js';
import { createBrowserReplyController, type BrowserReplyController } from '../ui/reply.js';
import { createUiEventLog } from '../ui/sse.js';
import { startUiServer, type UiServerHandle } from '../ui/server.js';
import { extractUiTopology } from '../ui/topology.js';

import { DECLINED_ANSWER_TEXT, type OwnerInputProvider } from './ownerInputProvider.js';
import { emitReservedFlagWarnings } from './reservedFlags.js';
import { runShutdown } from './shutdown.js';
import { startSignalHandlers } from './signals.js';
import { runVerifyCli } from './verifyCli.js';

const exec = promisify(execFile);

const SIGINT_EXIT_CODE = 130;

export interface RunCliOpts {
  /** Path to the user's `<file>.fsm.ts`, absolute or relative to `cwd`. */
  readonly fsmPath: string;
  /** Project root used to resolve `fsmPath` and to host `.aharness/runs/…`. */
  readonly cwd: string;
  /** Sink for diagnostic lines (verifier output, fatal messages). */
  readonly stderr: NodeJS.WritableStream;
  /** Sink for the agent-message stream and per-transition log. */
  readonly stdout: NodeJS.WritableStream;
  /**
   * Forwarded from the dispatcher: unknown `--<flag>` tokens collected
   * verbatim (kebab-case names + their values, in source order). Parsed
   * against the loaded FSM's `inputFlags` after `loadFsm`.
   */
  readonly inputArgs?: ReadonlyArray<string>;
}

export interface RunCliResult {
  readonly exitCode: number;
}

/**
 * Production entrypoint. Forwards to `runCliForTest` with test hooks
 * unset; defaults inside `runCliForTest` wire each step to its real
 * implementation.
 */
export function runCli(o: RunCliOpts): Promise<RunCliResult> {
  return runCliForTest({ ...o, launchBrowserImpl: launchBrowser });
}

// ---------------------------------------------------------------------------
// Test seam.
// ---------------------------------------------------------------------------

export interface RunCliTestHooks {
  readonly verify?: (o: { fsmPath: string; repoRoot: string }) => Promise<{ exitCode: number }>;
  readonly versionGate?: () => Promise<VersionGateResult>;
  readonly spawnAppServer?: (opts: SpawnAppServerOptions) => Promise<AppServerHandle>;
  /** Test seam: override the auth.json existence check. */
  readonly authJsonExists?: () => boolean;
  /**
   * Test seam: substitute the FSM loader so a stub fsm file can bypass
   * esbuild compilation. Production callers leave this unset.
   */
  readonly loadFsmImpl?: typeof loadFsm;
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
   * Owner-yield provider test seam. Production callers leave this unset
   * and use the browser `/api/reply` path via `createBrowserOwnerInputProvider()`;
   * tests pass a `MockOwnerInputProvider` (or a stub) so the
   * `item/tool/requestUserInput` ServerRequest handler is observable
   * without a browser round trip.
   */
  readonly ownerInputProvider?: OwnerInputProvider;
  /**
   * Test seam: when set, the wrapper around `pendingOwnerYieldCount > 0`
   * (the `isAwaiting` predicate fed to `createDriveForward`) invokes
   * this callback with the predicate's return value on every read. The
   * "count-ordering" Task 3 test pins the contract this seam carries:
   * a Phase-2c+ caller (drive-forward post-Task-5) that reads
   * `isAwaiting()` sees `count > 0` while a request is parked.
   */
  readonly _testObserveIsAwaiting?: (value: boolean) => void;
  /**
   * Test seam: when set, `runCliForTest` invokes this once during boot
   * and passes a getter that returns the current
   * `pendingOwnerYieldCount` value. The test stores the getter and
   * polls it across the run to observe in-flight count transitions.
   * Required pre-Task-5 because drive-forward's `isAwaiting` throw
   * blocks the `_testObserveIsAwaiting` seam from firing while a
   * request is actually parked. Production callers leave this unset.
   */
  readonly _testReadPendingOwnerYieldCount?: (read: () => number) => void;
  /**
   * Test seam: when set, the wrapper around `flushHeadlessSnapshotEnvelope`
   * (the per-transition snapshot flush fed to the submit dispatcher
   * AND the await resolver's `onAfterTransition`) invokes this
   * callback with the current xstate snapshot AFTER the production
   * flush completes. The "await-exit walk" integration test reads
   * `(xstate as {value: string}).value` to assemble the post-AWAIT__
   * state sequence. Production callers leave this unset.
   */
  readonly _testOnSnapshotFlush?: (xstate: unknown) => void;
}

export type RunCliForTestOpts = RunCliOpts & RunCliTestHooks;

/**
 * Test-facing entrypoint. Identical body to `runCli`; the only
 * difference is the input type carries the `RunCliTestHooks` fields,
 * letting tests stub each external boundary without touching the
 * `node:child_process` surface or the real `codex` binary.
 */
export async function runCliForTest(o: RunCliForTestOpts): Promise<RunCliResult> {
  installTerminalRestore();

  // 1. Verify.
  const v = await (o.verify ?? defaultVerify)({ fsmPath: o.fsmPath, repoRoot: o.cwd });
  if (v.exitCode !== 0) return { exitCode: v.exitCode };

  // 2. Version-gate codex.
  const ver = await (o.versionGate ?? defaultVersionGate)();
  if (!ver.ok) {
    o.stderr.write(`aharness: ${ver.message ?? 'codex version check failed'}\n`);
    return { exitCode: 2 };
  }

  // 3. Resolve runDir. Every invocation mints a fresh `runId` so prior
  //    snapshots remain inspectable artifacts but are never consumed as
  //    startup continuation state.
  const fsmAbs = resolve(o.cwd, o.fsmPath);
  const repoRoot = o.cwd;
  const runId = deriveRunId(fsmAbs);
  const finalRunDir = ensureRunDir(runId, repoRoot);

  // 4. Load FSM (machine + sidecar + inputSchema / inputFlags).
  const loadFsmFn = o.loadFsmImpl ?? loadFsm;
  let loaded: Awaited<ReturnType<typeof loadFsmFn>>;
  try {
    loaded = await loadFsmFn({ filePath: fsmAbs, repoRoot });
  } catch (e) {
    o.stderr.write(`aharness: failed to load FSM: ${(e as Error).message}\n`);
    return { exitCode: 2 };
  }
  const machine = loaded.machine;
  const sidecar = loaded.sidecar;

  // 5. Auth precheck.
  if (o.authJsonExists !== undefined) {
    if (!o.authJsonExists()) {
      o.stderr.write('aharness: ~/.codex/auth.json not found. Run `codex login` first.\n');
      return { exitCode: 1 };
    }
  } else {
    const auth = resolveCodexAuthFile({ cwd: o.cwd });
    if (!auth.ok) {
      o.stderr.write(auth.message);
      return { exitCode: 1 };
    }
  }

  // 6. Parse `--<flag>` tokens + reserved-flag warnings.
  emitReservedFlagWarnings(loaded.inputFlags, o.stderr);
  const userInputArgs = o.inputArgs ?? [];
  let resolvedInput: Record<string, unknown> | undefined;
  if (loaded.inputSchema && loaded.inputFlags) {
    const parsed = parseInputFlags({
      args: userInputArgs,
      schema: loaded.inputSchema,
      flags: loaded.inputFlags,
    });
    if (!parsed.ok) {
      o.stderr.write(
        formatInputFlagError({
          errors: parsed.errors,
          fsmPath: o.fsmPath,
          schema: loaded.inputSchema,
          flags: loaded.inputFlags,
        }),
      );
      return { exitCode: 2 };
    }
    resolvedInput = parsed.values;
  } else if (userInputArgs.length > 0) {
    const unknownFlags = userInputArgs.filter((a) => a.startsWith('--')).join(' ');
    o.stderr.write(`aharness: FSM declares no input fields; unknown flags: ${unknownFlags}\n`);
    return { exitCode: 2 };
  }

  // 7. Discover declared per-state hooks. Zero-hook FSMs keep the
  //    Phase-2c boot profile: no wrapper materialization, no hook
  //    UDS, and no `hooks.<Kind>` CLI overrides.
  const declaredHookKinds = discoverDeclaredHookKinds(machine);
  const hookSocketPath = join(finalRunDir.root, 'hook.sock');
  const hookDir = join(finalRunDir.root, 'hooks');
  if (declaredHookKinds.length > 0) {
    materializeHookScripts({
      hookDir,
      hookSocket: hookSocketPath,
      stopHookTimeoutSec: 30,
      declaredHookKinds,
    });
  }

  // 8. Construct ActorHost + the submit dispatcher BEFORE any WS work
  //    so the dispatcher closure has a stable reference. The `input`
  //    payload to `createActor` carries the framework-managed runId +
  //    runDir plus parsed user input (user wins on collision; see
  //    docs/specs/2026-05-08-fsm-composition-and-cli-args-design.md §7).
  const actorInput = { runId: finalRunDir.runId, runDir: finalRunDir, ...resolvedInput };
  const host = new ActorHost(machine, undefined, actorInput);
  host.start();

  const opsHandle = createAharnessOps();
  const runMeta: RunMeta = {
    runId: finalRunDir.runId,
    threadId: '',
    repoRoot,
    fsmFile: fsmAbs,
    fsmHash6: finalRunDir.runId.slice(0, 6),
    codexPin: ver.found ?? ver.required,
    startedAt: new Date().toISOString(),
  };
  const activeThreadBinding = createActiveThreadBinding(undefined, {
    onChange: (threadId) => {
      runMeta.threadId = threadId;
    },
  });
  const pendingFreshClearThreadIds = new Set<string>();
  o._testOnActiveThreadBinding?.(activeThreadBinding);
  const uiEventLog = createUiEventLog({
    run: runMeta,
    topology: extractUiTopology(machine, { sidecar }),
  });
  const publishUiEvent = (event: Parameters<typeof uiEventLog.publish>[0]): ReplayableAppEvent => {
    const published = uiEventLog.publish(event);
    o._testOnUiEvent?.(published);
    return published;
  };
  const publishPostureChange = (posture: Partial<Posture>): void => {
    publishUiEvent({
      kind: 'PostureChange',
      posture,
    });
  };
  let frameworkNoteSeq = 0;
  let abandonedThreadDiagnosticSeq = 0;
  let freshClearBoundarySeq = 0;
  const publishOrientationNote = (text: string): void => {
    frameworkNoteSeq += 1;
    publishUiEvent({
      kind: 'FrameworkNote',
      id: `orientation-${frameworkNoteSeq}`,
      text,
      variant: 'orientation',
    });
  };
  const publishAbandonedThreadDiagnostic = (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }): void => {
    abandonedThreadDiagnosticSeq += 1;
    publishUiEvent({
      kind: 'AbandonedThreadDiagnostic',
      id: `abandoned-thread-${abandonedThreadDiagnosticSeq}`,
      threadId: diagnostic.threadId,
      source: diagnostic.source,
      message: diagnostic.message,
    });
    appendEventEntry(finalRunDir, {
      kind: 'abandonedThreadResidue',
      threadId: diagnostic.threadId,
      source: diagnostic.source,
      message: diagnostic.message,
    });
  };
  const isThreadUnavailableForRequests = (threadId: string): boolean =>
    activeThreadBinding.isAbandoned(threadId) || pendingFreshClearThreadIds.has(threadId);
  const isLiveThreadId = (threadId: string): boolean => {
    const activeThreadId = activeThreadBinding.current();
    return (
      activeThreadId === undefined ||
      (threadId === activeThreadId && !isThreadUnavailableForRequests(threadId))
    );
  };
  const isLiveThreadParams = (params: unknown): boolean => {
    const threadId = readThreadIdParam(params);
    return threadId === null ? true : isLiveThreadId(threadId);
  };
  const publishAbandonedThreadParamsDiagnostic = (
    params: unknown,
    source: string,
    message: string,
  ): void => {
    const threadId = readThreadIdParam(params);
    if (threadId === null || !isThreadUnavailableForRequests(threadId)) return;
    publishAbandonedThreadDiagnostic({ threadId, source, message });
  };
  let publishedOpen = false;
  const publishOpenPosture = (): void => {
    const open = isOpenState(host);
    if (open === publishedOpen) {
      return;
    }

    publishedOpen = open;
    publishPostureChange({ open });
  };
  publishUiEvent({
    kind: 'StateChange',
    from: null,
    to: host.currentStateId(),
    cause: 'boot',
    newState: deriveUiFsmState(host),
  });
  publishOpenPosture();
  // Phase 3c reply path. The UI server starts before the WebSocket
  // thread exists, so the callbacks close over late-bound `client` and
  // the active-thread binding initialized after thread/start resolves.
  // oxlint-disable-next-line prefer-const
  let client: JsonRpcClient | undefined;
  const flushSnapshotFn = (xstate: unknown): void => {
    flushHeadlessSnapshotEnvelope(finalRunDir.snapshotPath, {
      xstate,
      aharnessSubmitToolName: 'aharness_submit',
      threadId: activeThreadBinding.require(),
    });
    // Test seam: pin the post-AWAIT__ + post-submit state sequence
    // for integration tests that walk the snapshot history. Fires
    // AFTER the production flush completes so the observer sees the
    // state that is durable on disk.
    o._testOnSnapshotFlush?.(xstate);
  };

  let terminalResolve!: (v: { readonly exitCode?: number } | null) => void;
  const terminalPromise = new Promise<{ readonly exitCode?: number } | null>((res) => {
    terminalResolve = res;
  });
  const shutdownAfterTerminal: { current?: () => Promise<void> } = {};
  const serializeDispatch = makeSerializeDispatch();
  const writeActiveFinalArtifacts = async (
    terminalStateId: string,
    context?: Record<string, unknown>,
  ): Promise<void> => {
    const meta =
      context === undefined ? host.currentMeta() : terminalMetaById(machine, terminalStateId);
    if (!meta || meta.kind !== 'terminal') {
      throw new Error(
        `expected active terminal state '${terminalStateId}', got '${host.currentStateId()}'`,
      );
    }
    if (meta.artifacts === undefined) return;
    const data = context ?? host.currentContext();
    for (const [relPath, render] of Object.entries(meta.artifacts)) {
      await writeArtifact(finalRunDir, relPath, render(data));
    }
  };

  const signalTerminalCompletion = (meta?: ServerRequestMeta): void => {
    publishPostureChange({ isTerminal: true });
    const complete = async (): Promise<void> => {
      if (shutdownAfterTerminal.current) {
        await shutdownAfterTerminal.current();
      }
      terminalResolve(null);
    };
    if (meta) meta.afterReply(complete);
    else void complete();
  };

  const reportCanonicalBuiltinEventError = (info: CanonicalBuiltinEventErrorInfo): void => {
    o.stderr.write(
      `aharness: canonical ${info.eventName} ${info.phase} handler for state '${info.stateId}' branch ${info.branchIndex} threw: ${info.error.message}\n`,
    );
  };

  const permissionRequestDispatch = createPermissionRequestDispatcher({
    host,
    flushSnapshot: (snapshot) => flushSnapshotFn(snapshot),
    ops: opsHandle.ops,
    writeFinalArtifacts: (terminalStateId, context) =>
      writeActiveFinalArtifacts(terminalStateId, context),
    isTerminalState: (stateId) => terminalMetaById(machine, stateId)?.kind === 'terminal',
    onTerminal: () => signalTerminalCompletion(),
    onCanonicalEventError: reportCanonicalBuiltinEventError,
    onCommittedTransition: scheduleFreshClearAfterTransition,
    onAuthorHandlerError: ({ stateId, matcher, error }) => {
      o.stderr.write(
        `aharness: PermissionRequest hook for state '${stateId}' matcher '${matcher}' threw: ${error.message}\n`,
      );
    },
  });
  const approvalDispatcher = createApprovalDispatcher({
    publish: (event) => publishUiEvent(event),
    isActiveThread: isLiveThreadId,
    onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
    permissionRequest: (event, meta) =>
      serializeDispatch(() => permissionRequestDispatch(event, meta)),
  });
  const browserReplyController = createBrowserReplyController({
    isOpen: () => isOpenState(host),
    sendUserPrompt: async (text) => {
      const threadId = activeThreadBinding.current();
      if (!client || threadId === undefined) {
        throw new Error('browser reply path is not ready');
      }
      await client.request(METHOD.turnStart, {
        threadId,
        input: [{ type: 'text', text }],
      } satisfies TurnStartParams);
    },
    isAbandonedThread: isThreadUnavailableForRequests,
    onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
    onOwnerInputResolved: (requestId) => {
      publishUiEvent({ kind: 'OwnerInputResolved', id: requestId });
    },
    handleApprovalReply: (payload) => approvalDispatcher.handleBrowserReply(payload),
  });
  activeThreadBinding.subscribe(() => {
    approvalDispatcher.abandonInactiveRequests();
    browserReplyController.abandonInactiveOwnerInput();
  });
  const publishAgentMessageDelta = (p: unknown): void => {
    const params = p as {
      delta?: unknown;
      itemId?: unknown;
      threadId?: unknown;
      turnId?: unknown;
    };
    const activeThreadId = activeThreadBinding.current();
    if (typeof params.threadId === 'string' && isThreadUnavailableForRequests(params.threadId)) {
      publishAbandonedThreadDiagnostic({
        threadId: params.threadId,
        source: 'agentMessageDelta',
        message: 'agent message delta ignored for abandoned thread',
      });
      return;
    }
    if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
    const delta = typeof params.delta === 'string' ? params.delta : undefined;
    if (delta !== undefined && delta.length > 0) {
      o.stdout.write(delta);
      publishUiEvent({
        kind: 'AgentMessageDelta',
        id:
          typeof params.itemId === 'string'
            ? params.itemId
            : typeof params.turnId === 'string'
              ? params.turnId
              : 'agent-message',
        delta,
      });
    }
  };
  const rawResponseCallNames = new Map<string, string>();
  const threadItemToolNames = new Map<string, string>();
  const publishThreadItemStartedForUi = (item: unknown): void => {
    const event = threadItemStartedEventForUi(item);
    if (!event) return;
    if (event.type === 'function_call') {
      threadItemToolNames.set(event.id, event.name);
    }
    publishUiEvent(event);
  };
  const publishThreadItemCompletedForUi = (item: unknown): void => {
    const event = threadItemCompletedEventForUi(item, threadItemToolNames);
    if (!event) return;
    publishUiEvent(event);
  };
  const publishRawResponseItemForUi = (params: unknown): void => {
    const event = rawResponseItemEventForUi(params, rawResponseCallNames);
    if (!event) return;
    publishUiEvent(event);
  };

  let uiServer: UiServerHandle | undefined;
  const uiToken = randomBytes(18).toString('base64url');
  const closeUiServer = async (): Promise<void> => {
    const handle = uiServer;
    uiServer = undefined;
    if (handle) await handle.close();
  };
  try {
    uiServer = await (o.startUiServerImpl ?? startUiServer)({
      host: '127.0.0.1',
      port: 0,
      uiToken,
      eventLog: uiEventLog,
      replyHandler: (payload) => browserReplyController.handleReply(payload),
    });
    o.stdout.write(`aharness: browser UI available at ${urlWithUiToken(uiServer.url, uiToken)}\n`);
  } catch (e) {
    o.stderr.write(`aharness: UI server failed: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  // Auto-launch the browser as soon as the UI server is bound — the
  // pre-React boot screen and BootSkeleton give the user visual feedback
  // while codex spawns, the WS handshake completes, and `thread/start`
  // resolves. Without this, the user stares at an empty terminal for
  // several seconds before the browser window even appears.
  if (o.launchBrowserImpl) {
    const launchResult = o.launchBrowserImpl(urlWithUiToken(uiServer.url, uiToken));
    if (!launchResult.ok) {
      o.stderr.write(`aharness: failed to launch browser: ${launchResult.message}\n`);
    }
  }

  // Phase 2a wiring. `client` and `driveForward` are forward-declared
  // because the cross-state dance closure must dereference them at
  // invocation time (after `thread/start` resolves and assigns `client`,
  // and after `createDriveForward(...)` returns and assigns `driveForward`).
  // JavaScript arrow-function closures capture
  // the binding, not the value, so the dispatcher's closure sees the
  // eventually-assigned references. Defensive throws inside the closure
  // guard against misordered call sites.
  //
  // `prefer-const` cannot model forward-declared `let` written in a
  // later block but READ from a closure registered earlier (the rule
  // considers the closure read "before" the assignment in source order
  // because the closure body is parsed before the assignment line). The
  // reads ARE flow-correct here — the closures only fire after WS
  // connect completes, by which time both variables are assigned.
  // oxlint-disable-next-line prefer-const
  let driveForward: DriveForwardHandle | undefined;
  const watcherRegistry = createItemCompletedWatcherRegistry();
  let submittedThisTurnFlag = false;
  const markSubmittedThisTurn = (): void => {
    submittedThisTurnFlag = true;
    publishPostureChange({ submittedThisTurn: true });
  };
  const clearSubmittedThisTurn = (): void => {
    submittedThisTurnFlag = false;
    publishPostureChange({ submittedThisTurn: false });
  };
  function scheduleFreshClearAfterTransition(info: {
    readonly from: string;
    readonly to: string;
    readonly oldThreadId?: string;
    readonly oldTurnId?: string;
    readonly afterReply?: (callback: () => void | Promise<void>) => void;
  }): void {
    if (info.from === info.to) return;
    const meta = host.currentMeta();
    if (meta?.kind !== 'stateful' || !Object.prototype.hasOwnProperty.call(meta, 'clearOnEntry')) {
      return;
    }
    const targetStateId = host.currentStateId();
    const postTransitionContext = host.currentContext() as RunCtx;
    const clearOnEntry = meta.clearOnEntry as ClearOnEntryMeta;
    const oldThreadId = info.oldThreadId ?? activeThreadBinding.current();
    if (oldThreadId !== undefined) {
      pendingFreshClearThreadIds.add(oldThreadId);
    }
    const register =
      info.afterReply ??
      ((callback: () => void | Promise<void>) => {
        setImmediate(() => {
          void Promise.resolve(callback());
        });
      });
    register(() => {
      const c = client;
      if (!c) throw new Error('internal: client unbound at fresh-clear time');
      return serializeDispatch(async () => {
        const cwd = resolveClearOnEntryCwd({
          clearOnEntry,
          context: postTransitionContext,
          defaultCwd: repoRoot,
          stateId: targetStateId,
        });
        const boundary = await performFreshClear({
          client: c,
          activeThreadBinding,
          ...(info.oldTurnId !== undefined ? { oldTurnId: info.oldTurnId } : {}),
          cwd,
          dynamicTools: buildDynamicToolsRegistration(),
          composeActiveStateNudge: () => {
            const orientation = composeActiveStateNudge(host, sidecar);
            publishOrientationNote(orientation);
            return orientation;
          },
          onCleanupError: (error) => {
            o.stderr.write(`aharness: fresh clear cleanup warning: ${error.message}\n`);
          },
        });
        freshClearBoundarySeq += 1;
        publishUiEvent({
          kind: 'FreshClearBoundary',
          id: `fresh-clear-${freshClearBoundarySeq}`,
          reason: 'clearOnEntry',
          previousThreadId: boundary.previousThreadId,
          nextThreadId: boundary.nextThreadId,
          statePath: host.currentStateId(),
        });
      }).catch((error: unknown) => {
        o.stderr.write(`aharness: fresh clear failed: ${(error as Error).message}\n`);
        void shutdownAfterTerminal.current?.().finally(() => {
          terminalResolve({ exitCode: 1 });
        });
      });
    });
  }

  // Phase 2b owner-yield wiring.
  //
  // `pendingOwnerYieldCount` is the number of parked
  // `item/tool/requestUserInput` ServerRequests waiting for the
  // `OwnerInputProvider` to supply a reply. It increments synchronously
  // before `provider.provideAnswers(...)` is awaited and decrements in
  // the `finally` arm of the handler so EVERY exit path past the park
  // (resolve / reject / handler throw) restores the count.
  //
  // The drive-forward `isAwaiting` predicate (`runtime/driveForward.ts`)
  // reads `count > 0` defensively: codex normally cannot fire
  // `turn/completed` while a tool ServerRequest is in flight (the tool
  // call holds the turn open), but if WS notification reordering or a
  // future protocol change ever delivers `turn/completed` with a
  // request still parked, drive-forward MUST NOT issue a fresh
  // `turn/start` that races the in-flight tool reply.
  let pendingOwnerYieldCount = 0;
  const browserOwnerInputProvider = createBrowserOwnerInputProvider({
    controller: browserReplyController,
    publishUiEvent,
  });
  const ownerInputProvider: OwnerInputProvider = o.ownerInputProvider ?? browserOwnerInputProvider;
  // `isAwaiting` is read by drive-forward AND by the `_testObserveIsAwaiting`
  // hook (count-ordering test). The wrapper invokes the test observer
  // AFTER reading the count so the test sees the same boolean the
  // production code consumes.
  const isAwaiting = (): boolean => {
    const v = pendingOwnerYieldCount > 0;
    o._testObserveIsAwaiting?.(v);
    return v;
  };
  // Pre-Task-5 the count cannot be observed via `_testObserveIsAwaiting`
  // (drive-forward's `isAwaiting` branch still throws on `true`). The
  // count-read seam below lets the Task-3 count-ordering test poll the
  // value directly across the run.
  o._testReadPendingOwnerYieldCount?.(() => pendingOwnerYieldCount);
  const runActiveOnEntry = async (): Promise<void> => {
    const meta = host.currentMeta();
    if (!meta || meta.kind !== 'stateful' || meta.onEntry === undefined) return;
    try {
      await meta.onEntry(host.currentContext(), opsHandle.ops);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      o.stderr.write(`aharness: onEntry hook for state '${host.currentStateId()}' threw: ${msg}\n`);
    }
  };

  const dispatch = createSubmitDispatcher({
    host,
    machine,
    sidecar,
    flushSnapshot: flushSnapshotFn,
    onTerminal: (_terminalStateId, meta) => signalTerminalCompletion(meta),
    onTransition: (info) => {
      o.stdout.write(`\n[transition] ${info.from} --${info.exit}--> ${info.to}\n`);
      publishUiEvent({
        kind: 'StateChange',
        from: info.from,
        to: info.to,
        cause: 'submit',
        newState: deriveUiFsmState(host),
      });
      publishOpenPosture();
    },
    composeActiveStateNudge: () => composeActiveStateNudge(host, sidecar),
    runOnEntry: runActiveOnEntry,
    ops: opsHandle.ops,
    writeFinalArtifacts: writeActiveFinalArtifacts,
    scheduleFreshClear: (a) => {
      scheduleFreshClearAfterTransition({
        from: a.from,
        to: a.to,
        oldThreadId: a.oldThreadId,
        ...(a.oldTurnId !== undefined ? { oldTurnId: a.oldTurnId } : {}),
        afterReply: a.afterReply,
      });
    },
    scheduleCrossStateDance: (a) => {
      if (!client) throw new Error('internal: client unbound at dispatch time');
      publishOrientationNote(a.orientationText);
      scheduleCrossStateDance({
        ...a,
        client,
        activeThreadBinding,
        watcherRegistry,
        markSubmittedThisTurn,
        clearSubmittedThisTurn,
        // F1 salvage: when the dance's outer catch fires (watcher
        // timeout, unknown `turn/interrupt` error, `turn/start` error),
        // re-enter drive-forward's default branch so the run issues a
        // fresh `turn/start` instead of wedging. The dance owns
        // turn-kickoff on the success path; drive-forward owns it on
        // the failure path. The unconditional catch swallows both
        // `'jsonrpc: client closed'` (request after close,
        // `jsonrpc/client.ts:66`) and `'jsonrpc: closed before
        // response'` (close mid-request, `jsonrpc/client.ts:99,187`)
        // so a concurrent SIGINT-triggered shutdown does not surface a
        // spurious error from the salvage path.
        requestDriveForwardSalvage: () => {
          if (!driveForward) {
            throw new Error('internal: driveForward unbound at salvage time');
          }
          Promise.resolve(driveForward.salvageAfterDanceFailure()).catch(() => {
            /* SIGINT race: WS client closed mid-salvage. */
          });
        },
      });
    },
  });

  // 10. Spawn codex app-server (Unix listen).
  const sockPath = join(finalRunDir.root, 'app-server.sock');
  const mockModelBaseUrl = process.env['AHARNESS_MOCK_MODEL_BASE_URL'] ?? o._testMockModelBaseUrl;
  const cliOverrides: Array<readonly [string, string]> = [['approval_policy', '"on-request"']];
  if (mockModelBaseUrl) {
    cliOverrides.push(
      ['model_provider', '"mock"'],
      ['model_providers.mock.name', '"mock"'],
      ['model_providers.mock.base_url', escapeTomlBasicString(mockModelBaseUrl)],
      ['model_providers.mock.wire_api', '"responses"'],
    );
  }
  for (const kind of declaredHookKinds) {
    cliOverrides.push(renderHookCliOverride(kind, join(hookDir, KIND_TO_SCRIPT_NAME[kind])));
  }

  let appServer: AppServerHandle;
  try {
    appServer = await (o.spawnAppServer ?? realSpawnAppServer)({
      sockPath,
      cliOverrides,
      enabledFeatures: ['default_mode_request_user_input'],
    });
  } catch (e) {
    o.stderr.write(`aharness: app-server failed: ${(e as Error).message}\n`);
    await closeUiServer();
    return { exitCode: 1 };
  }

  // Phase 2b: await-exit resolver. Subscribes to
  // `rawResponseItem/completed` (no longer in the opt-out list); routes
  // `request_user_input` `function_call` / `function_call_output` items
  // through the resolver. The resolver's `commitAwait` is bound to a
  // pure `host.commitAwait(...)` call — post-commit side-effects ride
  // `onAfterTransition` so future callers of `commitAwait` inherit the
  // bare-commit semantics for free. The snapshot
  // flush in `onAfterTransition` keeps R6 atomicity symmetric with
  // `dispatchSubmit`'s post-commit flush.
  const awaitResolver = createAwaitResolver({
    currentStateId: () => host.currentStateId(),
    currentAwaitExitName: () => currentAwaitExitName(host),
    commitAwait: async (stateId, exitName, msg) => {
      const from = host.currentStateId();
      const currentMeta = host.currentMeta();
      const awaitMeta =
        currentMeta?.kind === 'stateful'
          ? currentMeta.exits[exitName]?.__aharnessCanonical
          : undefined;
      if (awaitMeta?.kind === 'await') {
        const targetStateId =
          currentMeta?.kind === 'stateful' && currentMeta.exits[exitName]?.kind === 'await'
            ? currentMeta.exits[exitName].to
            : null;
        const prepared = await prepareCanonicalAwaitCommit({
          meta: awaitMeta,
          context: host.currentContext(),
          ownerReply: msg,
          ops: opsHandle.ops,
        });
        if (!prepared.ok) {
          throw new Error(
            `Canonical await transition failed before commit for (${stateId}, ${exitName}): ${prepared.error}`,
          );
        }
        const commitPayload = payloadWithCanonicalCommit({ ownerReply: msg }, prepared.nextContext);
        const embeddedPrepared = await host.prepareEmbeddedFinalCommit({
          sourceStateId: stateId,
          target: targetStateId ?? undefined,
          context: prepared.nextContext,
          event: {
            type: `AWAIT__${stateId}__${exitName}`,
            payload: commitPayload,
          },
          ops: opsHandle.ops,
        });
        if (!embeddedPrepared.ok) {
          throw new Error(
            `Canonical embedded final failed before commit for (${stateId}, ${exitName}): ${embeddedPrepared.error}`,
          );
        }
        if (
          targetStateId !== null &&
          terminalMetaById(machine, targetStateId)?.kind === 'terminal'
        ) {
          await writeActiveFinalArtifacts(targetStateId, prepared.nextContext);
        }
        host.commitAwait(
          stateId,
          exitName,
          msg,
          prepared.nextContext,
          embeddedPrepared.matched ? embeddedPrepared.nextContext : undefined,
        );
      } else {
        host.commitAwait(stateId, exitName, msg);
      }
      const to = host.currentStateId();
      if (awaitMeta?.kind !== 'await' && host.currentMeta()?.kind === 'terminal') {
        await writeActiveFinalArtifacts(to);
      }
      publishUiEvent({
        kind: 'StateChange',
        from,
        to,
        cause: 'await',
        newState: deriveUiFsmState(host),
      });
      publishOpenPosture();
    },
    onAfterTransition: async (info) => {
      flushSnapshotFn(host.snapshot());
      await runActiveOnEntry();
      scheduleFreshClearAfterTransition(info);
    },
  });

  // 10. Connect WS — register the dispatcher inside `registerHandlers`
  //     before the initialize handshake (M18 invariant, spec §3 step 7).
  let wsHandle: Awaited<ReturnType<typeof connectHeadlessWs>>;
  const connectWs = o.connectHeadlessWsImpl ?? connectHeadlessWs;
  const wsDiagnostics: string[] = [];
  try {
    wsHandle = await connectWs({
      sockPath,
      clientInfo: { name: DAEMON_PROBE_CLIENT_NAME, version: pkgVersion() },
      optOutNotificationMethods: PHASE1_OPT_OUT_METHODS,
      diagnostics: (message) => {
        wsDiagnostics.push(message);
      },
      registerHandlers: (c: JsonRpcClient) => {
        c.onServerRequest(METHOD.commandExecutionRequestApproval, (params, meta) =>
          approvalDispatcher.handleCommandApproval(params, meta),
        );
        c.onServerRequest(METHOD.fileChangeRequestApproval, (params, meta) =>
          approvalDispatcher.handleFileApproval(params, meta),
        );
        c.onServerRequest(METHOD.toolDynamicCall, (params: unknown, meta) => {
          const abandonedResponse = () => {
            publishAbandonedThreadParamsDiagnostic(
              params,
              'dynamicToolCall',
              'dynamic tool call ignored for abandoned thread',
            );
            return buildAbandonedDynamicToolCallResponse();
          };
          if (!isLiveThreadParams(params)) {
            return abandonedResponse();
          }
          return serializeDispatch(() =>
            isLiveThreadParams(params)
              ? dispatchIfSubmit(params as DynamicToolCallParams, meta, dispatch)
              : Promise.resolve(abandonedResponse()),
          );
        });
        // Phase 2b: park the codex-built-in `request_user_input`
        // ServerRequest. The handler narrows malformed params, increments
        // `pendingOwnerYieldCount` BEFORE awaiting the provider (so the
        // drive-forward `isAwaiting` predicate observes the park), then
        // forwards the questions array to the `OwnerInputProvider`. The
        // double-nested `{answers: {<qid>: {answers: [<text>]}}}` reply
        // shape is load-bearing per CF-3 (`protocol/types.ts:334`).
        // M18 invariant: register inside `registerHandlers` BEFORE any
        // `thread/start` call.
        c.onServerRequest(METHOD.toolRequestUserInput, (params: unknown) => {
          if (!isLiveThreadParams(params)) {
            publishAbandonedThreadParamsDiagnostic(
              params,
              'ownerInput',
              'owner input request ignored for abandoned thread',
            );
            return isWellFormedRequestUserInputParams(params)
              ? buildAbandonedToolRequestUserInputResponse(params)
              : { answers: {} };
          }
          return handleOwnerYieldRequest(params, ownerInputProvider, {
            onParked: () => {
              pendingOwnerYieldCount += 1;
              publishPostureChange({ isAwaiting: true });
            },
            onReleased: () => {
              pendingOwnerYieldCount -= 1;
              publishPostureChange({ isAwaiting: pendingOwnerYieldCount > 0 });
            },
            stderr: o.stderr,
          });
        });
        c.onServerRequest(METHOD.mcpServerElicitationRequest, (params, meta) =>
          approvalDispatcher.handleElicitation(params, meta),
        );
        c.onServerRequest(METHOD.permissionsRequestApproval, (params, meta) =>
          approvalDispatcher.handlePermissionApproval(params, meta),
        );
        c.onNotification(METHOD.fileChangePatchUpdated, (params: unknown) => {
          approvalDispatcher.fileChangeTracker.notePatchUpdated(params);
        });
        c.onNotification(METHOD.serverRequestResolved, (params: unknown) => {
          approvalDispatcher.handleServerRequestResolved(params);
        });
        c.onNotification(METHOD.agentMessageDelta, publishAgentMessageDelta);
        // Phase 2b: subscribe to `rawResponseItem/completed`. Each
        // notification carries one `ResponseItem` (function_call /
        // function_call_output for built-in tools, plus other variants
        // we ignore). `dispatchRawResponseItem` filters to the two
        // variants the resolver cares about; `noteFunctionCall` further
        // filters by `name === 'request_user_input'` so non-yielding
        // calls (e.g. every `aharness_submit`) are dropped at near-zero
        // cost.
        //
        // `JsonRpcClient.onNotification` does NOT await the handler
        // (jsonrpc/client.ts:188 calls the handler synchronously and
        // ignores its return value). The `void ... .catch(...)` wrapper
        // routes any rejection from inside the resolver's awaited path
        // (commitAwait throw, flushSnapshotFn disk error, ...) to stderr
        // instead of leaking as an unhandled rejection.
        c.onNotification(METHOD.rawResponseItemCompleted, (params: unknown) => {
          if (!isLiveThreadParams(params)) {
            publishAbandonedThreadParamsDiagnostic(
              params,
              'rawResponseItemCompleted',
              'raw response item ignored for abandoned thread',
            );
            return;
          }
          publishRawResponseItemForUi(params);
          void dispatchRawResponseItem(params, awaitResolver).catch((err: unknown) => {
            const callId = extractCallIdForLog(params);
            o.stderr.write(
              `aharness: awaitResolver dispatch error (call_id=${callId ?? '<unknown>'}): ${
                (err as Error).message
              }\n`,
            );
          });
        });
      },
    });
  } catch (e) {
    o.stderr.write(`aharness: WS connect failed: ${(e as Error).message}\n`);
    if (wsDiagnostics.length > 0) {
      o.stderr.write(
        `aharness: WS diagnostics:\n${wsDiagnostics.map((m) => `  - ${m}`).join('\n')}\n`,
      );
    }
    await appServer.close();
    await closeUiServer();
    return { exitCode: 1 };
  }
  client = wsHandle.client;
  // Local non-nullable alias so the remainder of the boot sequence
  // narrows `client` without repeated `!` assertions. The forward-
  // declared `let client` exists solely so the cross-state dispatcher
  // closure (constructed BEFORE WS connect) can dereference the live
  // client at invocation time.
  const ws = client;
  let hookSocket: HookSocketHandle | undefined;
  const closeHookSocket = async (): Promise<void> => {
    const handle = hookSocket;
    hookSocket = undefined;
    if (handle) await handle.close();
  };
  const shutdown = runOnce(async (): Promise<void> => {
    await closeHookSocket();
    approvalDispatcher.close();
    await closeUiServer();
    await runShutdown({ appServer, client: ws, runDir: finalRunDir, ownerInputProvider });
  });
  shutdownAfterTerminal.current = shutdown;

  // 11. thread/start.
  try {
    const r = await ws.request<ThreadStartResponse>(METHOD.threadStart, {
      cwd: repoRoot,
      dynamicTools: buildDynamicToolsRegistration(),
    });
    activeThreadBinding.set(r.thread.id);
  } catch (e) {
    o.stderr.write(`aharness: thread/start failed: ${(e as Error).message}\n`);
    await shutdown();
    return { exitCode: 1 };
  }

  if (declaredHookKinds.length > 0) {
    try {
      hookSocket = await startHookSocket({
        path: hookSocketPath,
        dispatch: createHookDispatchers({
          declaredHookKinds,
          host,
          activeThreadBinding,
          flushSnapshot: flushSnapshotFn,
          ops: opsHandle.ops,
          serializeDispatch,
          writeFinalArtifacts: writeActiveFinalArtifacts,
          isTerminalState: (stateId) => terminalMetaById(machine, stateId)?.kind === 'terminal',
          onTerminal: () => signalTerminalCompletion(),
          onCanonicalEventError: reportCanonicalBuiltinEventError,
          onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
          onCommittedTransition: scheduleFreshClearAfterTransition,
        }),
      });
    } catch (e) {
      o.stderr.write(`aharness: hook socket failed: ${(e as Error).message}\n`);
      await shutdown();
      return { exitCode: 1 };
    }
  }

  // 12. Wire router + drive-forward + agent-message stream. The handle
  //     is assigned to the forward-declared `driveForward` so the
  //     cross-state dance's `requestDriveForwardSalvage` closure
  //     (constructed BEFORE WS connect, see step 9) can dereference it
  //     at invocation time.
  driveForward = createDriveForward({
    client: ws,
    activeThreadBinding,
    isTerminal: () => isTerminal(host),
    composeActiveStateNudge: () => {
      const orientation = composeActiveStateNudge(host, sidecar);
      publishOrientationNote(orientation);
      return orientation;
    },
    onShutdown: async () => {
      await shutdown();
      terminalResolve(null);
    },
    submittedThisTurn: () => submittedThisTurnFlag,
    isAwaiting,
    isOpen: () => isOpenState(host),
    onTurnCompletedBeforeDecision: () => {
      flushSnapshotFn(host.snapshot());
    },
  });
  const driveForwardHandle = driveForward;
  const router = startNotificationRouter({
    client: ws,
    activeThreadBinding,
    onTurnStarted: (turnId) => {
      // Phase 2a: every fresh `turn/started` resets the cross-state
      // dispatcher's "I drove the next turn" flag so a subsequent
      // self-loop / no-cross-state turn falls through to drive-forward's
      // default branch.
      clearSubmittedThisTurn();
      publishUiEvent({
        kind: 'TurnStarted',
        turnId: turnId ?? '<unknown>',
      });
    },
    onTurnCompleted: () => driveForwardHandle.onTurnCompleted(),
    onItemStarted: (item, itemTurnId) => {
      if (itemTurnId) {
        approvalDispatcher.fileChangeTracker.noteThreadItem({
          threadId: activeThreadBinding.require(),
          turnId: itemTurnId,
          item,
        });
      }
      publishThreadItemStartedForUi(item);
    },
    onItemCompleted: (item, itemTurnId) => {
      if (itemTurnId) {
        approvalDispatcher.fileChangeTracker.noteThreadItem({
          threadId: activeThreadBinding.require(),
          turnId: itemTurnId,
          item,
        });
      }
      // Phase 2a: dispatch item to cross-state watcher registry. The
      // dance's watcher resolves on the matching `item/completed`
      // payload and proceeds to `turn/interrupt` + `turn/start`.
      watcherRegistry.dispatch(item);
      publishThreadItemCompletedForUi(item);
    },
    onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
  });
  ws.onNotification(METHOD.turnCompleted, (p) => {
    const params = p as { threadId?: unknown; turn?: unknown };
    const activeThreadId = activeThreadBinding.current();
    if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
    publishUiEvent({
      kind: 'TurnCompleted',
      turnId: readUiTurnId(params.turn) ?? '<unknown>',
      finishReason: readUiFinishReason(params.turn),
    });
  });

  // 13. Inject the first-state nudge as a `turn/start` kickoff so the
  //     model's first turn opens with the active state's orientation as
  //     a TUI-visible "user message".
  try {
    await runActiveOnEntry();
    const orientation = composeActiveStateNudge(host, sidecar);
    publishOrientationNote(orientation);
    await ws.request(METHOD.turnStart, {
      threadId: activeThreadBinding.require(),
      input: [{ type: 'text', text: orientation }],
    } satisfies TurnStartParams);
  } catch (e) {
    o.stderr.write(`aharness: kickoff turn/start failed: ${(e as Error).message}\n`);
    router.close();
    await shutdown();
    return { exitCode: 1 };
  }

  // 14. Block on terminal-reached or SIGINT/SIGTERM. The signal
  //     handlers run §5.6 shutdown and `process.exit` directly — we
  //     never return from this function on a signal path.
  //
  //     `startSignalHandlers` (signals.ts:26-27) wires SIGINT and SIGTERM
  //     through the same `onSigint` callback. Both paths exit 130 —
  //     existing aharness behaviour pre-Phase-1; a SIGTERM-specific 143
  //     exit code would require widening the signals helper.
  const signals = startSignalHandlers({
    onSigint: async () => {
      router.close();
      await shutdown();
      process.exit(SIGINT_EXIT_CODE);
    },
  });

  try {
    const terminalResult = await terminalPromise;
    return { exitCode: terminalResult?.exitCode ?? 0 };
  } finally {
    signals.close();
    router.close();
    await closeHookSocket();
    await closeUiServer();
  }
}

type UiItemStartedEvent = Extract<AppEvent, { kind: 'ItemStarted' }>;

function threadItemStartedEventForUi(item: unknown): UiItemStartedEvent | null {
  const record = asUiRecord(item);
  if (!record) return null;

  const type = readStringField(record, 'type');
  const id = readItemId(record);
  if (!type || !id) return null;

  if (type === 'agentMessage') {
    return { kind: 'ItemStarted', id, type: 'agent_message', text: readItemText(record) };
  }
  if (type === 'userMessage') {
    return { kind: 'ItemStarted', id, type: 'user_message', text: readItemText(record) };
  }
  if (type === 'reasoning' || type === 'agentReasoning') {
    return { kind: 'ItemStarted', id, type: 'reasoning', text: readItemText(record) };
  }
  if (isUiToolThreadItemType(type)) {
    return {
      kind: 'ItemStarted',
      id,
      type: 'function_call',
      name: readUiToolName(record, type),
      arguments: readUiToolArguments(record, type),
    };
  }

  return null;
}

function threadItemCompletedEventForUi(
  item: unknown,
  startedToolNames: Map<string, string>,
): UiItemStartedEvent | null {
  const record = asUiRecord(item);
  if (!record) return null;

  const type = readStringField(record, 'type');
  const id = readItemId(record);
  if (!type || !id || !isUiToolThreadItemType(type)) return null;

  const name = startedToolNames.get(id) ?? readUiToolName(record, type);
  startedToolNames.delete(id);
  return {
    kind: 'ItemStarted',
    id: `${id}:output`,
    type: 'function_call_output',
    name,
    output: readUiToolOutput(record),
    ok: readUiToolOk(record),
  };
}

function rawResponseItemEventForUi(
  params: unknown,
  callNames: Map<string, string>,
): UiItemStartedEvent | null {
  const record = asUiRecord(params);
  const item = asUiRecord(record?.['item']);
  if (!item) return null;

  const type = readStringField(item, 'type');
  if (type === 'function_call') {
    const callId = readStringField(item, 'call_id');
    const name = readStringField(item, 'name');
    const args = readStringField(item, 'arguments');
    if (!callId || !name || args === undefined) return null;
    callNames.set(callId, name);
    return {
      kind: 'ItemStarted',
      id: callId,
      type: 'function_call',
      name,
      arguments: args,
    };
  }

  if (type === 'function_call_output') {
    const callId = readStringField(item, 'call_id');
    if (!callId) return null;
    const name = readStringField(item, 'name') ?? callNames.get(callId) ?? 'function_call';
    callNames.delete(callId);
    return {
      kind: 'ItemStarted',
      id: `${callId}:output`,
      type: 'function_call_output',
      name,
      output: formatUiValue(readUnknownField(item, 'output')),
      ok: readUiToolOk(item),
    };
  }

  return null;
}

function isUiToolThreadItemType(type: string): boolean {
  return (
    type === 'functionCall' ||
    type === 'mcpToolCall' ||
    type === 'commandExecution' ||
    type === 'execCommand' ||
    type === 'collabAgentToolCall' ||
    type === 'spawnAgentToolCall'
  );
}

function readUiToolName(record: Record<string, unknown>, type: string): string {
  if (type === 'commandExecution' || type === 'execCommand') return 'bash';
  if (type === 'mcpToolCall') {
    const server =
      readStringField(record, 'serverName') ??
      readStringField(record, 'server') ??
      readNestedStringField(record, ['params', 'serverName']) ??
      readNestedStringField(record, ['params', 'server']);
    const tool =
      readStringField(record, 'toolName') ??
      readStringField(record, 'name') ??
      readNestedStringField(record, ['params', 'toolName']) ??
      readNestedStringField(record, ['params', 'name']);
    if (server && tool) return `mcp:${server}/${tool}`;
    if (tool) return `mcp:${tool}`;
    return 'mcp tool';
  }
  if (type === 'spawnAgentToolCall') return 'spawn_agent';
  if (type === 'collabAgentToolCall') return 'collab_agent';
  return readStringField(record, 'name') ?? readStringField(record, 'toolName') ?? type;
}

function readUiToolArguments(record: Record<string, unknown>, type: string): string {
  if (type === 'commandExecution' || type === 'execCommand') {
    const command =
      readStringField(record, 'command') ??
      readNestedStringField(record, ['params', 'command']) ??
      readStringField(record, 'cmd');
    const cwd = readStringField(record, 'cwd') ?? readNestedStringField(record, ['params', 'cwd']);
    return formatUiValue(compactObject({ command, cwd }));
  }

  return formatUiValue(
    readUnknownField(record, 'arguments') ??
      readUnknownField(record, 'args') ??
      readUnknownField(record, 'input') ??
      readUnknownField(record, 'params'),
  );
}

function readUiToolOutput(record: Record<string, unknown>): string {
  const error = readUnknownField(record, 'error');
  if (error !== undefined && error !== null) return formatUiValue(error);
  return formatUiValue(
    readUnknownField(record, 'output') ??
      readUnknownField(record, 'result') ??
      readUnknownField(record, 'message') ??
      readUnknownField(record, 'status'),
  );
}

function readUiToolOk(record: Record<string, unknown>): boolean {
  if (
    readUnknownField(record, 'error') !== undefined &&
    readUnknownField(record, 'error') !== null
  ) {
    return false;
  }
  const status = readStringField(record, 'status')?.toLowerCase();
  if (!status) return true;
  return !['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'declined'].includes(
    status,
  );
}

function readItemId(record: Record<string, unknown>): string | null {
  return (
    readStringField(record, 'id') ??
    readStringField(record, 'callId') ??
    readStringField(record, 'call_id') ??
    null
  );
}

function readItemText(record: Record<string, unknown>): string {
  const text =
    readStringField(record, 'text') ??
    readStringField(record, 'message') ??
    readContentText(readUnknownField(record, 'content')) ??
    readContentText(readUnknownField(record, 'contentItems'));
  return text ?? '';
}

function readContentText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    const record = asUiRecord(item);
    const text = record ? readStringField(record, 'text') : null;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function asUiRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function readNestedStringField(
  record: Record<string, unknown>,
  path: ReadonlyArray<string>,
): string | undefined {
  let current: unknown = record;
  for (const segment of path) {
    const nested = asUiRecord(current);
    if (!nested) return undefined;
    current = nested[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function readUnknownField(record: Record<string, unknown>, field: string): unknown {
  return record[field];
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function formatUiValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? formatUiValueFallback(value);
  } catch {
    return formatUiValueFallback(value);
  }
}

function formatUiValueFallback(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') {
    return value.description ? `Symbol(${value.description})` : 'Symbol()';
  }
  if (typeof value === 'function') return '[function]';
  return '[unserializable value]';
}

function formatInputFlagError(o: {
  readonly errors: ReadonlyArray<string>;
  readonly fsmPath: string;
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
      `Example: aharness ${displayFsmPath(o.fsmPath)} ${requiredFields
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

function displayFsmPath(fsmPath: string): string {
  return isAbsolute(fsmPath) ? basename(fsmPath) : fsmPath;
}

function urlWithUiToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

function runOnce(fn: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | null = null;
  return () => {
    promise ??= fn();
    return promise;
  };
}

function createHookDispatchers(i: {
  readonly declaredHookKinds: ReadonlyArray<HookKind>;
  readonly host: ActorHost;
  readonly activeThreadBinding: ActiveThreadBinding;
  readonly flushSnapshot: (xstateSnapshot: unknown) => void;
  readonly ops: AharnessOps;
  readonly serializeDispatch: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly writeFinalArtifacts?: (
    terminalStateId: string,
    context?: Record<string, unknown>,
  ) => Promise<void>;
  readonly isTerminalState?: (stateId: string) => boolean;
  readonly onTerminal?: (terminalStateId: string) => void;
  readonly onCanonicalEventError?: (info: CanonicalBuiltinEventErrorInfo) => void;
  readonly onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
  readonly onCommittedTransition?: (info: {
    readonly from: string;
    readonly to: string;
    readonly oldThreadId?: string;
    readonly oldTurnId?: string;
  }) => void;
}): HookDispatchByType {
  const enabled = new Set(i.declaredHookKinds);
  const noAuthorHooks = (): Promise<{ status: 'OK'; body: string }> =>
    Promise.resolve({
      status: 'OK',
      body: '{}',
    });
  return {
    PRE_TOOL_USE: enabled.has('PreToolUse')
      ? serializeHookDispatcher(
          createPerStateHookDispatcher({
            kind: 'PreToolUse',
            host: i.host,
            activeThreadBinding: i.activeThreadBinding,
            flushSnapshot: i.flushSnapshot,
            ops: i.ops,
            ...(i.writeFinalArtifacts !== undefined
              ? { writeFinalArtifacts: i.writeFinalArtifacts }
              : {}),
            ...(i.isTerminalState !== undefined ? { isTerminalState: i.isTerminalState } : {}),
            ...(i.onTerminal !== undefined ? { onTerminal: i.onTerminal } : {}),
            ...(i.onCanonicalEventError !== undefined
              ? { onCanonicalEventError: i.onCanonicalEventError }
              : {}),
            ...(i.onAbandonedThreadDiagnostic !== undefined
              ? { onAbandonedThreadDiagnostic: i.onAbandonedThreadDiagnostic }
              : {}),
            ...(i.onCommittedTransition !== undefined
              ? { onCommittedTransition: i.onCommittedTransition }
              : {}),
          }),
          i.serializeDispatch,
        )
      : noAuthorHooks,
    POST_TOOL_USE: enabled.has('PostToolUse')
      ? serializeHookDispatcher(
          createPerStateHookDispatcher({
            kind: 'PostToolUse',
            host: i.host,
            activeThreadBinding: i.activeThreadBinding,
            flushSnapshot: i.flushSnapshot,
            ops: i.ops,
            ...(i.writeFinalArtifacts !== undefined
              ? { writeFinalArtifacts: i.writeFinalArtifacts }
              : {}),
            ...(i.isTerminalState !== undefined ? { isTerminalState: i.isTerminalState } : {}),
            ...(i.onTerminal !== undefined ? { onTerminal: i.onTerminal } : {}),
            ...(i.onCanonicalEventError !== undefined
              ? { onCanonicalEventError: i.onCanonicalEventError }
              : {}),
            ...(i.onAbandonedThreadDiagnostic !== undefined
              ? { onAbandonedThreadDiagnostic: i.onAbandonedThreadDiagnostic }
              : {}),
            ...(i.onCommittedTransition !== undefined
              ? { onCommittedTransition: i.onCommittedTransition }
              : {}),
          }),
          i.serializeDispatch,
        )
      : noAuthorHooks,
    USER_PROMPT_SUBMIT: enabled.has('UserPromptSubmit')
      ? serializeHookDispatcher(
          createPerStateHookDispatcher({
            kind: 'UserPromptSubmit',
            host: i.host,
            activeThreadBinding: i.activeThreadBinding,
            flushSnapshot: i.flushSnapshot,
            ops: i.ops,
            ...(i.writeFinalArtifacts !== undefined
              ? { writeFinalArtifacts: i.writeFinalArtifacts }
              : {}),
            ...(i.isTerminalState !== undefined ? { isTerminalState: i.isTerminalState } : {}),
            ...(i.onTerminal !== undefined ? { onTerminal: i.onTerminal } : {}),
            ...(i.onCanonicalEventError !== undefined
              ? { onCanonicalEventError: i.onCanonicalEventError }
              : {}),
            ...(i.onAbandonedThreadDiagnostic !== undefined
              ? { onAbandonedThreadDiagnostic: i.onAbandonedThreadDiagnostic }
              : {}),
            ...(i.onCommittedTransition !== undefined
              ? { onCommittedTransition: i.onCommittedTransition }
              : {}),
          }),
          i.serializeDispatch,
        )
      : noAuthorHooks,
  };
}

function serializeHookDispatcher(
  dispatch: (body: string) => Promise<{ status: 'OK' | 'ERROR'; body: string }>,
  serializeDispatch: <T>(fn: () => Promise<T>) => Promise<T>,
): (body: string) => Promise<{ status: 'OK' | 'ERROR'; body: string }> {
  return (body) => serializeDispatch(() => dispatch(body));
}

// ---------------------------------------------------------------------------
// Dispatcher routing helper.
// ---------------------------------------------------------------------------

/**
 * Route only `aharness_submit` server-requests to the submit dispatcher.
 * Anything else returns a `success: false` reply so codex surfaces a
 * clear error to the model rather than wedging the turn.
 */
async function dispatchIfSubmit(
  params: DynamicToolCallParams,
  meta: ServerRequestMeta,
  dispatch: (
    p: DynamicToolCallParams,
    meta?: ServerRequestMeta,
  ) => Promise<DynamicToolCallResponse>,
): Promise<DynamicToolCallResponse> {
  if (params.tool === SUBMIT_TOOL_NAME) {
    return dispatch(params, meta);
  }
  return {
    success: false,
    contentItems: [
      {
        type: 'inputText',
        text: `aharness: unknown dynamic tool '${params.tool}'; this runtime only registers '${SUBMIT_TOOL_NAME}'.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Phase 2b: owner-yield ServerRequest helper.
// ---------------------------------------------------------------------------

/**
 * Hooks the `item/tool/requestUserInput` handler uses to bracket each
 * parked request. `onParked` fires synchronously BEFORE the provider
 * is awaited; `onReleased` fires in the handler's `finally` arm so every
 * exit path (resolve / reject / handler throw) restores the count.
 */
interface OwnerYieldHandlerHooks {
  readonly onParked: () => void;
  readonly onReleased: () => void;
  readonly stderr: NodeJS.WritableStream;
}

function createBrowserOwnerInputProvider(args: {
  readonly controller: BrowserReplyController;
  readonly publishUiEvent: (event: AppEvent) => void;
}): OwnerInputProvider {
  let closePending: ((error: Error) => void) | null = null;
  let closePendingRequestId: string | null = null;

  return {
    provideAnswers(params) {
      args.publishUiEvent({
        kind: 'ServerRequest',
        id: params.itemId,
        method: METHOD.toolRequestUserInput,
        questions: params.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isOther: question.isOther,
          isSecret: question.isSecret,
          ...ownerInputChoices(question),
        })),
      });

      const parked = args.controller.parkOwnerInput(params);
      const closed = new Promise<never>((_resolve, reject) => {
        closePending = reject;
        closePendingRequestId = params.itemId;
      });
      return Promise.race([parked, closed]).finally(() => {
        if (closePendingRequestId === params.itemId) {
          closePending = null;
          closePendingRequestId = null;
        }
      });
    },
    close() {
      closePending?.(new Error('browser owner input provider closed'));
      if (closePendingRequestId !== null) {
        args.publishUiEvent({ kind: 'OwnerInputResolved', id: closePendingRequestId });
      }
      closePending = null;
      closePendingRequestId = null;
    },
  };
}

function ownerInputChoices(question: RequestUserInputQuestion): { choices?: string[] } {
  const choices = question.options?.map((option) => option.label) ?? [];
  if (question.isOther && !choices.includes('__other__')) {
    choices.push('__other__');
  }
  return choices.length > 0 ? { choices } : {};
}

/**
 * Park an `item/tool/requestUserInput` ServerRequest, forward the
 * questions array to the supplied `OwnerInputProvider`, and reply with
 * the provider's response.
 *
 * Ordering invariants (load-bearing):
 *
 *   1. Narrow malformed params BEFORE incrementing the count. An
 *      early-return on a missing/empty `questions` array MUST NOT
 *      increment-without-decrement; the request never reaches the
 *      provider so neither hook fires.
 *   2. Park (increment) synchronously before `provider.provideAnswers`
 *      is awaited so the drive-forward `isAwaiting` predicate observes
 *      `count > 0` for every microtask between the park and the reply.
 *   3. Release (decrement) in `finally` so a provider throw OR a reply
 *      send throw both restore the count. A throw inside `provideAnswers`
 *      is routed to `synthesizeDeclineReply(...)` and the reply path
 *      continues; a throw past `provideAnswers` (e.g. the wire send)
 *      propagates, but the `finally` has already decremented.
 *
 * On a provider exception the handler logs to stderr and replies with
 * `{answers: {<qid>: {answers: [DECLINED_ANSWER_TEXT]}}}` for every
 * input qid — a non-empty tool result so the model can advance with the
 * synthetic decline rather than retry. The marker text is single-sourced
 * at `ownerInputProvider.ts` so the handler and test assertions stay in
 * lockstep.
 */
async function handleOwnerYieldRequest(
  params: unknown,
  provider: OwnerInputProvider,
  hooks: OwnerYieldHandlerHooks,
): Promise<ToolRequestUserInputResponse> {
  // Step 1: defensive narrow. If `questions` is missing or empty there
  // is no work for the provider — emit an empty-answers reply (the
  // contract requires every ServerRequest be answered, but the model
  // expects no questions to satisfy) and DO NOT park.
  if (!isWellFormedRequestUserInputParams(params)) {
    hooks.stderr.write(
      'aharness: ownerInputProvider got malformed request params; replying with empty answers\n',
    );
    return { answers: {} };
  }
  // Narrowed: params is `ToolRequestUserInputParams` from here.
  const narrowed = params;

  // Step 2: park synchronously BEFORE awaiting the provider.
  hooks.onParked();
  try {
    return await provider.provideAnswers(narrowed);
  } catch (e) {
    hooks.stderr.write(
      `aharness: ownerInputProvider error: ${(e as Error).message}; replying with synthetic decline\n`,
    );
    return synthesizeDeclineReply(narrowed);
  } finally {
    // Step 3: release in `finally` so every exit path restores the count.
    hooks.onReleased();
  }
}

/**
 * Type-narrow guard for `ToolRequestUserInputParams`. Codex's pinned
 * commit guarantees the shape, but defensive narrowing matches the rest
 * of the runtime's posture and lets the handler reply gracefully when a
 * test or future protocol drift sends a malformed body.
 */
function isWellFormedRequestUserInputParams(params: unknown): params is ToolRequestUserInputParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return false;
  const record = params as Record<string, unknown>;
  const questions = record['questions'];
  if (!Array.isArray(questions) || questions.length === 0) return false;
  return questions.every(isWellFormedRequestUserInputQuestion);
}

function isWellFormedRequestUserInputQuestion(question: unknown): boolean {
  if (question === null || typeof question !== 'object' || Array.isArray(question)) return false;
  const record = question as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['header'] === 'string' &&
    typeof record['question'] === 'string' &&
    typeof record['isOther'] === 'boolean' &&
    typeof record['isSecret'] === 'boolean' &&
    (record['options'] === undefined || Array.isArray(record['options']))
  );
}

/**
 * Build a synthetic-decline reply: one `DECLINED_ANSWER_TEXT` per input
 * qid, double-nested per CF-3 (`protocol/types.ts:334`). Used when the
 * provider throws or rejects; the marker text is intentionally visible
 * so the model can render a sensible response rather than treating the
 * tool call as having returned nothing.
 */
function synthesizeDeclineReply(params: ToolRequestUserInputParams): ToolRequestUserInputResponse {
  return {
    answers: Object.fromEntries(
      params.questions.map((q) => [q.id, { answers: [DECLINED_ANSWER_TEXT] }]),
    ),
  };
}

function readThreadIdParam(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' ? threadId : null;
}

// ---------------------------------------------------------------------------
// Phase 2b: `rawResponseItem/completed` dispatch helpers.
// ---------------------------------------------------------------------------

/**
 * Route a `rawResponseItem/completed` notification payload through the
 * await resolver. Each notification carries one `ResponseItem`
 * (`protocol/src/models.rs:743`); for the resolver's purposes only
 * `function_call` and `function_call_output` variants are interesting.
 * All others are dropped silently — `request_user_input`'s lifecycle is
 * surfaced as exactly those two variants per the citation chain in
 * `awaitResolver.ts`'s file header.
 *
 * Defensive narrowing: codex's `RawResponseItemCompletedNotification`
 * (`protocol/notifications.ts`) guarantees the shape at the pinned
 * commit, but a malformed body should never propagate as a thrown error
 * past the `.catch` site in the notification handler.
 */
export async function dispatchRawResponseItem(
  params: unknown,
  resolver: AwaitResolver,
): Promise<void> {
  if (params === null || typeof params !== 'object') return;
  const item = (params as { item?: unknown }).item;
  if (item === null || typeof item !== 'object') return;
  const type = (item as { type?: unknown }).type;
  if (type === 'function_call') {
    const callId = (item as { call_id?: unknown }).call_id;
    const name = (item as { name?: unknown }).name;
    const args = (item as { arguments?: unknown }).arguments;
    if (typeof callId !== 'string' || typeof name !== 'string' || typeof args !== 'string') {
      return;
    }
    resolver.noteFunctionCall({ call_id: callId, name, arguments: args });
    return;
  }
  if (type === 'function_call_output') {
    const callId = (item as { call_id?: unknown }).call_id;
    const output = (item as { output?: unknown }).output;
    if (typeof callId !== 'string') return;
    const threadId = (params as { threadId?: unknown }).threadId;
    const turnId = (params as { turnId?: unknown }).turnId;
    await resolver.handleFunctionCallOutput(
      { call_id: callId, output },
      {
        ...(typeof threadId === 'string' ? { threadId } : {}),
        ...(typeof turnId === 'string' ? { turnId } : {}),
      },
    );
    return;
  }
  // Other ResponseItem variants (assistant messages, reasoning, dynamic
  // tool calls, ...): not relevant to the await resolver.
}

/**
 * Best-effort `call_id` extraction from a `rawResponseItem/completed`
 * payload, used only for the stderr diagnostic on a resolver error.
 * Returns `undefined` when the shape is malformed — the diagnostic
 * stringifies `<unknown>` in that case.
 */
export function extractCallIdForLog(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const item = (params as { item?: unknown }).item;
  if (item === null || typeof item !== 'object') return undefined;
  const callId = (item as { call_id?: unknown }).call_id;
  return typeof callId === 'string' ? callId : undefined;
}

/**
 * Return the name of the currently active leaf state's `await`-kind
 * exit, or `null` when none is declared. The verifier check
 * `await-no-multi-branch` guarantees a state has at most one await
 * exit, so first-match is correct.
 *
 * Narrows `AharnessMeta` to its `stateful` variant before reading
 * `exits` — terminal / passive variants have no `exits` field, and
 * unguarded access would TS-error under strict mode (and runtime-error
 * if a future variant ships with a stricter shape).
 */
export function currentAwaitExitName(host: ActorHost): string | null {
  const meta = host.currentMeta();
  if (!meta || meta.kind !== 'stateful') return null;
  for (const [name, def] of Object.entries(meta.exits)) {
    if (def.kind === 'await') return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Active-state orientation composer.
// ---------------------------------------------------------------------------

/**
 * Compose the orientation nudge for the host's currently active leaf.
 * Throws if the leaf is non-stateful (terminal / passive) — drive-forward
 * never advances those, but if we somehow ended up calling this on one
 * the loud failure is preferable to a silent empty turn.
 *
 * Shape mirrors `daemon/onStateEntry.ts` so the on-disk nudge text is
 * byte-identical to what the legacy daemon emitted; this matters for
 * the prompt-cache key codex derives from the conversation history.
 */
function composeActiveStateNudge(host: ActorHost, sidecar: SchemaSidecar): string {
  const stateId = host.currentStateId();
  const meta = host.currentMeta();
  if (!meta || meta.kind !== 'stateful') {
    throw new Error(`composeActiveStateNudge called on non-stateful leaf '${stateId}'`);
  }
  const stateMeta = meta;
  const exits: ExitSpec[] = [];
  for (const [name, def] of Object.entries(stateMeta.exits)) {
    if (def.kind === 'submit') {
      // Defensive `?? { type: 'object' }`: the verifier requires a
      // sidecar entry per submit exit; if it is missing at runtime
      // (e.g. cache desync) render a minimal stub so the exit name
      // still surfaces in the orientation rather than crashing the
      // composer.
      const schema = sidecar[stateId]?.[name]?.jsonSchema ?? { type: 'object' };
      exits.push({ kind: 'submit', name, schema });
    } else if (def.kind === 'await') {
      const ask = resolveAwaitAsk(def.__aharnessCanonical, host.currentContext() as RunCtx);
      exits.push({ kind: 'await', name, ...(ask !== undefined ? { ask } : {}) });
    }
  }

  let entryPromptText: string;
  try {
    entryPromptText = resolveEntryPrompt(stateMeta.entryPrompt, host.currentContext() as RunCtx);
  } catch (e) {
    entryPromptText = `(aharness: error computing entryPrompt: ${(e as Error).message})`;
  }

  let awaitsOwnerText: { messageToUser: string } | undefined;
  if (stateMeta.awaitsOwnerText !== undefined) {
    const m = stateMeta.awaitsOwnerText.messageToUser;
    let resolved: string;
    if (typeof m === 'string') {
      resolved = m;
    } else {
      try {
        resolved = m(host.currentContext() as RunCtx);
      } catch (e) {
        resolved = `(aharness: error computing awaitsOwnerText.messageToUser: ${(e as Error).message})`;
      }
    }
    awaitsOwnerText = { messageToUser: resolved };
  }

  return composeStateNudge({
    stateId,
    exits,
    entryPromptText,
    ...(awaitsOwnerText !== undefined ? { awaitsOwnerText } : {}),
  });
}

function resolveAwaitAsk(
  meta: import('../state/exits.js').AwaitExitDef['__aharnessCanonical'],
  ctx: RunCtx,
): string | undefined {
  if (meta?.kind !== 'await') return undefined;
  if (typeof meta.ask === 'string') return meta.ask;
  try {
    return meta.ask(ctx);
  } catch (e) {
    return `(aharness: error computing await ask: ${(e as Error).message})`;
  }
}

function terminalMetaById(machine: import('xstate').AnyStateMachine, stateId: string) {
  for (const node of iterStates(machine)) {
    if (stateKeyPath(node) !== stateId) continue;
    return getAharnessMeta(node);
  }
  return undefined;
}

function deriveUiFsmState(host: ActorHost): FsmState {
  const path = host.currentStateId();
  const meta = host.currentMeta();
  const context = host.currentContext() as RunCtx;
  const visits = context.__aharness_visitCount;
  const visitCount = visits !== undefined && typeof visits[path] === 'number' ? visits[path] : 0;
  const publicContext = stripInternalCtx(context);

  if (!meta || meta.kind !== 'stateful') {
    return {
      path,
      leaf: leafFromStatePath(path),
      kind: meta?.kind ?? 'final',
      exits: [],
      visitCount,
      context: publicContext,
    };
  }

  const exits: FsmState['exits'] = Object.entries(meta.exits).map(([name, def]) => ({
    name,
    kind: def.kind === 'await' ? 'await' : 'submit',
    ...('when' in def && Array.isArray(def.when) ? { branchCount: def.when.length } : {}),
  }));

  let awaitsOwnerText: { messageToUser: string } | undefined;
  if (meta.awaitsOwnerText !== undefined) {
    const message = meta.awaitsOwnerText.messageToUser;
    if (typeof message === 'string') {
      awaitsOwnerText = { messageToUser: message };
    } else {
      try {
        awaitsOwnerText = { messageToUser: message(context) };
      } catch (e) {
        awaitsOwnerText = {
          messageToUser: `(aharness: error computing awaitsOwnerText.messageToUser: ${
            (e as Error).message
          })`,
        };
      }
    }
  }

  let entryPrompt: string;
  try {
    entryPrompt = resolveEntryPrompt(meta.entryPrompt, context);
  } catch (e) {
    entryPrompt = `(aharness: error computing entryPrompt: ${(e as Error).message})`;
  }

  return {
    path,
    leaf: leafFromStatePath(path),
    kind: 'stateful',
    ...(awaitsOwnerText !== undefined ? { awaitsOwnerText } : {}),
    exits,
    visitCount,
    entryPrompt,
    context: publicContext,
  };
}

function stripInternalCtx(ctx: RunCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k.startsWith('__aharness_')) continue;
    if (k === 'aharness') continue;
    out[k] = v;
  }
  return out;
}

function leafFromStatePath(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] ?? path;
}

function readUiTurnId(turn: unknown): string | null {
  if (turn === null || typeof turn !== 'object') return null;
  const id = (turn as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function readUiFinishReason(turn: unknown): 'stop' | 'tool_calls' | 'length' | 'abort' {
  if (turn !== null && typeof turn === 'object') {
    const finishReason = (turn as { finishReason?: unknown }).finishReason;
    if (
      finishReason === 'stop' ||
      finishReason === 'tool_calls' ||
      finishReason === 'length' ||
      finishReason === 'abort'
    ) {
      return finishReason;
    }
  }
  return 'stop';
}

function isTerminal(host: ActorHost): boolean {
  return host.currentMeta()?.kind === 'terminal';
}

function isOpenState(host: ActorHost): boolean {
  const meta = host.currentMeta();
  return meta?.kind === 'stateful' && meta.open === true;
}

// ---------------------------------------------------------------------------
// Production defaults wired through `runCliForTest`'s hook fallbacks.
// ---------------------------------------------------------------------------

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

function pkgVersion(): string {
  // Lazy require avoids a static `import` that would pull a non-JS
  // file through tsc; the version is read at runtime when WS connect
  // happens. The fallback string handles bundles where the
  // package.json is not co-located with the dist tree (rare today;
  // worth defending against because `clientInfo.version` is
  // diagnostic only).
  try {
    // oxlint-disable-next-line typescript/no-require-imports
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
