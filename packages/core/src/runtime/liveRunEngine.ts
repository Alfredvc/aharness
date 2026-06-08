/**
 * Shared live-run engine for the production boot sequence.
 *
 * CLI and future programmatic adapters own presentation, argv parsing,
 * terminal/signal policy, and public result mapping. This module owns the
 * runtime sequence: verification, version gate, run artifacts, FSM loading,
 * auth precheck, normalized input handoff, actor startup, Codex app-server,
 * WebSocket routing, event publication, reply dispatch, hook socket, kickoff,
 * terminal completion, and shutdown.
 */
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';

import type { AppServerHandle, SpawnAppServerOptions } from '../appServer/index.js';
import type { VersionGateResult } from '../appServer/version.js';
import {
  escapeTomlBasicString,
  KIND_TO_SCRIPT_NAME,
  materializeHookScripts,
  renderHookCliOverride,
} from '../codexHome/index.js';
import type { JsonRpcClient, ServerRequestMeta } from '../jsonrpc/client.js';
import type { loadFsm } from '../loader/index.js';
import { METHOD } from '../protocol/methodNames.js';
import { SUBMIT_TOOL_NAME } from '../protocol/submitTool.js';
import { DAEMON_PROBE_CLIENT_NAME } from '../protocol/types.js';
import type {
  SkillsExtraRootsSetParams,
  SkillsExtraRootsSetResponse,
  SkillsListParams,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
} from '../protocol/index.js';
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  RequestUserInputQuestion,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnStartParams,
} from '../protocol/types.js';
import { writeArtifact } from '../artifact.js';
import { ownerChoiceRequestId } from '../ownerChoice.js';
import { deriveRunId, ensureRunDir } from '../run.js';
import {
  appEventToEnrichedRunEventAppendInput,
  compactRunEventPayload,
  createGitDiffRecordedEventSync,
  createGitSnapshotRecordedEventSync,
  createLiveRunEventPublisher,
  createRunEventQueryService,
  ownerChoicePendingRunEvent,
  type GitFactSyncExec,
  type GitSnapshotRecordedRunEventAppendInput,
  type RunEventAppendInput,
  type RunEventPayload,
  type RunEventRecorder,
  type RunEventWithOffset,
} from '../runEvents/index.js';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import { createAharnessOps, type AharnessOps } from '../state/aharnessOps.js';
import type {
  CodexSidecarAnswerPayload,
  CodexSidecarInput,
  CodexSidecarOps,
  CodexSidecarThread,
  CodexSidecarThreadOptions,
  CodexSidecarTurnOptions,
} from '../state/codexSidecar.js';
import { discoverDeclaredHookKinds } from '../state/discoverHooks.js';
import type { ClearOnEntryMeta } from '../state/exits.js';
import type { HookKind } from '../state/hooks.js';
import { createApprovalDispatcher } from '../transport/approvalDispatch.js';
import { buildDynamicToolsRegistration } from '../transport/dynamicToolsRegistration.js';
import { createItemCompletedWatcherRegistry } from '../transport/itemCompletedWatcher.js';
import {
  startNotificationRouter,
  type NotificationRouterHandle,
  type SubThreadCorrelation,
  type SubThreadNotification,
} from '../transport/notificationRouter.js';
import type { connectHeadlessWs } from '../transport/wsClient.js';
import type { RunCtx, RunDir, SchemaSidecar } from '../types.js';
import type { launchBrowser } from '../ui/browserLauncher.js';
import type { AppEvent, FsmState, Posture, ReplayableAppEvent, RunMeta } from '../ui/events.js';
import {
  createBrowserReplyController,
  type BrowserReplyController,
  type BrowserReplyResult,
} from '../ui/reply.js';
import { createUiEventLog } from '../ui/sse.js';
import type { startUiServer, UiServerHandle } from '../ui/server.js';
import { extractUiTopology } from '../ui/topology.js';

import { createActiveThreadBinding, type ActiveThreadBinding } from './activeThreadBinding.js';
import {
  DECLINED_ANSWER_TEXT,
  buildAbandonedDynamicToolCallResponse,
  buildAbandonedToolRequestUserInputResponse,
} from './abandonedThreadResponses.js';
import { ActorHost } from './actorHost.js';
import { CacheMetrics, type CacheMetricsSummary } from './cacheMetrics.js';
import {
  createCodexSidecarManager,
  type CodexSidecarManager,
  type CodexSidecarTimeoutClock,
} from './codexSidecar.js';
import { preflightStateModel } from './clearOnEntryModelPreflight.js';
import { resolveClearOnEntryOptions, resolveStateModelOptions } from './clearOnEntryCwd.js';
import { createContextSnapshotRecorder, publicContextFromRunContext } from './contextSnapshots.js';
import { scheduleCrossStateDance } from './crossStateDance.js';
import { createEventDispatcher } from './dispatchEvent.js';
import { createDriveForward, type DriveForwardHandle } from './driveForward.js';
import { activeChoiceData, commitOwnerChoice, validateOwnerChoiceReply } from './dispatchChoice.js';
import {
  createSubmitDispatcher,
  publicSubmitFailureMetadataSymbol,
  type PublicSubmitFailureMetadata,
  type SubmitFailureMetadataCarrier,
} from './dispatchSubmit.js';
import { performFreshClear } from './freshClear.js';
import {
  createPerStateHookDispatcher,
  type CanonicalBuiltinEventErrorInfo,
} from './hookDispatchers.js';
import { startHookSocket, type HookDispatchByType, type HookSocketHandle } from './hookSocket.js';
import { composeStateNudge, type ExitSpec } from './nudge.js';
import { PHASE1_OPT_OUT_METHODS } from './optOutNotificationMethods.js';
import { createPermissionRequestDispatcher } from './permissionRequest.js';
import { resolveEntryPrompt } from './resolvePrompt.js';
import { createActorRunInput } from './runInput.js';
import { makeSerializeDispatch } from './serializeDispatch.js';
import {
  createStateSkillInjectionService,
  type BuiltStateOrientationInput,
} from './skillInjection.js';
import {
  buildSkillCatalogPreflight,
  isSkillsListResponse,
  type ResolvedRuntimeSkill,
  validateSkillCatalog,
} from './skillCatalog.js';
import { createStateModelSettings } from './stateModelSettings.js';

const SIGINT_EXIT_CODE = 130;

export type LiveRunPermissionMode = 'autoReview' | 'ask' | 'yolo';

export interface LiveRunOwnerInputProvider {
  provideAnswers(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
  close?(): void;
}

export interface LiveRunReporter {
  runStarting(input: { readonly runId: string; readonly runRoot: string }): void;
  browserReady(input: { readonly url: string }): void;
  codexLaunching(): void;
  codexReady(input: { readonly threadId: string; readonly state: string }): void;
  transition(input: { readonly from: string; readonly exit: string; readonly to: string }): void;
  completed(input: { readonly state: string; readonly terminal: string }): void;
  failed(input: { readonly state?: string; readonly reason: string }): void;
}

function renderPermissionModeOverrides(
  mode: LiveRunPermissionMode,
): Array<readonly [string, string]> {
  switch (mode) {
    case 'autoReview':
      return [
        ['approval_policy', '"on-request"'],
        ['approvals_reviewer', '"auto_review"'],
      ];
    case 'ask':
      return [
        ['approval_policy', '"on-request"'],
        ['approvals_reviewer', '"user"'],
      ];
    case 'yolo':
      return [
        ['approval_policy', '"never"'],
        ['sandbox_mode', '"danger-full-access"'],
      ];
  }
}

export type LiveRunLoadedFsm = Awaited<ReturnType<typeof loadFsm>>;

export type LiveRunInputResult =
  | { readonly ok: true; readonly input?: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly diagnostic: string;
      readonly failureReason: string;
      readonly exitCode?: number;
    };

export type LiveRunAuthPrecheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly diagnostic: string;
      readonly failureReason: string;
      readonly exitCode: number;
    };

export interface LiveRunTargetMetadata {
  readonly filePath: string;
  readonly repoRoot: string;
}

export interface LiveRunUiOptions {
  readonly serve: boolean;
  readonly openBrowser?: boolean;
  readonly closeoutGraceMs?: number;
}

export interface LiveRunEngineResult {
  readonly exitCode: number;
  readonly runId?: string;
  readonly runDir?: string;
  readonly eventsPath?: string;
  readonly uiUrl?: string;
  readonly status?: 'completed' | 'failed' | 'cancelled';
  readonly terminalState?: string;
  readonly terminalOutcome?: string;
  readonly reason?: string;
}

interface LiveRunTerminalSignal {
  readonly exitCode?: number;
  readonly status?: 'completed' | 'failed' | 'cancelled';
  readonly terminalState?: string;
  readonly terminalOutcome?: string;
  readonly reason?: string;
}

export interface LiveRunCancellationRequest {
  readonly reason?: string;
}

export interface LiveRunCancellationSignal {
  current(): LiveRunCancellationRequest | null;
  subscribe(listener: (request: LiveRunCancellationRequest) => void): () => void;
}

export interface LiveRunReadyInfo {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
}

export interface LiveRunUiReadyInfo {
  readonly url: string;
}

export interface LiveRunEngineOptions {
  readonly target: LiveRunTargetMetadata;
  readonly verify: (o: {
    readonly fsmPath: string;
    readonly repoRoot: string;
  }) => Promise<{ readonly exitCode: number }>;
  readonly versionGate: () => Promise<VersionGateResult>;
  readonly loadFsm: (o: {
    readonly filePath: string;
    readonly repoRoot: string;
  }) => Promise<LiveRunLoadedFsm>;
  readonly authPrecheck: () => LiveRunAuthPrecheckResult;
  readonly resolveInput: (
    loaded: LiveRunLoadedFsm,
  ) => LiveRunInputResult | Promise<LiveRunInputResult>;
  readonly permissionMode?: LiveRunPermissionMode;
  readonly ui: LiveRunUiOptions;
  readonly diagnostics: NodeJS.WritableStream;
  readonly createReporter: (input: {
    readonly runId: string;
    readonly runRoot: string;
  }) => LiveRunReporter;
  readonly spawnAppServer: (opts: SpawnAppServerOptions) => Promise<AppServerHandle>;
  readonly connectHeadlessWs: typeof connectHeadlessWs;
  readonly startUiServer: typeof startUiServer;
  readonly launchBrowser?: typeof launchBrowser;
  readonly onUiEvent?: (event: ReplayableAppEvent) => void;
  readonly runEventRecorder?: RunEventRecorder;
  readonly gitFactSyncExec?: GitFactSyncExec;
  readonly onRunReady?: (info: LiveRunReadyInfo) => void;
  readonly onUiReady?: (info: LiveRunUiReadyInfo) => void;
  readonly beforeAppServerOpen?: () => void | Promise<void>;
  readonly onCanonicalAppend?: (entry: RunEventWithOffset) => void | Promise<void>;
  readonly onBrowserReplyController?: (controller: BrowserReplyController) => void;
  readonly onActiveThreadBinding?: (binding: ActiveThreadBinding) => void;
  readonly cancellation?: LiveRunCancellationSignal;
  readonly mockModelBaseUrl?: string;
  readonly ownerInputProvider?: LiveRunOwnerInputProvider;
  readonly observeIsAwaiting?: (value: boolean) => void;
  readonly readPendingOwnerInputRequestCount?: (read: () => number) => void;
  readonly startSignalHandlers?: (handlers: { readonly onSigint: () => Promise<void> }) => {
    readonly close: () => void;
  };
  readonly exitProcess?: (code: number) => void;
}

