/**
 * Phase 2a `item/completed` watcher registry. Spec §5.3.
 *
 * Cross-state submit dance step 1: when the dispatcher routes a
 * cross-state `harness_submit`, it must wait for codex to confirm the
 * satisfied dynamic tool call (the `item/completed` payload whose
 * `ThreadItem::DynamicToolCall.id` field echoes the dispatcher's
 * `DynamicToolCallParams.call_id`) before issuing `turn/interrupt`.
 * Without that confirmation, `turn/interrupt` would hard-abort the turn
 * before `drain_in_flight` records the FunctionCallOutput, leaving a
 * dangling FunctionCall and violating R6.
 *
 * FIFO match key is the `dynamic_tools` `callId` value the dispatcher
 * registered (CF-15); codex carries it on the lifecycle item under the
 * `id` field (see `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
 * `ThreadItem::DynamicToolCall { id, … }` and `event_mapping.rs`
 * `id: response.call_id`). The single-watcher-at-a-time invariant is
 * guaranteed by codex's per-turn write lock on `harness_submit` dispatch
 * (`harness_submit` is NOT opted into `parallel_mcp_server_names`), so
 * we do not need to serialise here.
 *
 * Pure module: no JsonRpcClient dependency. The notification router
 * calls `dispatch(item)` on every parent `item/completed`.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RegisterOpts {
  readonly timeoutMs?: number;
}

export interface ItemCompletedWatcherRegistry {
  /**
   * Register a watcher for the given `dynamic_tools` `callId`. Returns a
   * Promise that resolves with the matched `item` payload, or rejects
   * with a timeout error after `opts.timeoutMs` (default 30 000 ms).
   *
   * ALL bookkeeping (map insert + `setTimeout` install) completes
   * synchronously before the returned Promise's executor finishes; the
   * Promise represents only the future match.
   *
   * Re-registering for an already-pending `callId` throws synchronously.
   */
  register(callId: string, opts?: RegisterOpts): Promise<unknown>;
  /**
   * Called from `notificationRouter.onItemCompleted`. Returns `true`
   * when the item matched a pending watcher (which is then deregistered),
   * `false` otherwise. Match logic reads `item.type === 'dynamicToolCall'`
   * and `item.id === <registered callId>` — the discriminator field on
   * `ThreadItem` is `type` (camelCase per the `#[serde(rename_all =
   * "camelCase")]` tag) and the `DynamicToolCall` variant carries the
   * dispatcher's `callId` value on its `id` field.
   */
  dispatch(item: unknown): boolean;
  /** Diagnostics: snapshot of currently-pending callIds. */
  getPending(): ReadonlyArray<string>;
}

interface PendingEntry {
  readonly resolve: (item: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createItemCompletedWatcherRegistry(): ItemCompletedWatcherRegistry {
  const pending = new Map<string, PendingEntry>();

  return {
    register(callId: string, opts?: RegisterOpts): Promise<unknown> {
      if (pending.has(callId)) {
        throw new Error(`itemCompletedWatcher: duplicate registration for callId=${callId}`);
      }
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      let resolveFn!: (item: unknown) => void;
      let rejectFn!: (err: Error) => void;
      const promise = new Promise<unknown>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });

      const timer = globalThis.setTimeout(() => {
        if (pending.delete(callId)) {
          rejectFn(
            new Error(`itemCompletedWatcher: timeout after ${timeoutMs}ms for callId=${callId}`),
          );
        }
      }, timeoutMs);

      pending.set(callId, { resolve: resolveFn, timer });
      return promise;
    },

    dispatch(item: unknown): boolean {
      if (item === null || typeof item !== 'object') return false;
      const i = item as { type?: unknown; id?: unknown };
      if (i.type !== 'dynamicToolCall') return false;
      if (typeof i.id !== 'string') return false;
      const entry = pending.get(i.id);
      if (!entry) return false;
      pending.delete(i.id);
      globalThis.clearTimeout(entry.timer);
      entry.resolve(item);
      return true;
    },

    getPending(): ReadonlyArray<string> {
      return [...pending.keys()];
    },
  };
}
