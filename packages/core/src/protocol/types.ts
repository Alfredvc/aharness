/**
 * JSON-RPC types for the Codex `app-server` surface that `@aharness/core`
 * consumes. Pinned to codex-rs commit `127434cd8b96` (see
 * `SUPPORTED_CODEX.md`).
 *
 * Wire convention: every codex `app-server` request/response struct uses
 * `#[serde(rename_all = "camelCase")]`, so the wire field names emitted by
 * the server are camelCase even though the Rust source declares
 * `snake_case`. The TypeScript types below mirror the **wire** field
 * names verbatim.
 *
 * Scope rule: this module declares only the subset of fields the harness
 * runtime reads or writes. Each interface is annotated with the upstream
 * Rust struct path (file:line at the pinned commit) so future bumps can
 * re-verify shape stability. Adding a field that the harness does not
 * actually use is forbidden — keep this module narrow.
 */

/**
 * Minimal JSON value alias used for fields the codex protocol declares as
 * `serde_json::Value` (e.g. `DynamicToolCallParams.arguments`). Kept local
 * to this module until the JSON-RPC client lands a shared definition.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [k: string]: JsonValue };

/** JSON-RPC `initialize` handshake — wire shape (camelCase per codex's `rename_all = "camelCase"`). Spec §3 step 6, CF-19. */
export interface InitializeParams {
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly capabilities?: {
    readonly experimentalApi?: boolean;
    readonly requestAttestation?: boolean;
    /** Notification methods the harness opts out of receiving. Codex's `OutgoingMessageSender` honours this for both parent and auto-attached sub-thread notifications (CF-17). Spec §5.7. */
    readonly optOutNotificationMethods?: ReadonlyArray<string>;
    readonly [k: string]: unknown;
  };
}

export interface InitializeResult {
  readonly serverInfo: { readonly name: string; readonly version: string };
}

/** CF-19: clients sending this `clientInfo.name` skip codex's process-global originator + user-agent mutation. The harness CLI MUST use this value. */
export const DAEMON_PROBE_CLIENT_NAME = 'codex_app_server_daemon';

/**
 * Dynamic tool declaration sent in `thread/start.dynamicTools`. Matches
 * `app-server-protocol/src/protocol/v2.rs:670-681` (`DynamicToolSpec`).
 *
 * Wire fields are camelCase: `inputSchema` (NOT `input_schema`),
 * `deferLoading` (NOT `defer_loading`). The wire key is `inputSchema`,
 * not `parameters`; do not rename it on the way out.
 */
export interface DynamicToolDef {
  namespace?: string;
  name: string;
  description: string;
  /** JSON Schema describing the tool's argument shape. */
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
  /** When `true`, codex skips its synchronous `requires_mcp_tool_approval` prompt. The harness always sets this on `harness_submit`. Spec §4.3.1. */
  readOnlyHint?: boolean;
}

/**
 * `thread/start` request params. Matches
 * `app-server-protocol/src/protocol/v2.rs:3548-3618`. The full upstream
 * struct carries ~20 optional fields; only the fields the harness sets
 * are typed here. Add additional fields as new call sites emerge.
 */
export interface ThreadStartParams {
  baseInstructions?: string;
  dynamicTools?: ReadonlyArray<DynamicToolDef>;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  ephemeral?: boolean;
  /** `v2.rs:502-508`, `v2.rs:3591`: startup for initial threads, clear for replacement threads. */
  sessionStartSource?: ThreadStartSource;
}

export type ThreadStartSource = 'startup' | 'clear';

/**
 * Narrowed `Thread` payload returned by `thread/start` and present on
 * several notifications. Matches the subset of
 * `app-server-protocol/src/protocol/v2.rs:5083-5122` the harness reads.
 */
export interface ThreadSnapshot {
  id: string;
  ephemeral: boolean;
}

/**
 * `thread/start` response. Matches
 * `app-server-protocol/src/protocol/v2.rs:3641-3669`. Upstream returns
 * many policy fields alongside the thread; the harness only reads the
 * thread itself, but the wire envelope nests it under `thread`.
 */
export interface ThreadStartResponse {
  thread: ThreadSnapshot;
}

/**
 * Alias kept so downstream call sites (and the original task plan) can
 * import the response by either name. The actual wire shape is the
 * `ThreadStartResponse` struct above; legacy `ThreadStartResult`
 * naming predates verification against codex source.
 */