export async function runLiveRunEngine(o: LiveRunEngineOptions): Promise<LiveRunEngineResult> {
  // 1. Verify.
  const v = await o.verify({ fsmPath: o.target.filePath, repoRoot: o.target.repoRoot });
  if (v.exitCode !== 0) return { exitCode: v.exitCode };

  // 2. Version-gate codex.
  const ver = await o.versionGate();
  if (!ver.ok) {
    o.diagnostics.write(`aharness: ${ver.message ?? 'codex version check failed'}\n`);
    return { exitCode: 2 };
  }

  // 3. Resolve runDir. Every invocation mints a fresh `runId`; new-run
  //    UI/history/replay state is reconstructed from events.jsonl.
  const fsmAbs = o.target.filePath;
  const repoRoot = o.target.repoRoot;
  const runId = deriveRunId(fsmAbs);
  const finalRunDir = ensureRunDir(runId, repoRoot);
  let uiUrl: string | undefined;
  const result = (exitCode: number, terminal?: LiveRunTerminalSignal): LiveRunEngineResult => ({
    exitCode,
    runId: finalRunDir.runId,
    runDir: finalRunDir.root,
    eventsPath: finalRunDir.eventsPath,
    ...(uiUrl !== undefined ? { uiUrl } : {}),
    ...(terminal?.status !== undefined ? { status: terminal.status } : {}),
    ...(terminal?.terminalState !== undefined ? { terminalState: terminal.terminalState } : {}),
    ...(terminal?.terminalOutcome !== undefined
      ? { terminalOutcome: terminal.terminalOutcome }
      : {}),
    ...(terminal?.reason !== undefined ? { reason: terminal.reason } : {}),
  });
  const liveStdout = o.createReporter({
    runId: finalRunDir.runId,
    runRoot: finalRunDir.root,
  });
  const liveUiCloseoutGraceMs = o.ui.closeoutGraceMs ?? 0;
  liveStdout.runStarting({ runId: finalRunDir.runId, runRoot: finalRunDir.root });
  const runEventQueryService = createRunEventQueryService({
    runId: finalRunDir.runId,
    eventsPath: finalRunDir.eventsPath,
  });

  // 4. Load FSM (machine + sidecar + inputSchema / inputFlags).
  const loadFsmFn = o.loadFsm;
  let loaded: Awaited<ReturnType<typeof loadFsmFn>>;
  try {
    loaded = await loadFsmFn({ filePath: fsmAbs, repoRoot });
  } catch (e) {
    const message = `failed to load FSM: ${(e as Error).message}`;
    o.diagnostics.write(`aharness: ${message}\n`);
    liveStdout.failed({ reason: message });
    return result(2);
  }
  const machine = loaded.machine;
  const sidecar = loaded.sidecar;

  // 5. Auth precheck.
  const auth = o.authPrecheck();
  if (!auth.ok) {
    o.diagnostics.write(auth.diagnostic);
    liveStdout.failed({ reason: auth.failureReason });
    return result(auth.exitCode);
  }

  // 6. Resolve adapter-normalized input.
  const inputResult = await o.resolveInput(loaded);
  if (!inputResult.ok) {
    o.diagnostics.write(inputResult.diagnostic);
    liveStdout.failed({ reason: inputResult.failureReason });
    return result(inputResult.exitCode ?? 2);
  }
  const resolvedInput = inputResult.input;

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
  const actorInput = createActorRunInput(finalRunDir.runId, finalRunDir, resolvedInput);
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
  o.onActiveThreadBinding?.(activeThreadBinding);
  const topology = extractUiTopology(machine, { sidecar });
  const uiEventLog = createUiEventLog({
    run: runMeta,
    topology,
  });
  const livePublisher = createLiveRunEventPublisher({
    runDir: finalRunDir,
    runMeta,
    uiEventLog,
    stderr: o.diagnostics,
    onCanonicalAppend: (entry) => {
      const result = runEventQueryService.acceptAppend(entry);
      if (!result.ok) {
        o.diagnostics.write(
          `aharness: live run-event index rejected ${entry.event.id}: ${result.diagnostic.code}: ${result.diagnostic.message}\n`,
        );
      }
      void o.onCanonicalAppend?.(entry);
    },
    ...(o.onUiEvent !== undefined ? { onUiEvent: o.onUiEvent } : {}),
    ...(o.runEventRecorder !== undefined ? { recorder: o.runEventRecorder } : {}),
  });
  const contextRecorder = createContextSnapshotRecorder({
    host,
    record: (input) => livePublisher.record(input),
  });
  const closeContextRecorder = (): void => {
    contextRecorder.close();
  };
  const publishUiEvent = (event: Parameters<typeof uiEventLog.publish>[0]): ReplayableAppEvent => {
    return livePublisher.publish(event);
  };
  const recordRunEvent = (input: RunEventAppendInput): void => {
    void livePublisher.record(input);
  };
  const publishUiEventNonRecording = (
    event: Parameters<typeof uiEventLog.publish>[0],
  ): ReplayableAppEvent => {
    return livePublisher.publishNonRecording(event);
  };
  const recordAndPublishUiEvent = (
    input: RunEventAppendInput | null,
    event: Parameters<typeof uiEventLog.publish>[0],
  ): ReplayableAppEvent => {
    if (input !== null) recordRunEvent(input);
    return publishUiEventNonRecording(event);
  };
  const recordGitSnapshot = (
    phase: 'start' | 'terminal',
  ): GitSnapshotRecordedRunEventAppendInput => {
    try {
      const event = createGitSnapshotRecordedEventSync({
        cwd: repoRoot,
        phase,
        ...(o.gitFactSyncExec !== undefined ? { exec: o.gitFactSyncExec } : {}),
      });
      recordRunEvent(event);
      return event;
    } catch {
      const event: GitSnapshotRecordedRunEventAppendInput = {
        type: 'git.snapshot.recorded',
        data: { phase, status: 'unavailable', reason: 'probe-failed' },
      };
      recordRunEvent(event);
      return event;
    }
  };
  const recordGitDiff = (
    from: GitSnapshotRecordedRunEventAppendInput,
    to: GitSnapshotRecordedRunEventAppendInput,
  ): void => {
    try {
      recordRunEvent(
        createGitDiffRecordedEventSync({
          cwd: repoRoot,
          from,
          to,
          ...(o.gitFactSyncExec !== undefined ? { exec: o.gitFactSyncExec } : {}),
        }),
      );
    } catch {
      recordRunEvent({
        type: 'git.diff.recorded',
        data: { status: 'unavailable', reason: 'probe-failed' },
      });
    }
  };
  o.onRunReady?.({
    runId: finalRunDir.runId,
    runDir: finalRunDir.root,
    eventsPath: finalRunDir.eventsPath,
  });
  livePublisher.publishRunStarted();
  const startGitSnapshot = recordGitSnapshot('start');
  let finalRunEventPublished = false;
  const recordTerminalGitFactsOnce = (): void => {
    const terminalGitSnapshot = recordGitSnapshot('terminal');
    recordGitDiff(startGitSnapshot, terminalGitSnapshot);
  };
  const publishRunFailedOnce = (message: string): void => {
    if (finalRunEventPublished) return;
    finalRunEventPublished = true;
    liveStdout.failed({ state: host.currentStateId(), reason: message });
    recordTerminalGitFactsOnce();
    livePublisher.publishRunFailed(message);
  };
  const publishPostureChange = (posture: Partial<Posture>): void => {
    publishUiEvent({
      kind: 'PostureChange',
      posture,
    });
  };
  const currentCancellation = (): LiveRunCancellationRequest | null =>
    o.cancellation?.current() ?? null;
  const cancellationTerminalSignal = (
    request: LiveRunCancellationRequest,
  ): LiveRunTerminalSignal => ({
    exitCode: SIGINT_EXIT_CODE,
    status: 'cancelled',
    terminalState: host.currentStateId(),
    terminalOutcome: 'cancelled',
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  });
  const publishRunCancelledOnce = (request: LiveRunCancellationRequest): void => {
    if (finalRunEventPublished) return;
    finalRunEventPublished = true;
    recordTerminalGitFactsOnce();
    livePublisher.publishRunCancelled({
      state: host.currentStateId(),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    });
    publishPostureChange({
      isTerminal: true,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
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
  };
  const isPendingFreshClearDrainThread = (threadId: string): boolean =>
    pendingFreshClearThreadIds.has(threadId);
  const isTrueAbandonedParentThread = (threadId: string): boolean =>
    activeThreadBinding.isAbandoned(threadId) && !isPendingFreshClearDrainThread(threadId);
  const isThreadUnavailableForRequests = (threadId: string): boolean =>
    isPendingFreshClearDrainThread(threadId) || isTrueAbandonedParentThread(threadId);
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
  const sidecarTimeoutClock = createThreadScopedPausableTimeoutClock();
  const sidecarManagerRef: { current?: CodexSidecarManager } = {};
  const isSidecarThreadId = (threadId: string): boolean =>
    sidecarManagerRef.current?.ownsThread(threadId) === true;
  const isRunRoutableThreadId = (threadId: string): boolean =>
    isLiveThreadId(threadId) || isSidecarThreadId(threadId);
  const publishAbandonedThreadParamsDiagnostic = (
    params: unknown,
    source: string,
    message: string,
  ): void => {
    const threadId = readThreadIdParam(params);
    if (threadId === null || !isTrueAbandonedParentThread(threadId)) return;
    publishAbandonedThreadDiagnostic({ threadId, source, message });
  };
  const publishUnavailableRequestThreadParamsDiagnostic = (
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
  contextRecorder.recordInitialContext();
  contextRecorder.start();
  publishOpenPosture();
  // Phase 3c reply path. The UI server starts before the WebSocket
  // thread exists, so the callbacks close over late-bound `client` and
  // the active-thread binding initialized after thread/start resolves.
  // oxlint-disable-next-line prefer-const
  let client: JsonRpcClient | undefined;
  let terminalResolve!: (v: LiveRunTerminalSignal | null) => void;
  const terminalPromise = new Promise<LiveRunTerminalSignal | null>((res) => {
    terminalResolve = res;
  });
  const shutdownAfterTerminal: { current?: () => Promise<void> } = {};
  let fatalShutdownRequested = false;
  const failRunAndShutdown = (message: string): void => {
    if (fatalShutdownRequested) return;
    fatalShutdownRequested = true;
    publishRunFailedOnce(message);
    const shutdown = shutdownAfterTerminal.current;
    void afterLiveUiCloseoutGrace(async () => {
      await shutdown?.();
    })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        o.diagnostics.write(`aharness: shutdown after run failure failed: ${err.message}\n`);
      })
      .finally(() => {
        terminalResolve({ exitCode: 1 });
      });
  };
  let stateModelFailureReported = false;
  let stateModelFailureError: Error | undefined;
  const reportStateModelError = (error: Error): void => {
    stateModelFailureError = error;
    if (!stateModelFailureReported) {
      stateModelFailureReported = true;
      o.diagnostics.write(`aharness: state model settings failure: ${error.message}\n`);
    }
  };
  const failRunForStateModelError = (error: Error): void => {
    reportStateModelError(error);
    failRunAndShutdown('state-model update failed; shutting down');
  };
  const serializeDispatchQueue = makeSerializeDispatch();
  const dispatchExecutionContext = new AsyncLocalStorage<boolean>();
  const serializeDispatch = <T>(fn: () => Promise<T>): Promise<T> => {
    if (dispatchExecutionContext.getStore() === true) return fn();
    return serializeDispatchQueue(() => dispatchExecutionContext.run(true, fn));
  };
  const stateModelSettings = createStateModelSettings({
    client: {
      request: <T>(method: string, params: unknown) => {
        if (!client) throw new Error('internal: client unbound for state-model settings');
        const p = client.request<T>(method, params);
        return p;
      },
    },
    activeThreadBinding,
    onFatal: reportStateModelError,
  });
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
    const terminalState = host.currentStateId();
    const terminalMeta = host.currentMeta();
    const terminalOutcome = terminalMeta?.kind === 'terminal' ? terminalMeta.outcome : 'unknown';
    if (!finalRunEventPublished) {
      finalRunEventPublished = true;
      recordTerminalGitFactsOnce();
      liveStdout.completed({
        state: terminalState,
        terminal: terminalOutcome,
      });
      livePublisher.publishRunTerminal({
        state: terminalState,
        terminal: terminalOutcome,
      });
    }
    publishPostureChange({ isTerminal: true });
    const complete = async (): Promise<void> => {
      await afterLiveUiCloseoutGrace(async () => {
        await shutdownAfterTerminal.current?.();
      });
      terminalResolve({ terminalState, terminalOutcome });
    };
    if (meta) meta.afterReply(complete);
    else void complete();
  };

  const reportCanonicalBuiltinEventError = (info: CanonicalBuiltinEventErrorInfo): void => {
    o.diagnostics.write(
      `aharness: canonical ${info.eventName} ${info.phase} handler for state '${info.stateId}' branch ${info.branchIndex} threw: ${info.error.message}\n`,
    );
  };

  async function handleCommittedRuntimeTransition(
    info: {
      readonly from: string;
      readonly to: string;
      readonly oldThreadId?: string;
      readonly oldTurnId?: string;
      readonly afterReply?: (callback: () => void | Promise<void>) => void;
    },
    cause: Extract<AppEvent, { kind: 'StateChange' }>['cause'],
  ): Promise<void> {
    liveStdout.transition({ from: info.from, exit: cause, to: info.to });
    publishUiEvent({
      kind: 'StateChange',
      from: info.from,
      to: info.to,
      cause,
      newState: deriveUiFsmState(host),
    });
    publishOpenPosture();
    await runActiveOnEntry();
    scheduleFreshClearAfterTransition(info);
    publishActiveOwnerChoicePending();
  }

  function publishActiveOwnerChoicePending(): void {
    if (host.currentMeta()?.kind !== 'choice') return;
    const data = activeChoiceData(host);
    if (!data.ok) {
      failRunAndShutdown(`choice question failed: ${data.error}`);
      return;
    }
    recordRunEvent(
      ownerChoicePendingRunEvent({
        state: data.state,
        visitCount: data.visitCount,
        question: data.question,
        options: data.labels.map((label) => ({ label })),
      }),
    );
  }

  const permissionRequestDispatch = createPermissionRequestDispatcher({
    host,
    ops: opsHandle.ops,
    writeFinalArtifacts: (terminalStateId, context) =>
      writeActiveFinalArtifacts(terminalStateId, context),
    isTerminalState: (stateId) => terminalMetaById(machine, stateId)?.kind === 'terminal',
    onTerminal: () => signalTerminalCompletion(),
    onCanonicalEventError: reportCanonicalBuiltinEventError,
    onCommittedTransition: (info) => {
      void handleCommittedRuntimeTransition(info, 'always');
    },
    onAuthorHandlerError: ({ stateId, matcher, error }) => {
      o.diagnostics.write(
        `aharness: PermissionRequest hook for state '${stateId}' matcher '${matcher}' threw: ${error.message}\n`,
      );
    },
  });
  const approvalDispatcher = createApprovalDispatcher({
    publish: (event) => {
      if (event.kind === 'FrameworkNote') {
        publishUiEvent(event);
        return;
      }
      publishUiEventNonRecording(event);
    },
    record: recordRunEvent,
    isRoutableThread: isRunRoutableThreadId,
    isPermissionHookThread: isLiveThreadId,
    onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
    onBrowserRequestPending: (request) => {
      if (!isSidecarThreadId(request.threadId)) return undefined;
      return sidecarTimeoutClock.pauseThread(request.threadId);
    },
    permissionRequest: (event, meta) =>
      serializeDispatch(() => permissionRequestDispatch(event, meta)),
  });
  const recordedOwnerInputResolutions = new Set<string>();
  const recordOwnerInputRequestResolved = (requestId: string, raw?: RunEventPayload): void => {
    if (recordedOwnerInputResolutions.has(requestId)) return;
    recordedOwnerInputResolutions.add(requestId);
    recordRunEvent({
      type: 'request.resolved',
      requestId,
      data: { requestId, kind: 'owner-input', status: 'resolved' },
      ...(raw !== undefined ? { raw } : {}),
    });
  };
  const browserReplyController = createBrowserReplyController({
    isOpen: () => isOpenState(host),
    sendUserPrompt: async (text) => {
      const threadId = activeThreadBinding.current();
      if (!client || threadId === undefined) {
        throw new Error('browser reply path is not ready');
      }
      try {
        await stateModelSettings.waitForSettled();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        failRunForStateModelError(err);
        throw err;
      }
      await client.request(METHOD.turnStart, {
        threadId,
        input: [{ type: 'text', text }],
      } satisfies TurnStartParams);
    },
    isAbandonedThread: isThreadUnavailableForRequests,
    onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
    onOwnerInputResolved: (requestId) => {
      recordOwnerInputRequestResolved(requestId);
      publishUiEventNonRecording({ kind: 'OwnerInputResolved', id: requestId });
    },
    handleApprovalReply: (payload) => approvalDispatcher.handleBrowserReply(payload),
    handleOwnerChoiceReply: (payload) =>
      serializeDispatch(async () => {
        const validation = validateOwnerChoiceReply(host, payload);
        if (!validation.ok) {
          return {
            status: validation.status,
            body: {
              error: validation.error,
              ...(validation.message !== undefined ? { message: validation.message } : {}),
            },
          };
        }
        const committed = await commitOwnerChoice(host, {
          state: validation.state,
          label: validation.label,
          ops: opsHandle.ops,
        });
        if (!committed.ok) {
          return {
            status: committed.status,
            body: {
              error: committed.error,
              ...(committed.message !== undefined ? { message: committed.message } : {}),
            },
          };
        }
        if (host.currentMeta()?.kind === 'passive') {
          await host.waitForSnapshot(() => host.currentMeta()?.kind !== 'passive');
        }
        const to = host.currentStateId();
        if (host.currentMeta()?.kind === 'terminal') {
          await writeActiveFinalArtifacts(to);
        }
        liveStdout.transition({ from: committed.from, exit: 'choice', to });
        publishUiEvent({
          kind: 'StateChange',
          from: committed.from,
          to,
          cause: 'choice',
          newState: deriveUiFsmState(host),
        });
        publishOpenPosture();
        await runActiveOnEntry();
        scheduleFreshClearAfterTransition({ from: committed.from, to });
        publishActiveOwnerChoicePending();
        if (host.currentMeta()?.kind === 'terminal') {
          setImmediate(() => signalTerminalCompletion());
        } else if (
          host.currentMeta()?.kind === 'stateful' &&
          !isOpenState(host) &&
          !currentStateDeclaresClearOnEntry(host)
        ) {
          scheduleStatefulOrientationAfterReply();
        }
        return { status: 200, body: { ok: true } };
      }),
    onReplySubmitted: (input) => {
      recordRunEvent(replySubmittedRunEvent(input));
    },
    onReplyResolved: (input) => {
      recordRunEvent(replyResolvedRunEvent(input));
    },
  });
  const handleBrowserReply = async (payload: unknown): Promise<BrowserReplyResult> => {
    const cancellation = currentCancellation();
    if (cancellation !== null) {
      return {
        status: 409,
        body: {
          error: 'run-closed',
          status: 'cancelled',
          ...(cancellation.reason !== undefined ? { reason: cancellation.reason } : {}),
        },
      };
    }
    return browserReplyController.handleReply(payload);
  };
  const externallyVisibleBrowserReplyController: BrowserReplyController = {
    parkOwnerInput: (params) => browserReplyController.parkOwnerInput(params),
    abandonInactiveOwnerInput: () => browserReplyController.abandonInactiveOwnerInput(),
    close: () => browserReplyController.close(),
    handleReply: handleBrowserReply,
  };
  o.onBrowserReplyController?.(externallyVisibleBrowserReplyController);
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
    if (typeof params.threadId === 'string' && isPendingFreshClearDrainThread(params.threadId)) {
      return;
    }
    if (typeof params.threadId === 'string' && isTrueAbandonedParentThread(params.threadId)) {
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
      const event: AppEvent = {
        kind: 'AgentMessageDelta',
        id:
          typeof params.itemId === 'string'
            ? params.itemId
            : typeof params.turnId === 'string'
              ? params.turnId
              : 'agent-message',
        delta,
      };
      recordAndPublishUiEvent(
        appEventToEnrichedRunEventAppendInput(event, {
          ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
          ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
          raw: { params: p },
          meta: { source: METHOD.agentMessageDelta },
        }),
        event,
      );
    }
  };
  const rawResponseCallNames = new Map<string, string>();
  const threadItemToolNames = new Map<string, string>();
  const cacheMetrics = new CacheMetrics();
  const publishThreadItemStartedForUi = (item: unknown, params?: unknown): void => {
    recordRunEvent(
      threadItemRunEvent('started', params, item, {
        toolNames: threadItemToolNames,
        subThreadCorrelation: (threadId) =>
          notificationRouter.current?.getSubThreadCorrelation(threadId),
      }),
    );
    const event = threadItemStartedEventForUi(item);
    if (!event) return;
    if (event.type === 'function_call') {
      threadItemToolNames.set(event.id, event.name);
    }
    publishUiEventNonRecording(event);
  };
  const publishThreadItemCompletedForUi = (item: unknown, params?: unknown): void => {
    recordRunEvent(
      threadItemRunEvent('completed', params, item, {
        toolNames: threadItemToolNames,
        subThreadCorrelation: (threadId) =>
          notificationRouter.current?.getSubThreadCorrelation(threadId),
      }),
    );
    const event = threadItemCompletedEventForUi(item, threadItemToolNames);
    if (!event) return;
    publishUiEventNonRecording(event);
  };
  const publishRawResponseItemForUi = (params: unknown): void => {
    const input = rawResponseItemRunEvent(params, rawResponseCallNames);
    if (input !== null) recordRunEvent(input);
    const event = rawResponseItemEventForUi(params, rawResponseCallNames);
    if (!event) return;
    publishUiEventNonRecording(event);
  };
  const notificationRouter: { current?: NotificationRouterHandle } = {};

  let uiServer: UiServerHandle | undefined;
  const uiToken = randomBytes(18).toString('base64url');
  const closeUiServer = async (): Promise<void> => {
    const handle = uiServer;
    uiServer = undefined;
    if (handle) await handle.close();
  };
  const waitForLiveUiCloseoutGrace = runOnce(async (): Promise<void> => {
    if (uiServer === undefined || liveUiCloseoutGraceMs <= 0) return;
    await delay(liveUiCloseoutGraceMs);
  });
  const afterLiveUiCloseoutGrace = async (close: () => Promise<void>): Promise<void> => {
    await waitForLiveUiCloseoutGrace();
    await close();
  };
  if (o.ui.serve) {
    try {
      uiServer = await o.startUiServer({
        host: '127.0.0.1',
        port: 0,
        uiToken,
        replyHandler: handleBrowserReply,
        runScoped: {
          activeRunId: finalRunDir.runId,
          service: runEventQueryService,
          getRunMeta: () => ({ ...runMeta }),
          topology,
        },
      });
      const browserUrl = urlWithUiBootParams(uiServer.url, {
        token: uiToken,
        runId: finalRunDir.runId,
      });
      uiUrl = browserUrl;
      liveStdout.browserReady({ url: browserUrl });
      o.onUiReady?.({ url: browserUrl });
    } catch (e) {
      const message = `UI server failed: ${(e as Error).message}`;
      o.diagnostics.write(`aharness: ${message}\n`);
      publishRunFailedOnce(message);
      closeContextRecorder();
      return result(1);
    }
  }

  // Unless suppressed by --no-open, auto-launch the browser as soon
  // as the UI server is bound. The pre-React boot screen and BootSkeleton
  // give the user visual feedback while codex spawns, the WS handshake
  // completes, and `thread/start` resolves. Without this, the user stares
  // at an empty terminal for several seconds before the browser window
  // even appears.
  if (o.ui.serve && o.ui.openBrowser && uiServer !== undefined && o.launchBrowser) {
    const launchResult = o.launchBrowser(
      urlWithUiBootParams(uiServer.url, {
        token: uiToken,
        runId: finalRunDir.runId,
      }),
    );
    if (!launchResult.ok) {
      o.diagnostics.write(`aharness: failed to launch browser: ${launchResult.message}\n`);
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
  const prepareStateModelApplyForActiveState = ():
    | ReturnType<typeof stateModelSettings.prepareApplyForActiveState>
    | undefined => {
    const meta = host.currentMeta();
    if (
      meta === undefined ||
      meta.kind !== 'stateful' ||
      Object.prototype.hasOwnProperty.call(meta, 'clearOnEntry')
    ) {
      return undefined;
    }

    const stateModel = resolveStateModelOptions(meta.model);
    if (stateModel.model === undefined && stateModel.effort === undefined) {
      return undefined;
    }

    return stateModelSettings.prepareApplyForActiveState({
      stateId: host.currentStateId(),
      ...(stateModel.model !== undefined ? { model: stateModel.model } : {}),
      ...(stateModel.effort !== undefined ? { effort: stateModel.effort } : {}),
    });
  };
  const applyStateModelForActiveState = async (): Promise<void> => {
    await prepareStateModelApplyForActiveState()?.apply();
  };
  const skillInjectionRef: {
    current?: ReturnType<typeof createStateSkillInjectionService>;
  } = {};
  const composeActiveStateTurnInput = (): BuiltStateOrientationInput => {
    const skillInjection = skillInjectionRef.current;
    if (skillInjection === undefined) {
      throw new Error('internal: skill injection service unbound');
    }
    const stateId = host.currentStateId();
    const meta = host.currentMeta();
    if (!meta || meta.kind !== 'stateful') {
      throw new Error(`composeActiveStateTurnInput called on non-stateful leaf '${stateId}'`);
    }
    const orientation = composeActiveStateNudge(host, sidecar);
    publishOrientationNote(orientation);
    return skillInjection.buildTurnInputForActive({
      stateId,
      ...(meta.skills !== undefined ? { skills: meta.skills } : {}),
      orientationText: orientation,
    });
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
      const pending = prepareStateModelApplyForActiveState();
      if (pending !== undefined) {
        const applyPending = async (): Promise<void> => {
          try {
            await pending.apply();
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            failRunForStateModelError(err);
          }
        };
        const scheduleApply = (): void => {
          void serializeDispatch(applyPending);
        };
        if (info.afterReply !== undefined) {
          info.afterReply(scheduleApply);
        } else {
          scheduleApply();
        }
      }
      return;
    }
    const targetStateId = host.currentStateId();
    const postTransitionContext = host.currentContext() as RunCtx;
    const clearOnEntry = meta.clearOnEntry as ClearOnEntryMeta;
    const stateModel = resolveStateModelOptions(meta.model);
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
      if (!c) {
        const message = 'fresh clear failed: internal: client unbound at fresh-clear time';
        o.diagnostics.write(`aharness: ${message}\n`);
        publishRunFailedOnce(message);
        void afterLiveUiCloseoutGrace(async () => {
          await shutdownAfterTerminal.current?.();
        }).finally(() => {
          terminalResolve({ exitCode: 1 });
        });
        return;
      }
      void serializeDispatch(async () => {
        const clearOptions = resolveClearOnEntryOptions({
          clearOnEntry,
          context: postTransitionContext,
          defaultCwd: repoRoot,
          stateId: targetStateId,
        });
        await preflightStateModel({
          client: c,
          stateId: targetStateId,
          cwd: clearOptions.cwd,
          ...(stateModel.model !== undefined ? { model: stateModel.model } : {}),
          ...(stateModel.effort !== undefined ? { effort: stateModel.effort } : {}),
        });
        const boundary = await performFreshClear({
          client: c,
          activeThreadBinding,
          ...(info.oldTurnId !== undefined ? { oldTurnId: info.oldTurnId } : {}),
          cwd: clearOptions.cwd,
          ...(stateModel.model !== undefined ? { model: stateModel.model } : {}),
          ...(stateModel.effort !== undefined ? { reasoningEffort: stateModel.effort } : {}),
          waitForSettled: () => stateModelSettings.waitForSettled(),
          dynamicTools: buildDynamicToolsRegistration(),
          composeActiveStateNudge: () => composeActiveStateTurnInput().text,
          composeActiveStateTurnInput,
          resetSkillInjectionForFreshThread: () => skillInjectionRef.current?.resetForFreshThread(),
          onCleanupError: (error) => {
            o.diagnostics.write(`aharness: fresh clear cleanup warning: ${error.message}\n`);
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
        pendingFreshClearThreadIds.delete(boundary.previousThreadId);
      }).catch((error: unknown) => {
        const message = `fresh clear failed: ${(error as Error).message}`;
        o.diagnostics.write(`aharness: ${message}\n`);
        publishRunFailedOnce(message);
        void afterLiveUiCloseoutGrace(async () => {
          await shutdownAfterTerminal.current?.();
        }).finally(() => {
          terminalResolve({ exitCode: 1 });
        });
      });
    });
  }

  function scheduleStatefulOrientationAfterReply(): void {
    setImmediate(() => {
      void (async () => {
        if (!client) throw new Error('internal: client unbound for owner-choice orientation');
        await stateModelSettings.waitForSettled();
        const built = composeActiveStateTurnInput();
        await client.request(METHOD.turnStart, {
          threadId: activeThreadBinding.require(),
          input: built.input,
        } satisfies TurnStartParams);
        built.commit();
      })().catch((error: unknown) => {
        const message = `owner-choice orientation failed: ${(error as Error).message}`;
        o.diagnostics.write(`aharness: ${message}\n`);
        failRunAndShutdown(message);
      });
    });
  }

  // Owner-input ServerRequest wiring.
  //
  // `pendingOwnerInputRequestCount` is the number of parked
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
  let pendingOwnerInputRequestCount = 0;
  const browserOwnerInputProvider = createBrowserOwnerInputProvider({
    controller: browserReplyController,
    publishUiEvent: publishUiEventNonRecording,
  });
  const ownerInputProvider: LiveRunOwnerInputProvider =
    o.ownerInputProvider ?? browserOwnerInputProvider;
  // `isAwaiting` is read by drive-forward AND by the `_testObserveIsAwaiting`
  // hook (count-ordering test). The wrapper invokes the test observer
  // AFTER reading the count so the test sees the same boolean the
  // production code consumes.
  const isAwaiting = (): boolean => {
    const v = pendingOwnerInputRequestCount > 0;
    o.observeIsAwaiting?.(v);
    return v;
  };
  // The count-read seam below lets tests poll the number of parked
  // owner-input requests directly across the run.
  o.readPendingOwnerInputRequestCount?.(() => pendingOwnerInputRequestCount);
  async function runActiveOnEntry(): Promise<void> {
    const meta = host.currentMeta();
    if (!meta || meta.kind !== 'stateful' || meta.onEntry === undefined) return;
    try {
      await meta.onEntry(host.currentContext(), opsHandle.ops);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      o.diagnostics.write(
        `aharness: onEntry hook for state '${host.currentStateId()}' threw: ${msg}\n`,
      );
    }
  }

  const dispatch = createSubmitDispatcher({
    host,
    machine,
    sidecar,
    applyStateModel: applyStateModelForActiveState,
    onTerminal: (_terminalStateId, meta) => signalTerminalCompletion(meta),
    onTransition: (info) => {
      liveStdout.transition(info);
      publishUiEvent({
        kind: 'StateChange',
        from: info.from,
        to: info.to,
        cause: 'submit',
        newState: deriveUiFsmState(host),
      });
      publishOpenPosture();
      publishActiveOwnerChoicePending();
    },
    composeActiveStateNudge: () => composeActiveStateNudge(host, sidecar),
    composeActiveStateTurnInput,
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
      if (a.orientationInput === undefined) {
        publishOrientationNote(a.orientationText);
      }
      scheduleCrossStateDance({
        ...a,
        applyStateModel: applyStateModelForActiveState,
        client,
        activeThreadBinding,
        watcherRegistry,
        markSubmittedThisTurn,
        clearSubmittedThisTurn,
        onError: (error) => {
          o.diagnostics.write(`aharness: cross-state dance failed: ${error.message}\n`);
        },
        onStateModelFailure: failRunForStateModelError,
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
  const mockModelBaseUrl = process.env['AHARNESS_MOCK_MODEL_BASE_URL'] ?? o.mockModelBaseUrl;
  const permissionMode = o.permissionMode ?? 'autoReview';
  const cliOverrides = renderPermissionModeOverrides(permissionMode);
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

  let appServer: AppServerHandle | undefined;
  let hookSocket: HookSocketHandle | undefined;
  const closeHookSocket = async (): Promise<void> => {
    const handle = hookSocket;
    hookSocket = undefined;
    if (handle) await handle.close();
  };
  const closeReplySurfaces = (): void => {
    browserReplyController.close();
    approvalDispatcher.close();
  };
  const closeOpenedResources = runOnce(async (): Promise<void> => {
    closeContextRecorder();
    notificationRouter.current?.close();
    await closeHookSocket();
    closeReplySurfaces();
    await closeUiServer();
    const currentClient = client;
    const currentAppServer = appServer;
    if (currentClient !== undefined && currentAppServer !== undefined) {
      await runShutdown({
        appServer: currentAppServer,
        client: currentClient,
        runDir: finalRunDir,
        ...(sidecarManagerRef.current !== undefined
          ? { sidecarManager: sidecarManagerRef.current }
          : {}),
        ownerInputProvider,
      });
      return;
    }
    try {
      await currentClient?.close();
    } catch {
      /* best-effort */
    }
    if (currentAppServer !== undefined) {
      await currentAppServer.close();
    }
    try {
      ownerInputProvider.close?.();
    } catch {
      /* best-effort */
    }
    cleanupRunSockets(finalRunDir);
  });
  let cancellationShutdown: Promise<LiveRunTerminalSignal> | null = null;
  const cancelRun = (request: LiveRunCancellationRequest): Promise<LiveRunTerminalSignal> => {
    cancellationShutdown ??= (async () => {
      closeReplySurfaces();
      publishRunCancelledOnce(request);
      await afterLiveUiCloseoutGrace(closeOpenedResources);
      return cancellationTerminalSignal(request);
    })();
    return cancellationShutdown;
  };
  const cancelledResult = async (
    request: LiveRunCancellationRequest,
  ): Promise<LiveRunEngineResult> => {
    const terminal = await cancelRun(request);
    return result(terminal.exitCode ?? SIGINT_EXIT_CODE, terminal);
  };
  const maybeReturnCancelled = async (): Promise<LiveRunEngineResult | null> => {
    const request = currentCancellation();
    if (request === null) return null;
    return cancelledResult(request);
  };
  const cancelledBeforeAppServer = await maybeReturnCancelled();
  if (cancelledBeforeAppServer !== null) return cancelledBeforeAppServer;

  await o.beforeAppServerOpen?.();

  // `onRunReady`/`onUiReady` can make a programmatic handle visible before this point.
  // Re-read synchronously, with no await on the null path, immediately before
  // opening Codex resources.
  const cancellationAtAppServerOpen = currentCancellation();
  if (cancellationAtAppServerOpen !== null) {
    return cancelledResult(cancellationAtAppServerOpen);
  }

  try {
    liveStdout.codexLaunching();
    appServer = await o.spawnAppServer({
      sockPath,
      cliOverrides,
      enabledFeatures: ['default_mode_request_user_input'],
    });
  } catch (e) {
    const cancelled = await maybeReturnCancelled();
    if (cancelled !== null) return cancelled;
    const message = `app-server failed: ${(e as Error).message}`;
    o.diagnostics.write(`aharness: ${message}\n`);
    publishRunFailedOnce(message);
    await afterLiveUiCloseoutGrace(async () => {
      closeContextRecorder();
      await closeUiServer();
    });
    return result(1);
  }
  const cancelledAfterAppServer = await maybeReturnCancelled();
  if (cancelledAfterAppServer !== null) return cancelledAfterAppServer;

  // 10. Connect WS — register the dispatcher inside `registerHandlers`
  //     before the initialize handshake (M18 invariant, spec §3 step 7).
  let wsHandle: Awaited<ReturnType<typeof connectHeadlessWs>>;
  const connectWs = o.connectHeadlessWs;
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
          const requestThreadId = readThreadIdParam(params);
          if (requestThreadId !== null && isSidecarThreadId(requestThreadId)) {
            return {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: 'aharness: sidecar threads cannot call aharness dynamic tools.',
                },
              ],
            } satisfies DynamicToolCallResponse;
          }
          const abandonedResponse = () => {
            publishUnavailableRequestThreadParamsDiagnostic(
              params,
              'dynamicToolCall',
              'dynamic tool call ignored for abandoned thread',
            );
            return buildAbandonedDynamicToolCallResponse();
          };
          if (!isLiveThreadParams(params)) {
            return abandonedResponse();
          }
          const dynamicParams = isDynamicToolCallParams(params) ? params : null;
          if (dynamicParams !== null) {
            recordRunEvent(dynamicToolCallRunEvent(dynamicParams));
          }
          return serializeDispatch(async () => {
            if (!isLiveThreadParams(params)) return abandonedResponse();
            const response = await dispatchIfSubmit(
              params as DynamicToolCallParams,
              meta,
              dispatch,
            );
            if (dynamicParams !== null) {
              recordRunEvent(dynamicToolResultRunEvent(dynamicParams, response));
            }
            return response;
          });
        });
        // Park the codex-built-in `request_user_input`
        // ServerRequest. The handler narrows malformed params, increments
        // `pendingOwnerInputRequestCount` BEFORE awaiting the provider (so the
        // drive-forward `isAwaiting` predicate observes the park), then
        // forwards the questions array to the `OwnerInputProvider`. The
        // double-nested `{answers: {<qid>: {answers: [<text>]}}}` reply
        // shape is load-bearing per CF-3 (`protocol/types.ts:334`).
        // M18 invariant: register inside `registerHandlers` BEFORE any
        // `thread/start` call.
        c.onServerRequest(METHOD.toolRequestUserInput, (params: unknown) => {
          const ownerInputParams = isWellFormedRequestUserInputParams(params) ? params : null;
          const requestThreadId = readThreadIdParam(params);
          if (requestThreadId !== null && isSidecarThreadId(requestThreadId)) {
            return ownerInputParams !== null
              ? (sidecarManagerRef.current?.handleRequestUserInput(ownerInputParams) ?? {
                  answers: {},
                })
              : { answers: {} };
          }
          if (!isLiveThreadParams(params)) {
            publishUnavailableRequestThreadParamsDiagnostic(
              params,
              'ownerInput',
              'owner input request ignored for abandoned thread',
            );
            return ownerInputParams !== null
              ? buildAbandonedToolRequestUserInputResponse(ownerInputParams)
              : { answers: {} };
          }
          if (ownerInputParams !== null) {
            const event = ownerInputRequestEventForUi(ownerInputParams);
            const input = appEventToEnrichedRunEventAppendInput(event, {
              threadId: ownerInputParams.threadId,
              turnId: ownerInputParams.turnId,
              itemId: ownerInputParams.itemId,
              requestId: ownerInputParams.itemId,
              raw: { params: ownerInputParams },
              meta: { source: METHOD.toolRequestUserInput },
            });
            if (input !== null) recordRunEvent(input);
          }
          const handled = handleRequestUserInputRequest(params, ownerInputProvider, {
            onParked: () => {
              pendingOwnerInputRequestCount += 1;
              publishPostureChange({ isAwaiting: true });
            },
            onReleased: () => {
              pendingOwnerInputRequestCount -= 1;
              publishPostureChange({ isAwaiting: pendingOwnerInputRequestCount > 0 });
            },
            stderr: o.diagnostics,
          });
          if (ownerInputParams === null || typeof ownerInputParams.itemId !== 'string') {
            return handled;
          }
          return handled.then(
            (response) => {
              recordOwnerInputRequestResolved(ownerInputParams.itemId, { response });
              return response;
            },
            (error: unknown) => {
              recordOwnerInputRequestResolved(ownerInputParams.itemId, {
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              });
              throw error;
            },
          );
        });
        c.onServerRequest(METHOD.mcpServerElicitationRequest, (params, meta) =>
          approvalDispatcher.handleElicitation(params, meta),
        );
        c.onServerRequest(METHOD.permissionsRequestApproval, (params, meta) =>
          approvalDispatcher.handlePermissionApproval(params, meta),
        );
        c.onNotification(METHOD.fileChangePatchUpdated, (params: unknown) => {
          const threadId = readThreadIdParam(params);
          if (threadId !== null && isPendingFreshClearDrainThread(threadId)) return;
          approvalDispatcher.fileChangeTracker.notePatchUpdated(params);
        });
        c.onNotification(METHOD.serverRequestResolved, (params: unknown) => {
          const threadId = readThreadIdParam(params);
          if (threadId !== null && isPendingFreshClearDrainThread(threadId)) return;
          approvalDispatcher.handleServerRequestResolved(params);
        });
        c.onNotification(METHOD.agentMessageDelta, publishAgentMessageDelta);
        // Subscribe to `rawResponseItem/completed` so built-in function
        // tool calls, including Codex `request_user_input`, are available
        // for transcript and UI publication. These items are not surfaced
        // through `item/completed`'s `ThreadItem` union.
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
        });
        c.onNotification(METHOD.threadTokenUsageUpdated, (params: unknown) => {
          const typedParams = threadTokenUsageParams(params);
          if (typedParams === null) return;
          if (!isLiveThreadId(typedParams.threadId)) {
            if (isPendingFreshClearDrainThread(typedParams.threadId)) {
              return;
            }
            if (isTrueAbandonedParentThread(typedParams.threadId)) {
              publishAbandonedThreadDiagnostic({
                threadId: typedParams.threadId,
                source: 'tokenUsageUpdated',
                message: 'token usage notification ignored for abandoned thread',
              });
              return;
            }
            recordRunEvent(
              subThreadTokenUsageRunEvent(
                typedParams,
                notificationRouter.current?.getSubThreadCorrelation(typedParams.threadId),
              ),
            );
            return;
          }
          cacheMetrics.observeWire(typedParams.tokenUsage.last);
          recordRunEvent(tokenUsageRunEvent(typedParams, cacheMetrics.summary()));
        });
      },
    });
  } catch (e) {
    const cancelled = await maybeReturnCancelled();
    if (cancelled !== null) return cancelled;
    const message = `WS connect failed: ${(e as Error).message}`;
    o.diagnostics.write(`aharness: ${message}\n`);
    publishRunFailedOnce(message);
    if (wsDiagnostics.length > 0) {
      o.diagnostics.write(
        `aharness: WS diagnostics:\n${wsDiagnostics.map((m) => `  - ${m}`).join('\n')}\n`,
      );
    }
    await afterLiveUiCloseoutGrace(async () => {
      closeContextRecorder();
      await appServer.close();
      await closeUiServer();
    });
    return result(1);
  }
  const cancelledAfterWsConnect = await maybeReturnCancelled();
  if (cancelledAfterWsConnect !== null) return cancelledAfterWsConnect;
  client = wsHandle.client;
  // Local non-nullable alias so the remainder of the boot sequence
  // narrows `client` without repeated `!` assertions. The forward-
  // declared `let client` exists solely so the cross-state dispatcher
  // closure (constructed BEFORE WS connect) can dereference the live
  // client at invocation time.
  const ws = client;
  const shutdown = runOnce(async (): Promise<void> => {
    closeContextRecorder();
    await closeHookSocket();
    closeReplySurfaces();
    await closeUiServer();
    const appServerHandle = appServer;
    if (appServerHandle === undefined) {
      throw new Error('internal: app-server unbound at shutdown');
    }
    await runShutdown({
      appServer: appServerHandle,
      client: ws,
      runDir: finalRunDir,
      ...(sidecarManagerRef.current !== undefined
        ? { sidecarManager: sidecarManagerRef.current }
        : {}),
      ownerInputProvider,
    });
  });
  shutdownAfterTerminal.current = shutdown;

  // 11. Register Codex skill roots and validate the startup catalog before
  //     creating the thread. The resolved catalog feeds native structured
  //     skill items for later framework-owned orientation turns.
  const skillPreflight = buildSkillCatalogPreflight({
    machine,
    skillOriginManifest: loaded.skillOriginManifest,
  });
  let resolvedRuntimeSkills: ReadonlyArray<ResolvedRuntimeSkill> = [];
  try {
    await ws.request<SkillsExtraRootsSetResponse>(METHOD.skillsExtraRootsSet, {
      extraRoots: skillPreflight.extraRoots,
    } satisfies SkillsExtraRootsSetParams);
    const skillListResponse = await ws.request<unknown>(METHOD.skillsList, {
      cwds: [repoRoot],
      forceReload: true,
    } satisfies SkillsListParams);
    if (!isSkillsListResponse(skillListResponse)) {
      throw new Error('skills/list returned malformed response');
    }
    const validation = validateSkillCatalog({
      repoRoot,
      preflight: skillPreflight,
      response: skillListResponse,
    });
    for (const warning of validation.warnings) {
      o.diagnostics.write(`aharness: skill preflight warning: ${warning}\n`);
    }
    if (!validation.ok) {
      throw new Error(validation.errors.join('; '));
    }
    resolvedRuntimeSkills = validation.resolvedSkills;
  } catch (e) {
    const cancelled = await maybeReturnCancelled();
    if (cancelled !== null) return cancelled;
    const message = `skill preflight failed: ${(e as Error).message}`;
    o.diagnostics.write(`aharness: ${message}\n`);
    publishRunFailedOnce(message);
    await afterLiveUiCloseoutGrace(shutdown);
    return result(1);
  }
  const cancelledAfterSkillPreflight = await maybeReturnCancelled();
  if (cancelledAfterSkillPreflight !== null) return cancelledAfterSkillPreflight;
  skillInjectionRef.current = createStateSkillInjectionService({
    resolvedSkills: resolvedRuntimeSkills,
  });
  const eventDispatcher = createEventDispatcher({
    host,
    flushSnapshot: () => undefined,
    ops: opsHandle.ops,
    writeFinalArtifacts: writeActiveFinalArtifacts,
    isTerminalState: (stateId) => terminalMetaById(machine, stateId)?.kind === 'terminal',
    onTerminal: () => signalTerminalCompletion(),
    onCanonicalEventError: (info) => {
      o.diagnostics.write(
        `aharness: canonical event '${info.eventName}' ${info.phase} handler for state '${info.stateId}' branch ${String(info.branchIndex)} threw: ${info.error.message}\n`,
      );
    },
    onCommittedTransition: (info) => handleCommittedRuntimeTransition(info, 'always'),
  });
  const runtimeSidecarManager = createCodexSidecarManager({
    client: ws,
    defaultCwd: repoRoot,
    resolvedSkills: resolvedRuntimeSkills,
    getActiveStateData: () => host.currentContext(),
    getActiveStateSourceDir: () => activeStateSourceDir(loaded, host.currentStateId(), fsmAbs),
    clock: sidecarTimeoutClock,
  });
  sidecarManagerRef.current = runtimeSidecarManager;
  opsHandle.bind({
    codex: createRuntimeCodexOps(runtimeSidecarManager, sidecarTimeoutClock),
    emit: (eventName, payload) => serializeDispatch(() => eventDispatcher(eventName, payload)),
  });

  // 12. thread/start.
  try {
    const r = await ws.request<ThreadStartResponse>(METHOD.threadStart, {
      cwd: repoRoot,
      dynamicTools: buildDynamicToolsRegistration(),
    });
    activeThreadBinding.set(r.thread.id);
    liveStdout.codexReady({ threadId: r.thread.id, state: host.currentStateId() });
  } catch (e) {
    const cancelled = await maybeReturnCancelled();
    if (cancelled !== null) return cancelled;
    const message = `thread/start failed: ${(e as Error).message}`;
    o.diagnostics.write(`aharness: ${message}\n`);
    publishRunFailedOnce(message);
    await afterLiveUiCloseoutGrace(shutdown);
    return result(1);
  }
  const cancelledAfterThreadStart = await maybeReturnCancelled();
  if (cancelledAfterThreadStart !== null) return cancelledAfterThreadStart;

  if (declaredHookKinds.length > 0) {
    try {
      hookSocket = await startHookSocket({
        path: hookSocketPath,
        dispatch: createHookDispatchers({
          declaredHookKinds,
          host,
          activeThreadBinding,
          ops: opsHandle.ops,
          serializeDispatch,
          writeFinalArtifacts: writeActiveFinalArtifacts,
          isTerminalState: (stateId) => terminalMetaById(machine, stateId)?.kind === 'terminal',
          onTerminal: () => signalTerminalCompletion(),
          onCanonicalEventError: reportCanonicalBuiltinEventError,
          onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
          onCommittedTransition: (info) => {
            void handleCommittedRuntimeTransition(info, 'always');
          },
        }),
      });
    } catch (e) {
      const cancelled = await maybeReturnCancelled();
      if (cancelled !== null) return cancelled;
      const message = `hook socket failed: ${(e as Error).message}`;
      o.diagnostics.write(`aharness: ${message}\n`);
      publishRunFailedOnce(message);
      await afterLiveUiCloseoutGrace(shutdown);
      return result(1);
    }
  }
  const cancelledAfterHookSocket = await maybeReturnCancelled();
  if (cancelledAfterHookSocket !== null) return cancelledAfterHookSocket;

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
      await afterLiveUiCloseoutGrace(shutdown);
      terminalResolve(null);
    },
    submittedThisTurn: () => submittedThisTurnFlag,
    isAwaiting,
    isOpen: () => isOpenState(host),
    isChoice: () => isChoiceState(host),
    composeActiveStateTurnInput,
    waitForSettled: () => stateModelSettings.waitForSettled(),
  });
  const driveForwardHandle = driveForward;
  const router = startNotificationRouter({
    client: ws,
    activeThreadBinding,
    onTurnStarted: (turnId, params) => {
      // Phase 2a: every fresh `turn/started` resets the cross-state
      // dispatcher's "I drove the next turn" flag so a subsequent
      // self-loop / no-cross-state turn falls through to drive-forward's
      // default branch.
      clearSubmittedThisTurn();
      const event: AppEvent = {
        kind: 'TurnStarted',
        turnId: turnId ?? '<unknown>',
      };
      recordAndPublishUiEvent(
        appEventToEnrichedRunEventAppendInput(event, {
          threadId: activeThreadBinding.require(),
          ...(turnId !== null ? { turnId } : {}),
          raw: { params },
          meta: { source: METHOD.turnStarted },
        }),
        event,
      );
    },
    onTurnCompleted: () => driveForwardHandle.onTurnCompleted(),
    onTurnCompletedError: (error) => {
      if (error === stateModelFailureError) {
        failRunForStateModelError(error);
        return;
      }
      o.diagnostics.write(`aharness: drive-forward failed: ${error.message}\n`);
      failRunAndShutdown('drive-forward failed; shutting down');
    },
    onItemStarted: (item, itemTurnId, params) => {
      if (itemTurnId) {
        approvalDispatcher.fileChangeTracker.noteThreadItem({
          threadId: activeThreadBinding.require(),
          turnId: itemTurnId,
          item,
        });
      }
      publishThreadItemStartedForUi(item, params);
    },
    onItemCompleted: (item, itemTurnId, params) => {
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
      publishThreadItemCompletedForUi(item, params);
    },
    onSubThreadNotification: (notification) => {
      recordRunEvent(subThreadNotificationRunEvent(notification));
    },
    onAbandonedThreadDiagnostic: publishAbandonedThreadDiagnostic,
    isParentThreadDrainingFreshClear: isPendingFreshClearDrainThread,
  });
  notificationRouter.current = router;
  ws.onNotification(METHOD.turnCompleted, (p) => {
    const params = p as { threadId?: unknown; turn?: unknown };
    const activeThreadId = activeThreadBinding.current();
    if (
      activeThreadId === undefined ||
      typeof params.threadId !== 'string' ||
      !isLiveThreadId(params.threadId)
    ) {
      return;
    }
    const turnId = readUiTurnId(params.turn) ?? '<unknown>';
    const event: AppEvent = {
      kind: 'TurnCompleted',
      turnId,
      finishReason: readUiFinishReason(params.turn),
    };
    recordAndPublishUiEvent(
      appEventToEnrichedRunEventAppendInput(event, {
        threadId: activeThreadId,
        turnId,
        raw: { params: p },
        meta: { source: METHOD.turnCompleted },
      }),
      event,
    );
  });

  // 13. Inject the first-state nudge as a `turn/start` kickoff so the
  //     model's first turn opens with the active state's orientation as
  //     a TUI-visible "user message".
  try {
    await runActiveOnEntry();
    if (!isTerminal(host)) {
      await applyStateModelForActiveState();
    }
    if (isTerminal(host)) {
      // Author onEntry may call ops.emit() and reach a terminal before the
      // first parent orientation turn. Terminal completion has already been
      // signalled by the event dispatcher in that case.
    } else if (isChoiceState(host)) {
      publishActiveOwnerChoicePending();
    } else {
      const built = composeActiveStateTurnInput();
      await ws.request(METHOD.turnStart, {
        threadId: activeThreadBinding.require(),
        input: built.input,
      } satisfies TurnStartParams);
      built.commit();
    }
  } catch (e) {
    const cancelled = await maybeReturnCancelled();
    if (cancelled !== null) return cancelled;
    const message = `kickoff turn/start failed: ${(e as Error).message}`;
    o.diagnostics.write(`aharness: ${message}\n`);
    publishRunFailedOnce(message);
    router.close();
    await afterLiveUiCloseoutGrace(shutdown);
    return result(1);
  }
  const cancelledAfterKickoff = await maybeReturnCancelled();
  if (cancelledAfterKickoff !== null) return cancelledAfterKickoff;

  // 14. Block on terminal-reached or SIGINT/SIGTERM. The signal
  //     handlers run §5.6 shutdown and `process.exit` directly — we
  //     never return from this function on a signal path.
  //
  //     `startSignalHandlers` (signals.ts:26-27) wires SIGINT and SIGTERM
  //     through the same `onSigint` callback. Both paths exit 130 —
  //     existing aharness behaviour pre-Phase-1; a SIGTERM-specific 143
  //     exit code would require widening the signals helper.
  const signals = o.startSignalHandlers?.({
    onSigint: async () => {
      router.close();
      await shutdown();
      o.exitProcess?.(SIGINT_EXIT_CODE);
    },
  });
  const resolveCancellation = (request: LiveRunCancellationRequest): void => {
    if (finalRunEventPublished && cancellationShutdown === null) return;
    void cancelRun(request)
      .then((terminal) => {
        terminalResolve(terminal);
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        o.diagnostics.write(`aharness: cancellation shutdown failed: ${err.message}\n`);
        terminalResolve({ exitCode: 1, status: 'failed', reason: err.message });
      });
  };
  const unsubscribeCancellation =
    o.cancellation?.subscribe((request) => {
      resolveCancellation(request);
    }) ?? (() => undefined);
  const alreadyCancelled = currentCancellation();
  if (alreadyCancelled !== null) {
    resolveCancellation(alreadyCancelled);
  }

  try {
    const terminalResult = await terminalPromise;
    return result(terminalResult?.exitCode ?? 0, terminalResult ?? undefined);
  } finally {
    closeContextRecorder();
    signals?.close();
    unsubscribeCancellation();
    router.close();
    await closeHookSocket();
    await closeUiServer();
  }
}

