/**
 * Verified JSON-RPC method-name constants for the codex `app-server`
 * surface the aharness consumes. This module is the **single source of
 * truth** for wire literals; downstream call sites must reference
 * `METHOD.<name>` instead of inlining string literals so a codex pin
 * bump can update every site by editing one file.
 *
 * Verification: every literal below was confirmed against codex-rs at
 * pinned commit `127434cd8b96` (see `SUPPORTED_CODEX.md` §R18). Source
 * paths are recorded inline. The verification grep was:
 *
 *   git grep -nE '"(thread|tool|turn|item|hook|response|user_input|userInput|initialize)/[a-zA-Z_/]*"' \
 *     app-server-protocol/src protocol/src
 *
 * On bump: re-run the grep, diff the output against this table, and
 * update both the literal and any consuming call sites if a wire name
 * changes.
 *
 * Notes on shape:
 *
 * - `thread/subscribe` does **not** exist at the pinned commit.
 *   Subscriptions are an implicit side-effect of `thread/start` and
 *   `thread/resume`; only `thread/unsubscribe` is callable to detach.
 *   See `SUPPORTED_CODEX.md` §R18 entry for `threadSubscribe`.
 * - `error` is **not** a discrete method name; codex returns errors via
 *   the JSON-RPC error envelope keyed to the originating request id.
 *   The constant is omitted accordingly.
 */