export type ThreadStartResult = ThreadStartResponse;

/**
 * `thread/resume` request params. Matches
 * `app-server-protocol/src/protocol/v2.rs:3685-...`. Upstream carries
 * many optional override fields; only `threadId` is required and used
 * here.
 */
export interface ThreadResumeParams {
  threadId: string;
}

/**
 * `thread/resume` response. Returns the same envelope shape as
 * `thread/start` (verified at `v2.rs` ResumeResponse declaration); the
 * harness reads only the thread snapshot.
 */
export interface ThreadResumeResponse {
  thread: ThreadSnapshot;
}

/**
 * `thread/rollback` request params. CF-4 records the pinned upstream
 * paths in `docs/specs/2026-05-12-headless-architecture-design.md`.
 */
export interface ThreadRollbackParams {
  threadId: string;
  numTurns: number;
}

/** `thread/rollback` response: empty object on success. */
export type ThreadRollbackResponse = Record<string, never>;

/**
 * `thread/started` notification params. Emitted immediately after a
 * successful `thread/start` request. Matches
 * `app-server-protocol/src/protocol/v2.rs:6606` (`ThreadStartedNotification
 * { thread: Thread }`, camelCase wire-side). The headless harness CLI is
 * the sole WebSocket client for the run.
 */
export interface ThreadStartedNotification {
  thread: ThreadSnapshot;
}

/** `thread/name/set` request params. Matches
 * `app-server-protocol/src/protocol/v2.rs:3968-3971`. */
export interface ThreadNameSetParams {
  threadId: string;
  name: string;
}

/** `thread/name/set` response. Matches `v2.rs:3983` (empty struct). */
export type ThreadNameSetResponse = Record<string, never>;

/** `thread/unsubscribe` request params. Matches `v2.rs:3905-3907`. */
export interface ThreadUnsubscribeParams {
  threadId: string;
}

/** `thread/unsubscribe` status. Matches `v2.rs:3917-3921` (`rename_all = "camelCase"`). */
export type ThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed';

/** `thread/unsubscribe` response. Matches `v2.rs:3912-3914`. */
export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
}

/**
 * Codex Responses-API item shape used as the wire payload for
 * `thread/inject_items.items` (which is declared upstream as raw
 * `JsonValue`, with the harness conforming to the Responses API
 * envelope). This is a narrow union covering only the variants the
 * harness emits/consumes.
 */
export type ResponseItem =
  | {
      type: 'message';
      role: 'user' | 'assistant' | 'developer' | 'system';
      content: ReadonlyArray<{ type: 'input_text' | 'output_text'; text: string }>;
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: string; [k: string]: unknown };

/**
 * `thread/inject_items` request params. Matches
 * `app-server-protocol/src/protocol/v2.rs:5664-5668`. Upstream types the
 * `items` field as `Vec<JsonValue>` because it accepts raw Responses-API
 * payloads; the harness emits the narrower `ResponseItem` shape above.
 */
export interface ThreadInjectItemsParams {
  threadId: string;
  items: ReadonlyArray<ResponseItem>;
}

/** `thread/inject_items` response. Matches `v2.rs:5673` (empty). */
export type ThreadInjectItemsResponse = Record<string, never>;

/**
 * `UserInput` variant the harness emits in `turn/start.input`. Matches
 * `app-server-protocol/src/protocol/v2.rs:5785-5806`. The harness only
 * sends `Text` inputs; other variants (Image, LocalImage, Skill,
 * Mention) are not modelled here.
 */
export interface UserInputText {
  type: 'text';
  text: string;
}
export type UserInput = UserInputText;

/**
 * `turn/start` request params. Matches
 * `app-server-protocol/src/protocol/v2.rs:5529-5599`. Only `threadId` and
 * `input` are required and used here.
 */
export interface TurnStartParams {
  threadId: string;
  input: ReadonlyArray<UserInput>;
}

/**
 * `turn/start` response. Matches
 * `app-server-protocol/src/protocol/v2.rs:5657-5659`. Carries a `Turn`
 * snapshot; the harness reads `id` only.
 */
export interface TurnStartResponse {
  turn: { id: string };
}

