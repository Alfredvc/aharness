/**
 * `@aharness/core/runtime` — daemon / CLI / test surface.
 *
 * Substrate-specific runtime: FSM loader (esbuild-backed), JSON-RPC
 * transports + client, app-server child-process spawn helpers, per-run
 * hook-script materializer, protocol types and verified method-name
 * constants for the codex `app-server` JSON-RPC surface.
 *
 * Bundle-unsafe for user FSM source: pulls in `ws` (CJS), `child_process`,
 * `node:net`, `esbuild`. User `*.fsm.ts` files MUST NOT import from
 * `@aharness/core/runtime`; they import from the root barrel
 * `@aharness/core` only. The verifier enforces this boundary.
 */

// FSM loader (depends on esbuild — build-time, not authoring).
export { loadFsm } from './loader/index.js';

// JSON-RPC protocol types, notification union, and verified method-name
// constants for the codex `app-server` surface.
export * from './protocol/index.js';

// JSON-RPC client + transports.
export {
  DO_NOT_REPLY,
  JsonRpcClient,
  type NotificationHandler,
  type ServerRequestHandler,
  type Transport,
} from './jsonrpc/client.js';
export { LineFramer } from './jsonrpc/framing.js';
export { connectWs, type WsTransport } from './jsonrpc/wsTransport.js';
export { connectUds, type UdsTransport } from './jsonrpc/udsTransport.js';

// app-server child-process spawn + version gate.
export {
  spawnAppServer,
  waitForWs,
  pickEphemeralPort,
  parseCodexVersion,
  compareSemver,
  checkCodexVersion,
  MIN_CODEX_VERSION,
  type AppServerHandle,
  type SpawnAppServerOptions,
  type VersionGateResult,
} from './appServer/index.js';

// Per-run hook-script materializer + helpers. The aharness does not
// fabricate an ephemeral CODEX_HOME; codex reads the user's `~/.codex/`
// directly, and runCli passes request_user_input plus any declared
// per-state hook wrappers via `--enable` / `-c key=value` CLI overrides.
export {
  materializeHookScripts,
  cleanupCodexHome,
  resolveHookClientPath,
  escapeTomlBasicString,
  type MaterializeHookScriptsInput,
} from './codexHome/index.js';

// Legacy/internal snapshot envelope helpers. Retained for old-run inspection
// and public runtime-surface compatibility; production new runs do not write
// snapshot.json and UI/history/replay rebuild from events.jsonl.
export {
  flushHeadlessSnapshotEnvelope,
  flushPhase1Envelope,
  loadHeadlessSnapshotEnvelope,
  loadPhase1Envelope,
  type HeadlessSnapshotEnvelope,
  type Phase1Envelope,
  type CutoverDetectionResult,
} from './runtime/snapshotEnvelope.js';

// Headless WS transport client (sole-WS-client topology).
export { connectHeadlessWs } from './transport/wsClient.js';
export type { ConnectHeadlessWsOptions, ConnectHeadlessWsResult } from './transport/wsClient.js';

// Headless notification router (sole-WS-client topology). It filters to
// the parent thread and classifies sub-threads off cached
// `receiverThreadIds`.
export { startNotificationRouter } from './transport/notificationRouter.js';
export type {
  NotificationRouterOpts,
  NotificationRouterHandle,
} from './transport/notificationRouter.js';

// `dynamic_tools` registration helper — single source of truth
// for `thread/start.dynamicTools` payload bytes (prompt-cache key
// stability).
export { buildDynamicToolsRegistration } from './transport/dynamicToolsRegistration.js';

// Submit dispatcher: validates aharness_submit args against per-(state, exit)
// sidecar schemas, dry-runs the transition, commits, and dispatches the
// four-step cross-state dance via scheduleCrossStateDance
// when the target is a different stateful state. Retired awaitsOwnerText
// metadata is rejected before runtime; current owner-paced free text uses
// open states plus typed submits. Terminal targets fire onTerminal + reply
// Run complete. Self-loop targets reply 'ok' and let drive-forward kick the
// next turn.
export { createSubmitDispatcher } from './runtime/dispatchSubmit.js';
export type { CreateSubmitDispatcherOpts, SubmitDispatcher } from './runtime/dispatchSubmit.js';

// Drive-forward listener (turn/completed -> terminal shutdown,
// awaiting/open/submitted posture checks, or default
// `turn/start({input: nudge})`).
export { createDriveForward } from './runtime/driveForward.js';
export type { CreateDriveForwardOpts, DriveForwardHandle } from './runtime/driveForward.js';

export { createActiveThreadBinding } from './runtime/activeThreadBinding.js';
export type {
  ActiveThreadBinding,
  ActiveThreadBindingOptions,
} from './runtime/activeThreadBinding.js';
export {
  ABANDONED_THREAD_DYNAMIC_TOOL_MESSAGE,
  DECLINED_ANSWER_TEXT,
  buildAbandonedCommandExecutionApprovalResponse,
  buildAbandonedDynamicToolCallResponse,
  buildAbandonedFileChangeApprovalResponse,
  buildAbandonedMcpServerElicitationResponse,
  buildAbandonedPermissionsApprovalResponse,
  buildAbandonedToolRequestUserInputResponse,
} from './runtime/abandonedThreadResponses.js';

// Declarative clearOnEntry replacement-thread helper.
export { performFreshClear } from './runtime/freshClear.js';
export type { PerformFreshClearOpts } from './runtime/freshClear.js';

// Shared opt-out list passed to `connectHeadlessWs` capabilities.
export { PHASE1_OPT_OUT_METHODS } from './runtime/optOutNotificationMethods.js';

// Phase 3a browser UI substrate: event envelope, replayable SSE log, and
// loopback HTTP server used by the CLI and future browser-app chunks.
export type {
  AgentMessageDelta,
  AbandonedThreadDiagnostic,
  AppEvent,
  FrameworkNote,
  FreshClearBoundary,
  FsmState,
  Posture,
  PostureChange,
  ReplayableAppEvent,
  ResyncRequired,
  RunMeta,
  StateChange,
  TurnCompleted,
  UiAppState,
  UiSnapshot,
  UiTranscriptEntry,
} from './ui/events.js';
export { createUiEventLog, serializeSseEvent } from './ui/sse.js';
export type { UiEventLog, UiEventLogOptions } from './ui/sse.js';
export { startUiServer } from './ui/server.js';
export type { StartUiServerOptions, UiServerHandle } from './ui/server.js';

// Programmatic live-run API. This is the typed sibling to `aharness run` for
// callers that need canonical events and browser-reply-equivalent helpers.
export { startAharnessRun } from './runtime/programmaticRun.js';
export type {
  AharnessApprovalDecision,
  AharnessApprovalResolution,
  AharnessElicitationAction,
  AharnessElicitationResolution,
  AharnessOwnerChoiceInput,
  AharnessOwnerInputAnswer,
  AharnessPermissionResolution,
  AharnessRunEvent,
  AharnessRunHandle,
  AharnessRunPermissionMode,
  AharnessRunReplyResult,
  AharnessRunResult,
  AharnessRunStatus,
  AharnessRunUiOption,
  StartAharnessRunOptions,
} from './runtime/programmaticRun.js';