export const METHOD = {
  // Standard JSON-RPC handshake. Not declared via codex's protocol
  // macro table (no source line); part of the JSON-RPC 2.0 spec.
  initialize: 'initialize',

  // Thread-level requests.
  // app-server-protocol/src/protocol/common.rs:434
  threadStart: 'thread/start',
  // app-server-protocol/src/protocol/common.rs:440
  threadResume: 'thread/resume',
  // docs/specs/2026-05-12-headless-architecture-design.md records the
  // pinned upstream `thread/rollback` paths.
  threadRollback: 'thread/rollback',
  // app-server-protocol/src/protocol/common.rs:575
  threadInjectItems: 'thread/inject_items',
  // app-server-protocol/src/protocol/common.rs:481
  threadNameSet: 'thread/name/set',
  // app-server-protocol/src/protocol/common.rs:457
  threadUnsubscribe: 'thread/unsubscribe',

  // Turn-level requests.
  // app-server-protocol/src/protocol/common.rs:717
  turnStart: 'turn/start',
  // app-server-protocol/src/protocol/common.rs:729
  // (`TurnInterrupt => "turn/interrupt"`). Server request issued by the
  // daemon to abort the in-flight turn before issuing a fresh `turn/start`
  // with the new state's orientation. See cross-state turn-end design §4.1.
  // The codex JSON-RPC connection holds the request open until the abort
  // is confirmed by core (pending_interrupts queue drained when
  // EventMsg::TurnAborted fires; see app-server/src/bespoke_event_handling.rs:1117).
  // No corresponding `turn/aborted` notification exists in the v2 enum (§1.6).
  turnInterrupt: 'turn/interrupt',

  // Server-issued requests (the daemon handles these).
  // app-server-protocol/src/protocol/common.rs:1234
  // (`CommandExecutionRequestApproval => "item/commandExecution/requestApproval"`).
  commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  // app-server-protocol/src/protocol/common.rs:1241
  // (`FileChangeRequestApproval => "item/fileChange/requestApproval"`).
  fileChangeRequestApproval: 'item/fileChange/requestApproval',
  // app-server-protocol/src/protocol/common.rs:1265
  // (`DynamicToolCall => "item/tool/call"`).
  toolDynamicCall: 'item/tool/call',
  // app-server-protocol/src/protocol/common.rs:1247
  // (`ToolRequestUserInput => "item/tool/requestUserInput"`).
  toolRequestUserInput: 'item/tool/requestUserInput',
  // app-server-protocol/src/protocol/common.rs:1253
  // (`McpServerElicitationRequest => "mcpServer/elicitation/request"`).
  mcpServerElicitationRequest: 'mcpServer/elicitation/request',
  // app-server-protocol/src/protocol/common.rs:1259
  // (`PermissionsRequestApproval => "item/permissions/requestApproval"`).
  permissionsRequestApproval: 'item/permissions/requestApproval',

  // Notifications (server → client, no response).
  // app-server-protocol/src/protocol/common.rs:1354
  // (`ThreadStarted => "thread/started" (v2::ThreadStartedNotification)`).
  // Emitted after `thread/start` / `thread/resume`; the headless aharness
  // CLI is the sole WebSocket client for the run.
  threadStarted: 'thread/started',
  // app-server-protocol/src/protocol/common.rs:1387
  turnStarted: 'turn/started',
  // app-server-protocol/src/protocol/common.rs:1389
  turnCompleted: 'turn/completed',
  // app-server-protocol/src/protocol/common.rs:1393
  itemStarted: 'item/started',
  // app-server-protocol/src/protocol/common.rs:1396
  itemCompleted: 'item/completed',
  // app-server-protocol/src/protocol/common.rs:1408
  // (`FileChangePatchUpdated => "item/fileChange/patchUpdated"`).
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  // app-server-protocol/src/protocol/common.rs ServerNotification table,
  // `ServerRequestResolved => "serverRequest/resolved"`.
  serverRequestResolved: 'serverRequest/resolved',
  // app-server-protocol/src/protocol/common.rs:1388
  hookStarted: 'hook/started',
  // app-server-protocol/src/protocol/common.rs:1390
  hookCompleted: 'hook/completed',
  // app-server-protocol/src/protocol/common.rs:1399
  agentMessageDelta: 'item/agentMessage/delta',
  // app-server-protocol/src/protocol/common.rs:1398
  // (`RawResponseItemCompleted => "rawResponseItem/completed"`).
  // Carries `function_call` / `function_call_output` `ResponseItem`s
  // for built-in function tools (e.g. `request_user_input`) that are
  // not surfaced through `item/completed`'s `ThreadItem` union; see
  // `daemon/awaitResolver.ts` for the citation chain.
  rawResponseItemCompleted: 'rawResponseItem/completed',
  // app-server-protocol/src/protocol/v2.rs `ServerNotification`
  // discriminant `ThreadTokenUsageUpdated => "thread/tokenUsage/updated"`.
  // Params shape: `ThreadTokenUsageUpdatedNotification { threadId,
  // turnId, tokenUsage: { total, last, modelContextWindow } }` where
  // each breakdown is `{ totalTokens, inputTokens, cachedInputTokens,
  // outputTokens, reasoningOutputTokens }` — camelCase wire-side.
  // Emitted per-turn from `bespoke_event_handling.rs::handle_token_count_event`.
  threadTokenUsageUpdated: 'thread/tokenUsage/updated',

  // app-server-protocol/src/protocol/common.rs:796
  // (`ListMcpServerStatus => "mcpServerStatus/list"`). Returns the
  // per-server MCP startup status (tools advertised, optional
  // startup-error string). Retained as a typed protocol literal for
  // diagnostics and future author-declared tool surfaces; the live
  // submit path uses `dynamic_tools`, not an aharness MCP server.
  mcpServerStatusList: 'mcpServerStatus/list',

  // app-server-protocol/src/protocol/common.rs:770
  // (`ModelList => "model/list"`). Used by verify/runtime clearOnEntry
  // catalog checks to validate requested model and reasoning-effort pairs.
  modelList: 'model/list',

  // app-server-protocol/src/protocol/common.rs:904
  // (`ConfigRead => "config/read"`). Used by clearOnEntry effort-only
  // checks to resolve the effective model for a statically known cwd.
  configRead: 'config/read',
} as const;

export type MethodName = (typeof METHOD)[keyof typeof METHOD];