/**
 * `turn/interrupt` request params. Matches
 * `app-server-protocol/src/protocol/v2.rs:5702-5706` (camelCase wire).
 * The daemon must supply both the active `threadId` and the captured
 * `turnId`; codex validates `turnId` against the live `active_turn.id`
 * (`app-server/src/request_processors/turn_processor.rs:1037-1046`) and
 * returns an error if stale ("expected active turn id ... but found ...").
 * If no turn is active, the request errors with "no active turn to
 * interrupt"; the daemon treats both as non-fatal (spec §5.6 path 1) and
 * proceeds to issue `turn/start`.
 */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/**
 * `turn/interrupt` response. Codex returns an empty body once it has
 * confirmed the abort: the request stays open in
 * `app-server/src/request_processors/turn_processor.rs:1027` until
 * `EventMsg::TurnAborted` fires in core, at which point
 * `bespoke_event_handling.rs:1117-1134` drains `pending_interrupts` and
 * sends `TurnInterruptResponse {}` to each waiter. The await therefore
 * IS the abort-confirmed signal — no separate notification subscription
 * is required (spec §1.6).
 */
export type TurnInterruptResponse = Record<string, never>;

/**
 * Server-request: `item/tool/call`. Matches
 * `app-server-protocol/src/protocol/v2.rs:7740-7747`
 * (`DynamicToolCallParams`). Note: `tool` is the tool name and
 * `arguments` is a JSON value (NOT a JSON string — codex deserialises it
 * as `JsonValue`). `turnId` and `namespace` are present on the wire even
 * though earlier drafts of the harness design omitted them.
 */
export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string;
  tool: string;
  arguments: JsonValue;
}

/**
 * Discriminated content-item returned by `item/tool/call`. Matches
 * `DynamicToolCallOutputContentItem` at
 * `app-server-protocol/src/protocol/v2.rs:7795-7800` (camelCase serde).
 */
export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

/**
 * Server-request response: `item/tool/call`. Matches
 * `app-server-protocol/src/protocol/v2.rs:7786-7789`
 * (`DynamicToolCallResponse`).
 */
export interface DynamicToolCallResponse {
  contentItems: ReadonlyArray<DynamicToolCallOutputContentItem>;
  success: boolean;
}

/**
 * Single option attached to a request_user_input question. Matches
 * `ToolRequestUserInputOption` at
 * `app-server-protocol/src/protocol/v2.rs:7819-7822`. Note: option
 * entries are objects (`{label, description}`), not bare strings.
 */
export interface RequestUserInputOption {
  label: string;
  description: string;
}

/**
 * Question payload of a `item/tool/requestUserInput` server-request.
 * Matches `ToolRequestUserInputQuestion` at
 * `app-server-protocol/src/protocol/v2.rs:7828-7837` (camelCase serde).
 * `isOther` and `isSecret` default to `false` upstream and are required
 * on the wire when emitted.
 */
export interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: ReadonlyArray<RequestUserInputOption>;
}

/**
 * Server-request: `item/tool/requestUserInput`. Matches
 * `ToolRequestUserInputParams` at
 * `app-server-protocol/src/protocol/v2.rs:7843-7848`.
 */
export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ReadonlyArray<RequestUserInputQuestion>;
}

/**
 * Single answer entry. Matches `ToolRequestUserInputAnswer` at
 * `app-server-protocol/src/protocol/v2.rs:7854-7856`.
 */
export interface RequestUserInputAnswer {
  answers: ReadonlyArray<string>;
}

/**
 * Server-request response: `item/tool/requestUserInput`. Matches
 * `ToolRequestUserInputResponse` at
 * `app-server-protocol/src/protocol/v2.rs:7862-7864`. Wire shape is
 * `{answers: HashMap<questionId, {answers: string[]}>}`.
 */
export interface ToolRequestUserInputResponse {
  answers: Record<string, RequestUserInputAnswer>;
}

/**
 * Browser-emitted approval decisions for command and file-change
 * approvals. Pinned Codex also supports command amendment object
 * decisions (`v2.rs:1268`) but Phase 4a does not emit them.
 */
export type BrowserApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/**
 * Server-request: `item/commandExecution/requestApproval`. Narrow subset
 * of `CommandExecutionRequestApprovalParams` at
 * `app-server-protocol/src/protocol/v2.rs:7179`. Some approval variants
 * (for example network-only prompts) may omit `command` and `cwd`.
 */
export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  networkApprovalContext?: JsonValue | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: ReadonlyArray<JsonValue> | null;
  proposedExecpolicyAmendment?: JsonValue | null;
  proposedNetworkPolicyAmendments?: ReadonlyArray<JsonValue> | null;
}