type UiItemStartedEvent = Extract<AppEvent, { kind: 'ItemStarted' }>;

function replySubmittedRunEvent(input: {
  payload: unknown;
  kind?: string;
  requestId?: string;
  state?: string;
  visitCount?: number;
  label?: string;
}): RunEventAppendInput {
  const requestId = replyLifecycleRequestId(input);
  return {
    type: 'reply.submitted',
    ...(requestId !== undefined ? { requestId } : {}),
    data: compactRunEventPayload({
      kind: input.kind,
      requestId,
      state: input.state,
      visitCount: input.visitCount,
      label: input.label,
      status: 'submitted',
      row: {
        kind: 'reply',
        label: input.kind === 'owner-choice' ? 'owner choice' : (input.kind ?? 'reply'),
        status: 'submitted',
        summary: input.kind === 'owner-choice' ? input.label : requestId,
        data:
          input.kind === 'owner-choice'
            ? compactRunEventPayload({
                kind: 'owner-choice',
                requestId,
                state: input.state,
                visitCount: input.visitCount,
                label: input.label,
              })
            : undefined,
      },
    }),
    raw: { payload: input.payload },
  };
}

function replyResolvedRunEvent(input: {
  payload: unknown;
  kind?: string;
  requestId?: string;
  state?: string;
  visitCount?: number;
  label?: string;
  result?: { status: number; body: unknown };
  error?: Error;
}): RunEventAppendInput {
  const ok = input.result !== undefined && input.result.status >= 200 && input.result.status < 400;
  const requestId = replyLifecycleRequestId(input);
  return {
    type: 'reply.resolved',
    ...(requestId !== undefined ? { requestId } : {}),
    data: compactRunEventPayload({
      kind: input.kind,
      requestId,
      state: input.state,
      visitCount: input.visitCount,
      label: input.label,
      status: ok ? 'accepted' : 'failed',
      ok,
      httpStatus: input.result?.status,
      error: input.error?.message ?? errorCode(input.result?.body),
      row: {
        kind: 'reply',
        label: input.kind === 'owner-choice' ? 'owner choice' : (input.kind ?? 'reply'),
        status: ok ? 'accepted' : 'failed',
        summary:
          input.kind === 'owner-choice'
            ? (input.label ?? input.error?.message ?? errorCode(input.result?.body))
            : (requestId ?? input.error?.message ?? errorCode(input.result?.body)),
        data:
          input.kind === 'owner-choice'
            ? compactRunEventPayload({
                kind: 'owner-choice',
                requestId,
                state: input.state,
                visitCount: input.visitCount,
                label: input.label,
              })
            : undefined,
      },
    }),
    raw: compactRunEventPayload({
      payload: input.payload,
      result: input.result,
      error:
        input.error !== undefined
          ? { name: input.error.name, message: input.error.message }
          : undefined,
    }),
  };
}

