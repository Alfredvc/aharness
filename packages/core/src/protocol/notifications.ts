import type { ResponseItem } from './types.js';

/**
 * JSON-RPC notification payloads emitted by the codex `app-server` that
 * the harness runtime observes. Pinned to codex-rs commit
 * `127434cd8b96` (see `SUPPORTED_CODEX.md`). Wire field names are
 * camelCase (every notification struct upstream is decorated with
 * `#[serde(rename_all = "camelCase")]`).
 *
 * The harness consumes a narrow slice of the upstream notification set
 * — drive-forward arbitration, hook lifecycle, item lifecycle, and turn
 * boundaries. Any notification not in this union is treated as a
 * no-op by the router; do not add fields here unless the runtime
 * actually reads them.
 */

/**
 * Narrow `Turn` snapshot embedded in `turn/started` and `turn/completed`.
 * Matches a subset of `app-server-protocol/src/protocol/v2.rs:5193-5211`
 * — the harness reads only `id`. Additional fields (`status`, timing,
 * etc.) are deliberately untyped here and may be added when the
 * notification router or telemetry consumer needs them.
 */
export interface TurnSnapshot {
  id: string;
}

/**
 * `turn/started` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6777-6780`. Note: the upstream
 * payload **does not** carry an `originatorConnectionId` field, so the
 * notification router cannot use it to discriminate drive-forward from
 * user-driven turns. See `SUPPORTED_CODEX.md` §R19 for the heuristic
 * fallback.
 */
export interface TurnStartedNotification {
  method: 'turn/started';
  params: { threadId: string; turn: TurnSnapshot };
}

/**
 * `turn/completed` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6803-6806`.
 */
export interface TurnCompletedNotification {
  method: 'turn/completed';
  params: { threadId: string; turn: TurnSnapshot };
}

/**
 * Narrow `ThreadItem` envelope. Upstream
 * `app-server-protocol/src/protocol/v2.rs:5861-...` defines a wide
 * discriminated union; the harness reads `type` plus the
 * function-call-specific fields produced when codex relays a dynamic
 * tool call's lifecycle as a thread item. All other variants are
 * passed through as `unknown`-typed extra fields.
 */
export type ThreadItem =
  | {
      type: 'functionCall';
      id: string;
      callId: string;
      name: string;
      [k: string]: unknown;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: ReadonlyArray<FileUpdateChange>;
      status?: string;
      [k: string]: unknown;
    }
  | {
      type: 'agentMessage';
      id: string;
      [k: string]: unknown;
    }
  | { type: string; id?: string; [k: string]: unknown };

/**
 * File-change patch kind. Matches `PatchChangeKind` at
 * `app-server-protocol/src/protocol/v2.rs` generated schema
 * (`PatchChangeKind.ts`). The `update` variant carries the upstream
 * snake_case `move_path` payload inside the variant object.
 */
export type PatchChangeKind =
  | { type: 'add' }
  | { type: 'delete' }
  | { type: 'update'; move_path: string | null };

/**
 * One structured file-change entry. Matches `FileUpdateChange` at
 * `app-server-protocol/src/protocol/v2.rs:6553`.
 */
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

/**
 * `item/started` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6877-6881`.
 */
export interface ItemStartedNotification {
  method: 'item/started';
  params: { item: ThreadItem; threadId: string; turnId: string };
}

/**
 * `item/completed` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6939-6943`.
 */
export interface ItemCompletedNotification {
  method: 'item/completed';
  params: { item: ThreadItem; threadId: string; turnId: string };
}

/**
 * `item/fileChange/patchUpdated` notification. Matches
 * `FileChangePatchUpdatedNotification` at
 * `app-server-protocol/src/protocol/v2.rs:7070`.
 */
export interface FileChangePatchUpdatedNotification {
  method: 'item/fileChange/patchUpdated';
  params: {
    threadId: string;
    turnId: string;
    itemId: string;
    changes: ReadonlyArray<FileUpdateChange>;
  };
}

/**
 * Narrow `HookRunSummary` shape used by `hook/started` and
 * `hook/completed`. The runtime reads only the hook event name and
 * (post-completion) the decision; other fields stay `unknown`.
 */
export interface HookRunSummary {
  hookEvent: string;
  decision?: 'block' | 'allow';
  [k: string]: unknown;
}

/**
 * `hook/started` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6785-6789`.
 */
export interface HookStartedNotification {
  method: 'hook/started';
  params: {
    threadId: string;
    /** Optional upstream — `None` for thread-level hooks. */
    turnId?: string;
    run: HookRunSummary;
  };
}

/**
 * `hook/completed` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6811-6815`.
 */
export interface HookCompletedNotification {
  method: 'hook/completed';
  params: {
    threadId: string;
    turnId?: string;
    run: HookRunSummary;
  };
}

/**
 * `item/agentMessage/delta` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6958-6963`.
 */
export interface AgentMessageDeltaNotification {
  method: 'item/agentMessage/delta';
  params: { threadId: string; turnId: string; itemId: string; delta: string };
}

/**
 * `rawResponseItem/completed` notification. Matches
 * `app-server-protocol/src/protocol/v2.rs:6945-6952`. Carries one
 * `ResponseItem` (`protocol/src/models.rs:741-743`); for the harness
 * the relevant variants are `function_call` and `function_call_output`
 * for built-in function tools that do not surface through
 * `item/completed` (see `daemon/awaitResolver.ts` doc-comment).
 *
 * `ResponseItem` is declared in `./types.ts` as the same shape used by
 * `thread/inject_items` — upstream both surfaces share the same Rust
 * type (`#[serde(tag = "type", rename_all = "snake_case")]`,
 * `protocol/src/models.rs:741-743`).
 */
export interface RawResponseItemCompletedNotification {
  method: 'rawResponseItem/completed';
  params: { threadId: string; turnId: string; item: ResponseItem };
}

/**
 * Per-message error envelope. JSON-RPC errors are carried in the
 * `error` field of a request response keyed to the original request id;
 * codex does not emit a discrete `error` notification method. This
 * variant is included in the union so callers that observe transport
 * errors via the JSON-RPC client's error path can route them through
 * the same notification surface.
 */
export interface ErrorNotification {
  method: 'error';
  params: { code: number; message: string };
}

/**
 * `serverRequest/resolved` notification. Matches
 * `ServerRequestResolvedNotification` at
 * `app-server-protocol/src/protocol/v2.rs:7077`. `requestId` is the
 * JSON-RPC request id from the server-initiated request.
 */
export interface ServerRequestResolvedNotification {
  method: 'serverRequest/resolved';
  params: { threadId: string; requestId: string | number };
}

export type ServerNotification =
  | TurnStartedNotification
  | TurnCompletedNotification
  | ItemStartedNotification
  | ItemCompletedNotification
  | FileChangePatchUpdatedNotification
  | HookStartedNotification
  | HookCompletedNotification
  | AgentMessageDeltaNotification
  | RawResponseItemCompletedNotification
  | ServerRequestResolvedNotification
  | ErrorNotification;