/**
 * Server-request response: `item/commandExecution/requestApproval`.
 * Matches the string decisions the browser path emits. Upstream accepts
 * additional object decisions; keep this response narrow until the UI
 * implements those actions.
 */
export interface CommandExecutionRequestApprovalResponse {
  decision: BrowserApprovalDecision;
}

/**
 * Server-request: `item/fileChange/requestApproval`. Matches
 * `FileChangeRequestApprovalParams` at
 * `app-server-protocol/src/protocol/v2.rs:7252`. File path and diff data
 * are intentionally absent; they come from `ThreadItem::FileChange` and
 * `item/fileChange/patchUpdated`.
 */
export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

/** Server-request response: `item/fileChange/requestApproval`. */
export interface FileChangeRequestApprovalResponse {
  decision: BrowserApprovalDecision;
}

/**
 * Permission profiles are treated as opaque JSON-compatible structures in
 * 4a. Codex owns the detailed filesystem/network schema; the dispatcher
 * stores, echoes, or empties these profiles without interpreting them.
 */
export interface RequestPermissionProfile {
  network: JsonValue | null;
  fileSystem: JsonValue | null;
}

export interface GrantedPermissionProfile {
  network?: JsonValue;
  fileSystem?: JsonValue;
}

export type PermissionGrantScope = 'turn' | 'session';

/**
 * Server-request: `item/permissions/requestApproval`. Matches the fields
 * the Phase 4a browser path needs from
 * `PermissionsRequestApprovalParams` at
 * `app-server-protocol/src/protocol/v2.rs:7752`.
 */
export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: RequestPermissionProfile;
}

/**
 * Server-request response: `item/permissions/requestApproval`. A decline
 * is represented as an empty granted profile with `scope: "turn"` and no
 * `strictAutoReview`, matching app-server's malformed-response fallback.
 */
export interface PermissionsRequestApprovalResponse {
  permissions: GrantedPermissionProfile;
  scope: PermissionGrantScope;
  strictAutoReview?: boolean;
}

export type McpServerElicitationAction = 'accept' | 'decline' | 'cancel';

export interface McpServerElicitationBaseParams {
  threadId: string;
  turnId: string | null;
  serverName: string;
  _meta: JsonValue | null;
  message: string;
}

/**
 * Server-request: `mcpServer/elicitation/request`. Matches
 * `McpServerElicitationRequestParams` at
 * `app-server-protocol/src/protocol/v2.rs:7314`, narrowed to the two
 * request modes the browser renders.
 */
export type McpServerElicitationRequestParams =
  | (McpServerElicitationBaseParams & {
      mode: 'form';
      requestedSchema: JsonValue;
    })
  | (McpServerElicitationBaseParams & {
      mode: 'url';
      url: string;
      elicitationId: string;
    });

/**
 * Server-request response: `mcpServer/elicitation/request`. Browser
 * `values` map to upstream `content`; decline/cancel use `content: null`.
 */
export interface McpServerElicitationRequestResponse {
  action: McpServerElicitationAction;
  content: JsonValue | null;
  _meta: JsonValue | null;
}

/**
 * Per-server MCP status entry. Subset of `McpServerStatus` at
 * `app-server-protocol/src/protocol/v2.rs:2708`. Codex emits the full
 * struct (transport spec, environment, OAuth fields…); the harness
 * reads only the three fields below.
 *
 * `tools` is keyed by the **unqualified** tool name (server-local) — the
 * `mcp__<server>__<tool>` qualification happens later in codex's
 * `qualify_tools` (`codex-mcp/src/tools.rs:138-228`). The live harness
 * submit path does not use this surface.
 *
 * `error` is set when the MCP child failed to start; in that case
 * `tools` is empty.
 */
export interface McpServerStatus {
  name: string;
  /** Map keyed by tool name (server-local, unqualified). */
  tools: Record<string, unknown>;
  /** When the MCP child failed startup, the error string codex captured. */
  error?: string;
}

/**
 * `mcpServerStatus/list` response. Subset of
 * `ListMcpServerStatusResponse` at
 * `app-server-protocol/src/protocol/v2.rs:2719`. Pagination via
 * `nextCursor` is exposed. The live harness submit path uses
 * `dynamic_tools`; this type remains available for diagnostics and any
 * future author-declared MCP/tool surfaces.
 */
export interface ListMcpServerStatusResponse {
  data: ReadonlyArray<McpServerStatus>;
  nextCursor?: string;
}