function replyLifecycleRequestId(input: {
  kind?: string;
  requestId?: string;
  state?: string;
  visitCount?: number;
}): string | undefined {
  if (
    input.kind === 'owner-choice' &&
    input.state !== undefined &&
    input.visitCount !== undefined
  ) {
    return ownerChoiceRequestId(input.state, input.visitCount);
  }
  return input.requestId;
}

function errorCode(body: unknown): string | undefined {
  const record = asUiRecord(body);
  const error = record?.['error'];
  return typeof error === 'string' ? error : undefined;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateCodePoints(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function publicTransitionFailureSummary(metadata: PublicSubmitFailureMetadata | undefined): string {
  if (metadata === undefined) return 'Transition failed';
  const summary = truncateCodePoints(normalizedText(metadata.summary), 240);
  return summary.length > 0 ? summary : 'Transition failed';
}

function safeSubmitArgs(params: DynamicToolCallParams): { state?: string; exit?: string } {
  const value = params.arguments;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  const record = asUiRecord(parsed);
  if (record === null) return {};
  return {
    ...(typeof record['state'] === 'string' ? { state: record['state'] } : {}),
    ...(typeof record['exit'] === 'string' ? { exit: record['exit'] } : {}),
  };
}

function submitFailureMetadata(
  response: DynamicToolCallResponse,
): PublicSubmitFailureMetadata | undefined {
  return (response as DynamicToolCallResponse & SubmitFailureMetadataCarrier)[
    publicSubmitFailureMetadataSymbol
  ];
}

function displayKindForToolName(toolName: string | undefined): string | undefined {
  if (toolName === undefined) return undefined;
  const normalized = toolName.toLowerCase();
  if (normalized === 'bash' || normalized.includes('exec') || normalized.includes('shell')) {
    return 'command';
  }
  if (normalized.startsWith('mcp:')) return 'mcp';
  if (normalized.includes('agent')) return 'subagent';
  if (normalized.includes('read') || normalized === 'cat') return 'read';
  if (normalized.includes('list') || normalized === 'ls') return 'list';
  if (normalized.includes('search') || normalized.includes('grep') || normalized === 'rg') {
    return 'search';
  }
  return 'tool';
}

function threadToolDisplayData(
  item: Record<string, unknown>,
  itemType: string,
  toolName: string | undefined,
  receiverThreadIds: ReadonlyArray<string>,
  receiverCorrelations: ReadonlyArray<SubThreadCorrelation>,
): RunEventPayload {
  if (itemType === 'commandExecution' || itemType === 'execCommand') {
    return compactRunEventPayload({
      displayKind: 'command',
      command: readCommandText(item),
    });
  }
  if (itemType === 'mcpToolCall') {
    return compactRunEventPayload({
      displayKind: 'mcp',
      target: toolName,
    });
  }
  if (itemType === 'spawnAgentToolCall' || itemType === 'collabAgentToolCall') {
    const firstMetadata = receiverCorrelations.find(
      (entry) => entry.agentNickname !== undefined || entry.agentRole !== undefined,
    );
    return compactRunEventPayload({
      displayKind: 'subagent',
      subagentAction: itemType === 'spawnAgentToolCall' ? 'spawn' : 'send',
      agentNickname: firstMetadata?.agentNickname,
      agentRole: firstMetadata?.agentRole,
      receiverThreadIds: receiverThreadIds.length > 0 ? receiverThreadIds : undefined,
      promptPreview: cappedText(readItemText(item), 160),
      responsePreview: cappedText(
        readStringField(item, 'response') ?? readStringField(item, 'result'),
        240,
      ),
      errorPreview: cappedText(readStringField(item, 'error'), 160),
    });
  }
  return compactRunEventPayload({
    displayKind: displayKindForToolName(toolName),
  });
}

function cappedText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizedText(value);
  return normalized.length > 0 ? truncateCodePoints(normalized, max) : undefined;
}

function dynamicToolCallRunEvent(params: DynamicToolCallParams): RunEventAppendInput {
  const internal = params.tool === SUBMIT_TOOL_NAME;
  return {
    type: 'item.started',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.callId,
    data: compactRunEventPayload({
      itemId: params.callId,
      itemType: 'dynamicToolCall',
      kind: 'tool',
      toolName: params.tool,
      namespace: params.namespace,
      status: 'started',
      internal,
      row: internal
        ? undefined
        : {
            kind: 'tool',
            label: params.tool,
            status: 'pending',
            summary: params.tool,
            data: { displayKind: 'tool' },
          },
    }),
    meta: { source: METHOD.toolDynamicCall },
    raw: { params },
  };
}

function dynamicToolResultRunEvent(
  params: DynamicToolCallParams,
  response: DynamicToolCallResponse,
): RunEventAppendInput {
  const internal = params.tool === SUBMIT_TOOL_NAME;
  const failureMetadata =
    internal && !response.success ? submitFailureMetadata(response) : undefined;
  const submitArgs = internal && !response.success ? safeSubmitArgs(params) : {};
  return {
    type: 'item.completed',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.callId,
    data: compactRunEventPayload({
      itemId: params.callId,
      itemType: 'dynamicToolCall',
      kind: 'tool',
      toolName: params.tool,
      namespace: params.namespace,
      status: response.success ? 'completed' : 'failed',
      ok: response.success,
      internal,
      row: internal
        ? response.success
          ? undefined
          : {
              kind: 'transition_failure',
              label: 'transition failed',
              status: 'failed',
              summary: publicTransitionFailureSummary(failureMetadata),
              data: compactRunEventPayload({
                toolName: SUBMIT_TOOL_NAME,
                state: submitArgs.state,
                exit: submitArgs.exit,
              }),
            }
        : {
            kind: 'tool',
            label: params.tool,
            status: response.success ? 'completed' : 'failed',
            summary: params.tool,
            data: { displayKind: 'tool' },
          },
    }),
    meta: { source: METHOD.toolDynamicCall },
    raw: { params, response },
  };
}

interface ThreadItemRunEventOptions {
  readonly toolNames: ReadonlyMap<string, string>;
  readonly subThreadCorrelation: (threadId: string) => SubThreadCorrelation | undefined;
}

function threadItemRunEvent(
  phase: 'started' | 'completed',
  params: unknown,
  item: unknown,
  options?: ThreadItemRunEventOptions,
): RunEventAppendInput {
  const paramsRecord = asUiRecord(params);
  const itemRecord = asUiRecord(item);
  const threadId = readStringField(paramsRecord ?? {}, 'threadId');
  const turnId = readStringField(paramsRecord ?? {}, 'turnId');
  const itemType = itemRecord ? readStringField(itemRecord, 'type') : undefined;
  const itemId = itemRecord ? (readItemId(itemRecord) ?? undefined) : undefined;
  const toolName =
    itemId !== undefined && phase === 'completed'
      ? (options?.toolNames.get(itemId) ??
        (itemRecord && itemType ? readUiToolName(itemRecord, itemType) : undefined))
      : itemRecord && itemType
        ? readUiToolName(itemRecord, itemType)
        : undefined;
  const receiverThreadIds = itemRecord ? readReceiverThreadIds(itemRecord) : [];
  const receiverCorrelations = receiverThreadIds
    .map((threadId) => options?.subThreadCorrelation(threadId))
    .filter((entry): entry is SubThreadCorrelation => entry !== undefined);
  const status =
    phase === 'started'
      ? 'started'
      : itemRecord
        ? (readStringField(itemRecord, 'status') ??
          (readUiToolOk(itemRecord) ? 'completed' : 'failed'))
        : 'completed';

  return {
    type: phase === 'started' ? 'item.started' : 'item.completed',
    ...(threadId !== undefined ? { threadId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(itemId !== undefined ? { itemId } : {}),
    data: compactRunEventPayload({
      itemId,
      turnId,
      threadId,
      itemType,
      kind: itemType !== undefined && isUiToolThreadItemType(itemType) ? 'tool' : itemType,
      toolName,
      status,
      ok: phase === 'completed' && itemRecord ? readUiToolOk(itemRecord) : undefined,
      receiverThreadIds: receiverThreadIds.length > 0 ? receiverThreadIds : undefined,
      row: threadItemRowData(
        phase,
        itemRecord,
        itemType,
        toolName,
        status,
        receiverThreadIds,
        receiverCorrelations,
      ),
    }),
    meta: { source: phase === 'started' ? METHOD.itemStarted : METHOD.itemCompleted },
    raw: { params },
  };
}

function threadItemRowData(
  phase: 'started' | 'completed',
  item: Record<string, unknown> | null,
  itemType: string | undefined,
  toolName: string | undefined,
  status: string,
  receiverThreadIds: ReadonlyArray<string>,
  receiverCorrelations: ReadonlyArray<SubThreadCorrelation>,
): RunEventPayload | undefined {
  if (item === null || itemType === undefined) return undefined;
  if (itemType === 'dynamicToolCall') {
    // The item/tool/dynamicCall request handler owns dynamic-tool compact rows.
    // Generic item notifications duplicate that protocol bookkeeping and can
    // otherwise leak internal aharness_submit calls into dev transcripts.
    return undefined;
  }
  if (itemType === 'fileChange') {
    return fileChangeRowData(phase, item, status);
  }
  if (isUiToolThreadItemType(itemType)) {
    return compactRunEventPayload({
      kind: 'tool',
      label: toolName ?? itemType,
      status: phase === 'started' ? 'pending' : status,
      summary: toolName ?? itemType,
      output:
        phase === 'completed' && (itemType === 'commandExecution' || itemType === 'execCommand')
          ? readCommandOutput(item)
          : undefined,
      elapsedMs:
        phase === 'completed' && (itemType === 'commandExecution' || itemType === 'execCommand')
          ? readCommandElapsedMs(item)
          : undefined,
      data: threadToolDisplayData(
        item,
        itemType,
        toolName,
        receiverThreadIds,
        receiverCorrelations,
      ),
    });
  }
  if (itemType === 'agentMessage' || itemType === 'userMessage' || itemType === 'reasoning') {
    const text = readItemText(item);
    return compactRunEventPayload({
      kind: itemType === 'reasoning' ? 'reasoning' : 'message',
      label: itemType,
      text: text.length > 0 ? text : undefined,
      status,
    });
  }
  return compactRunEventPayload({
    kind: itemType,
    label: itemType,
    status,
  });
}

interface FileChangeFileSummary {
  readonly path: string;
  readonly kind: 'add' | 'delete' | 'update';
  readonly movePath?: string;
  readonly added: number;
  readonly removed: number;
}

function fileChangeRowData(
  phase: 'started' | 'completed',
  item: Record<string, unknown>,
  status: string,
): RunEventPayload {
  const files = summarizeFileChanges(item['changes']);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return compactRunEventPayload({
    kind: 'fileChange',
    label: 'file change',
    status: normalizeFileChangeStatus(phase, item, status),
    summary: fileChangeSummary(files, added, removed),
    data: {
      changeCount: files.length,
      added,
      removed,
      files,
    },
  });
}

function normalizeFileChangeStatus(
  phase: 'started' | 'completed',
  item: Record<string, unknown>,
  status: string,
): 'pending' | 'completed' | 'failed' | 'declined' {
  if (phase === 'started') return 'pending';
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'declined';
    case 'inProgress':
      return 'pending';
    default:
      return readUiToolOk(item) ? 'completed' : 'failed';
  }
}

function summarizeFileChanges(changes: unknown): FileChangeFileSummary[] {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    const record = asUiRecord(change);
    if (record === null) return [];
    const path = readStringField(record, 'path');
    const kind = asUiRecord(record['kind']);
    const kindType = kind ? readStringField(kind, 'type') : undefined;
    if (
      path === undefined ||
      (kindType !== 'add' && kindType !== 'delete' && kindType !== 'update')
    ) {
      return [];
    }

    const diff = readStringField(record, 'diff') ?? '';
    const counts = countFileChangeLines(kindType, diff);
    const movePath =
      kind !== null
        ? (readStringField(kind, 'move_path') ?? readStringField(kind, 'movePath'))
        : undefined;
    return [
      {
        path,
        kind: kindType,
        added: counts.added,
        removed: counts.removed,
        ...(movePath !== undefined ? { movePath } : {}),
      },
    ];
  });
}

function countFileChangeLines(
  kind: FileChangeFileSummary['kind'],
  diff: string,
): { readonly added: number; readonly removed: number } {
  if (kind === 'add') return { added: countTextLines(diff), removed: 0 };
  if (kind === 'delete') return { added: 0, removed: countTextLines(diff) };
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  const lineCount = text.split(/\r?\n/).length;
  return text.endsWith('\n') ? lineCount - 1 : lineCount;
}

function fileChangeSummary(
  files: ReadonlyArray<FileChangeFileSummary>,
  added: number,
  removed: number,
): string {
  if (files.length === 0) return 'File change';
  const counts = `(+${added} -${removed})`;
  if (files.length > 1) return `Edited ${files.length} files ${counts}`;
  const file = files[0];
  if (file === undefined) return 'File change';
  const verb = file.kind === 'add' ? 'Added' : file.kind === 'delete' ? 'Deleted' : 'Edited';
  return `${verb} ${file.path} ${counts}`;
}

function rawResponseItemRunEvent(
  params: unknown,
  callNames?: ReadonlyMap<string, string>,
): RunEventAppendInput | null {
  const paramsRecord = asUiRecord(params);
  const item = asUiRecord(paramsRecord?.['item']);
  if (paramsRecord === null || item === null) return null;
  const itemType = readStringField(item, 'type');
  const threadId = readStringField(paramsRecord, 'threadId');
  const turnId = readStringField(paramsRecord, 'turnId');
  if (itemType === 'function_call') {
    const callId = readStringField(item, 'call_id');
    const name = readStringField(item, 'name');
    if (callId === undefined) return null;
    return {
      type: 'item.started',
      ...(threadId !== undefined ? { threadId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      itemId: callId,
      data: compactRunEventPayload({
        itemId: callId,
        itemType,
        kind: 'tool',
        toolName: name,
        status: 'started',
        row: {
          kind: 'tool',
          label: name ?? 'function_call',
          status: 'pending',
          summary: name ?? 'function_call',
          data: compactRunEventPayload({
            displayKind: displayKindForToolName(name),
          }),
        },
      }),
      meta: { source: METHOD.rawResponseItemCompleted },
      raw: { params },
    };
  }
  if (itemType === 'function_call_output') {
    const callId = readStringField(item, 'call_id');
    if (callId === undefined) return null;
    const name = readStringField(item, 'name') ?? callNames?.get(callId);
    const ok = readUiToolOk(item);
    const output = formatUiValue(readUnknownField(item, 'output'));
    return {
      type: 'item.completed',
      ...(threadId !== undefined ? { threadId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      itemId: callId,
      data: compactRunEventPayload({
        itemId: callId,
        itemType,
        kind: 'tool',
        toolName: name,
        status: ok ? 'completed' : 'failed',
        ok,
        row: {
          kind: 'tool',
          label: name ?? 'function_call',
          status: ok ? 'completed' : 'failed',
          summary: name ?? 'function_call',
          output: output.length > 0 ? output : undefined,
          ok,
          resultId: `${callId}:output`,
          data: compactRunEventPayload({
            displayKind: displayKindForToolName(name),
          }),
        },
      }),
      meta: { source: METHOD.rawResponseItemCompleted },
      raw: { params },
    };
  }
  return {
    type: 'raw_response_item.completed',
    ...(threadId !== undefined ? { threadId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    data: compactRunEventPayload({
      itemType,
      kind: 'raw-response-item',
      status: 'completed',
    }),
    meta: { source: METHOD.rawResponseItemCompleted },
    raw: { params },
  };
}

function tokenUsageRunEvent(
  params: ThreadTokenUsageUpdatedNotification['params'],
  cache: CacheMetricsSummary,
): RunEventAppendInput {
  return {
    type: 'token.updated',
    threadId: params.threadId,
    ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
    data: compactRunEventPayload({
      threadId: params.threadId,
      turnId: params.turnId,
      total: normalizeTokenUsageBreakdown(params.tokenUsage.total),
      last: normalizeTokenUsageBreakdown(params.tokenUsage.last),
      modelContextWindow: numberField(params.tokenUsage.modelContextWindow),
      cache: compactRunEventPayload({
        turns: cache.turns,
        totalInput: cache.totalInput,
        totalCached: cache.totalCached,
        ratioPctSinceTurn5: cache.ratioPctSinceTurn5,
        healthy: cache.healthy,
      }),
    }),
    raw: { params },
  };
}

function subThreadTokenUsageRunEvent(
  params: ThreadTokenUsageUpdatedNotification['params'],
  correlation?: SubThreadCorrelation,
): RunEventAppendInput {
  return {
    type: 'subthread.token.updated',
    threadId: params.threadId,
    turnId: params.turnId,
    data: compactRunEventPayload({
      threadId: params.threadId,
      turnId: params.turnId,
      total: normalizeTokenUsageBreakdown(params.tokenUsage.total),
      last: normalizeTokenUsageBreakdown(params.tokenUsage.last),
      modelContextWindow: numberField(params.tokenUsage.modelContextWindow),
      parentThreadId: correlation?.parentThreadId,
      parentTurnId: correlation?.parentTurnId,
      parentItemId: correlation?.parentItemId,
      toolKind: correlation?.toolKind,
      toolName: correlation?.toolName,
      correlationKnown: correlation !== undefined,
    }),
    meta: compactRunEventPayload({ subThread: true, correlation }),
    raw: { params },
  };
}

function subThreadNotificationRunEvent(notification: SubThreadNotification): RunEventAppendInput {
  const typeBySource: Record<SubThreadNotification['source'], string> = {
    turnStarted: 'subthread.turn.started',
    turnCompleted: 'subthread.turn.completed',
    itemStarted: 'subthread.item.started',
    itemCompleted: 'subthread.item.completed',
  };
  const itemRecord = asUiRecord(notification.item);
  const itemType = itemRecord ? readStringField(itemRecord, 'type') : undefined;
  const itemId = itemRecord ? (readItemId(itemRecord) ?? undefined) : undefined;
  return {
    type: typeBySource[notification.source],
    threadId: notification.threadId,
    ...(notification.turnId !== null ? { turnId: notification.turnId } : {}),
    ...(itemId !== undefined ? { itemId } : {}),
    data: compactRunEventPayload({
      source: notification.source,
      threadId: notification.threadId,
      turnId: notification.turnId,
      itemId,
      itemType,
      parentThreadId: notification.correlation?.parentThreadId,
      parentTurnId: notification.correlation?.parentTurnId,
      parentItemId: notification.correlation?.parentItemId,
      toolKind: notification.correlation?.toolKind,
      toolName: notification.correlation?.toolName,
      correlationKnown: notification.correlation !== undefined,
    }),
    meta: compactRunEventPayload({
      subThread: true,
      correlation: notification.correlation,
    }),
    raw: { params: notification.params },
  };
}

function normalizeTokenUsageBreakdown(
  value: TokenUsageBreakdown | undefined,
): RunEventPayload | undefined {
  if (value === undefined) return undefined;
  return compactRunEventPayload({
    totalTokens: numberField(value.totalTokens),
    inputTokens: numberField(value.inputTokens),
    cachedInputTokens: numberField(value.cachedInputTokens),
    outputTokens: numberField(value.outputTokens),
    reasoningOutputTokens: numberField(value.reasoningOutputTokens),
  });
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function threadTokenUsageParams(
  params: unknown,
): ThreadTokenUsageUpdatedNotification['params'] | null {
  const record = asUiRecord(params);
  const tokenUsage = asUiRecord(record?.['tokenUsage']);
  if (record === null || tokenUsage === null) return null;
  const threadId = readStringField(record, 'threadId');
  const turnId = readStringField(record, 'turnId');
  if (threadId === undefined || turnId === undefined) return null;
  const total = asTokenUsageBreakdown(tokenUsage['total']);
  const last = asTokenUsageBreakdown(tokenUsage['last']);
  if (total === undefined || last === undefined) return null;
  const rawModelContextWindow = tokenUsage['modelContextWindow'];
  const modelContextWindow =
    rawModelContextWindow === null ? null : numberField(rawModelContextWindow);
  return {
    threadId,
    turnId,
    tokenUsage: {
      total,
      last,
      modelContextWindow: modelContextWindow ?? null,
    },
  };
}

function asTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | undefined {
  const record = asUiRecord(value);
  if (record === null) return undefined;
  return compactRunEventPayload({
    totalTokens: numberField(record['totalTokens']),
    inputTokens: numberField(record['inputTokens']),
    cachedInputTokens: numberField(record['cachedInputTokens']),
    outputTokens: numberField(record['outputTokens']),
    reasoningOutputTokens: numberField(record['reasoningOutputTokens']),
  }) as TokenUsageBreakdown;
}

function isDynamicToolCallParams(params: unknown): params is DynamicToolCallParams {
  const record = asUiRecord(params);
  return (
    record !== null &&
    typeof record['threadId'] === 'string' &&
    typeof record['turnId'] === 'string' &&
    typeof record['callId'] === 'string' &&
    typeof record['tool'] === 'string' &&
    Object.prototype.hasOwnProperty.call(record, 'arguments')
  );
}

function readReceiverThreadIds(record: Record<string, unknown>): string[] {
  const value = record['receiverThreadIds'];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

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
    const command = readCommandText(record);
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

function readCommandText(record: Record<string, unknown>): string | undefined {
  return (
    readStringField(record, 'command') ??
    readNestedStringField(record, ['params', 'command']) ??
    readStringField(record, 'cmd')
  );
}

function readCommandOutput(record: Record<string, unknown>): string | undefined {
  const error = readUnknownField(record, 'error');
  if (error !== undefined && error !== null) return formatUiValue(error);
  const output =
    readUnknownField(record, 'aggregatedOutput') ??
    readUnknownField(record, 'output') ??
    readUnknownField(record, 'result');
  const formatted = formatUiValue(output);
  return formatted.length > 0 ? formatted : undefined;
}

function readCommandElapsedMs(record: Record<string, unknown>): number | undefined {
  return (
    numberField(record['durationMs']) ??
    numberField(record['elapsedMs']) ??
    numberField(record['elapsedMilliseconds'])
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

function urlWithUiBootParams(
  url: string,
  params: {
    readonly token: string;
    readonly runId: string;
    readonly mode?: 'inspect';
  },
): string {
  const parsed = new URL(url);
  parsed.searchParams.set('token', params.token);
  parsed.searchParams.set('runId', params.runId);
  if (params.mode !== undefined) {
    parsed.searchParams.set('mode', params.mode);
  }
  return parsed.toString();
}

function runOnce(fn: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | null = null;
  return () => {
    promise ??= fn();
    return promise;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ThreadScopedSidecarTimeoutClock extends CodexSidecarTimeoutClock {
  runForThread<T>(threadId: string, work: () => T): T;
  pauseThread(threadId: string): () => void;
}

interface PausableTimerEntry {
  readonly token: NodeJS.Timeout;
  readonly callback: () => void;
  readonly threadId?: string;
  remainingMs: number;
  startedAt: number;
  current: NodeJS.Timeout | undefined;
  cleared: boolean;
}

function createThreadScopedPausableTimeoutClock(): ThreadScopedSidecarTimeoutClock {
  const threadContext = new AsyncLocalStorage<string>();
  const entries = new Map<NodeJS.Timeout, PausableTimerEntry>();
  const pauseDepthByThreadId = new Map<string, number>();

  const fire = (entry: PausableTimerEntry): void => {
    if (entry.cleared) return;
    entry.cleared = true;
    entries.delete(entry.token);
    entry.callback();
  };

  const arm = (entry: PausableTimerEntry): void => {
    if (entry.cleared || entry.current !== undefined) return;
    entry.startedAt = Date.now();
    entry.current = setTimeout(
      () => {
        entry.current = undefined;
        fire(entry);
      },
      Math.max(0, entry.remainingMs),
    );
  };

  const pauseEntry = (entry: PausableTimerEntry): void => {
    if (entry.current === undefined) return;
    clearTimeout(entry.current);
    entry.current = undefined;
    entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt));
  };

  const isThreadPaused = (threadId: string | undefined): boolean =>
    threadId !== undefined && (pauseDepthByThreadId.get(threadId) ?? 0) > 0;

  return {
    setTimeout(callback, timeoutMs) {
      const threadId = threadContext.getStore();
      const token = setTimeout(() => undefined, 2_147_483_647);
      clearTimeout(token);
      const entry: PausableTimerEntry = {
        token,
        callback,
        ...(threadId !== undefined ? { threadId } : {}),
        remainingMs: timeoutMs,
        startedAt: Date.now(),
        current: undefined,
        cleared: false,
      };
      entries.set(token, entry);
      if (!isThreadPaused(threadId)) arm(entry);
      return token;
    },
    clearTimeout(timer) {
      const entry = entries.get(timer);
      if (entry === undefined) {
        clearTimeout(timer);
        return;
      }
      entry.cleared = true;
      if (entry.current !== undefined) clearTimeout(entry.current);
      entries.delete(timer);
    },
    runForThread(threadId, work) {
      return threadContext.run(threadId, work);
    },
    pauseThread(threadId) {
      const nextDepth = (pauseDepthByThreadId.get(threadId) ?? 0) + 1;
      pauseDepthByThreadId.set(threadId, nextDepth);
      if (nextDepth === 1) {
        for (const entry of entries.values()) {
          if (entry.threadId === threadId) pauseEntry(entry);
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const currentDepth = pauseDepthByThreadId.get(threadId) ?? 0;
        if (currentDepth <= 1) {
          pauseDepthByThreadId.delete(threadId);
          for (const entry of entries.values()) {
            if (entry.threadId === threadId) arm(entry);
          }
          return;
        }
        pauseDepthByThreadId.set(threadId, currentDepth - 1);
      };
    },
  };
}

function createRuntimeCodexOps(
  manager: CodexSidecarManager,
  clock: ThreadScopedSidecarTimeoutClock,
): CodexSidecarOps {
  const wrappedByThreadId = new Map<string, CodexSidecarThread>();

  const wrapThread = (thread: CodexSidecarThread): CodexSidecarThread => {
    const existing = wrappedByThreadId.get(thread.threadId);
    if (existing !== undefined) return existing;
    const wrapped: CodexSidecarThread = Object.freeze({
      key: thread.key,
      threadId: thread.threadId,
      ...(thread.label !== undefined ? { label: thread.label } : {}),
      send: (input: string | readonly CodexSidecarInput[], opts?: CodexSidecarTurnOptions) =>
        clock.runForThread(thread.threadId, () => thread.send(input, opts)),
      sendOrThrow: (input: string | readonly CodexSidecarInput[], opts?: CodexSidecarTurnOptions) =>
        clock.runForThread(thread.threadId, () => thread.sendOrThrow(input, opts)),
      answer: (
        requestId: string,
        answers: CodexSidecarAnswerPayload,
        opts?: CodexSidecarTurnOptions,
      ) => clock.runForThread(thread.threadId, () => thread.answer(requestId, answers, opts)),
      close: () => thread.close(),
    });
    wrappedByThreadId.set(thread.threadId, wrapped);
    return wrapped;
  };

  return Object.freeze({
    async createThread<Data = unknown>(
      key: string,
      options?: CodexSidecarThreadOptions<Data>,
    ): Promise<CodexSidecarThread> {
      const thread = await manager.createThread<Data>(key, options);
      return wrapThread(thread);
    },
    thread(key: string): CodexSidecarThread {
      return wrapThread(manager.thread(key));
    },
  });
}

function activeStateSourceDir(
  loaded: LiveRunLoadedFsm,
  stateId: string,
  fallbackFilePath: string,
): string {
  const sourceFile = loaded.sourceLocations?.states[stateId]?.sourceFile;
  if (sourceFile !== undefined) return dirname(sourceFile);
  const prefixes = [...loaded.skillOriginManifest.sourceDirPrefixes].sort(
    (a, b) => b.stateIdPrefix.length - a.stateIdPrefix.length,
  );
  const matched = prefixes.find(
    (entry) => stateId === entry.stateIdPrefix || stateId.startsWith(`${entry.stateIdPrefix}.`),
  );
  return (
    matched?.sourceDir ?? loaded.skillOriginManifest.rootSourceDir ?? dirname(fallbackFilePath)
  );
}

async function runShutdown(o: {
  readonly appServer: AppServerHandle;
  readonly client: JsonRpcClient;
  readonly runDir: RunDir;
  readonly sidecarManager?: CodexSidecarManager;
  readonly ownerInputProvider?: LiveRunOwnerInputProvider;
}): Promise<void> {
  try {
    await o.sidecarManager?.shutdown();
  } catch {
    /* best-effort — proceed to app-server teardown regardless. */
  }
  o.sidecarManager?.markAppServerClosed();

  try {
    await o.client.close();
  } catch {
    /* best-effort — proceed to app-server teardown regardless. */
  }

  await o.appServer.close();

  try {
    o.ownerInputProvider?.close?.();
  } catch {
    /* best-effort */
  }

  cleanupRunSockets(o.runDir);
}

function cleanupRunSockets(runDir: RunDir): void {
  for (const f of ['app-server.sock', 'hook.sock']) {
    try {
      rmSync(join(runDir.root, f), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

function createHookDispatchers(i: {
  readonly declaredHookKinds: ReadonlyArray<HookKind>;
  readonly host: ActorHost;
  readonly activeThreadBinding: ActiveThreadBinding;
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
// Owner-input ServerRequest helper.
// ---------------------------------------------------------------------------

/**
 * Hooks the `item/tool/requestUserInput` handler uses to bracket each
 * parked request. `onParked` fires synchronously BEFORE the provider
 * is awaited; `onReleased` fires in the handler's `finally` arm so every
 * exit path (resolve / reject / handler throw) restores the count.
 */
interface RequestUserInputHandlerHooks {
  readonly onParked: () => void;
  readonly onReleased: () => void;
  readonly stderr: NodeJS.WritableStream;
}

function createBrowserOwnerInputProvider(args: {
  readonly controller: BrowserReplyController;
  readonly publishUiEvent: (event: AppEvent) => void;
}): LiveRunOwnerInputProvider {
  let closePending: ((error: Error) => void) | null = null;
  let closePendingRequestId: string | null = null;

  return {
    provideAnswers(params) {
      args.publishUiEvent(ownerInputRequestEventForUi(params));

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

function ownerInputRequestEventForUi(params: ToolRequestUserInputParams): AppEvent {
  return {
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
async function handleRequestUserInputRequest(
  params: unknown,
  provider: LiveRunOwnerInputProvider,
  hooks: RequestUserInputHandlerHooks,
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
// Active-state orientation composer.
// ---------------------------------------------------------------------------

/**
 * Compose the orientation nudge for the host's currently active leaf.
 * Throws if the leaf is non-stateful (terminal / passive) — drive-forward
 * never advances those, but if we somehow ended up calling this on one
 * the loud failure is preferable to a silent empty turn.
 *
 * Shape mirrors `runtime/onStateEntry.ts` so orientation stays consistent
 * across first-turn, drive-forward, cross-state, and resumed-entry paths.
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
    }
  }

  let entryPromptText: string;
  try {
    entryPromptText = resolveEntryPrompt(stateMeta.entryPrompt, host.currentContext() as RunCtx);
  } catch (e) {
    entryPromptText = `(aharness: error computing entryPrompt: ${(e as Error).message})`;
  }

  return composeStateNudge({
    stateId,
    exits,
    entryPromptText,
  });
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
  const publicContext = publicContextFromRunContext(context);

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

  const exits: FsmState['exits'] = Object.entries(meta.exits).flatMap(([name, def]) =>
    '__aharnessPayloadMarker' in def && def.__aharnessPayloadMarker === true
      ? [
          {
            name,
            kind: 'submit' as const,
            ...('when' in def && Array.isArray(def.when) ? { branchCount: def.when.length } : {}),
          },
        ]
      : [],
  );

  let entryPrompt: string;
  try {
    entryPrompt = resolveEntryPrompt(meta.entryPrompt, context);
  } catch (e) {
    entryPrompt = `(aharness: error computing entryPrompt: ${(e as Error).message})`;
  }
  const stateModel = resolveStateModelOptions(meta.model);

  return {
    path,
    leaf: leafFromStatePath(path),
    kind: 'stateful',
    ...(typeof meta.open === 'boolean' ? { open: meta.open } : {}),
    ...(stateModel.model !== undefined ? { model: stateModel.model } : {}),
    ...(stateModel.effort !== undefined ? { effort: stateModel.effort } : {}),
    exits,
    visitCount,
    entryPrompt,
    context: publicContext,
  };
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

function isChoiceState(host: ActorHost): boolean {
  return host.currentMeta()?.kind === 'choice';
}

function currentStateDeclaresClearOnEntry(host: ActorHost): boolean {
  const meta = host.currentMeta();
  return meta?.kind === 'stateful' && Object.prototype.hasOwnProperty.call(meta, 'clearOnEntry');
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
