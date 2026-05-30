/**
 * Phase 2a cross-state turn-end dance. Spec §4.3.3 / §5.4.
 *
 * Sequence (run as background promise so the caller can reply `"ok"` to
 * the `item/tool/call` ServerRequest first — see plan Contracts and
 * invariants "Reply-before-dance ordering"):
 *
 *   1. await watcherRegistry.register(callId)
 *        → resolves when codex emits `item/completed` for the satisfied
 *          dynamic tool call (so `drain_in_flight` has recorded the
 *          FunctionCallOutput, preserving R6 atomicity).
 *   2. await client.request('turn/interrupt', {threadId, turnId})
 *        → resolves only after `EventMsg::TurnAborted` fires. Non-fatal
 *          errors ("no active turn to interrupt", "expected active turn
 *          id ...") are logged and swallowed; the dance proceeds.
 *   3. await client.request('turn/start', {threadId, input:[{type:'text',
 *      text: orientationText}]})
 *        → opens a fresh turn whose `input` lands as a TUI-visible
 *          `ResponseItem::UserMessage` in the rollout (CF-23, M14).
 *
 * Watcher registration MUST complete synchronously inside the dispatch
 * path BEFORE the dispatcher returns its reply: otherwise codex's
 * `item/completed` could arrive before the watcher exists. To preserve
 * that, this function calls `register(callId)` synchronously (the
 * watcher's own contract guarantees synchronous bookkeeping), stores
 * the returned match-promise inside the background closure, and only
 * `await`s it after returning.
 */
import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type {
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
} from '../protocol/types.js';
import type { ItemCompletedWatcherRegistry } from '../transport/itemCompletedWatcher.js';
import type { ActiveThreadBinding } from './activeThreadBinding.js';

export interface ScheduleCrossStateDanceOpts {
  readonly client: JsonRpcClient;
  readonly watcherRegistry: ItemCompletedWatcherRegistry;
  readonly activeThreadBinding: ActiveThreadBinding;
  /** Captured at dispatch entry; non-empty. The turn is still in-flight at reply time. */
  readonly turnId: string;
  /** The `dynamic_tools` callId echoed by codex on the `item/completed` match. */
  readonly callId: string;
  /**
   * The full composed nudge for the new state (header + exits + schema +
   * entryPrompt + optional `awaitsOwnerText` preamble + optional
   * `stopGuidance`) — NOT the raw `entryPrompt`. Computed by the
   * dispatcher AFTER `host.commitSubmit` so the live host reads from the
   * new leaf.
   */
  readonly orientationText: string;
  /**
   * Invoked synchronously before scheduling so drive-forward's
   * `submittedThisTurn` predicate flips before any `turn/completed`
   * arrives. The dance owns the next `turn/start`; drive-forward must
   * not double-fire.
   */
  readonly markSubmittedThisTurn: () => void;
  /**
   * Apply pending state-model settings before the post-submit `turn/start`.
   * Intended for non-clear states where the next thread settings must be
   * pushed via `thread/settings/update`.
   */
  readonly applyStateModel?: () => Promise<void>;
  /**
   * Defensive cleanup if the dance throws unexpectedly. The dance owns
   * the lifecycle of the flag for this turn; the flag is also
   * auto-cleared on the next `turn/started`.
   */
  readonly clearSubmittedThisTurn?: () => void;
  /** Non-fatal logging hook; default: write to stderr. */
  readonly onError?: (e: Error) => void;
  /**
   * Fatal state-model application failure hook. Settings update failures
   * deliberately suppress drive-forward salvage because issuing the next
   * aharness-owned turn would violate the target state's model contract.
   */
  readonly onStateModelFailure?: (e: Error) => void;
  /**
   * F1 salvage entry point. Invoked from the outer catch AFTER
   * `clearSubmittedThisTurn?.()` and AFTER `onError?.(err)` so the run
   * recovers from a dance failure (watcher timeout, unknown
   * `turn/interrupt` error, `turn/start` error) by re-entering
   * drive-forward's default branch — which issues a fresh `turn/start`
   * with the active state's nudge. Without this hook the run wedges:
   * drive-forward already returned void for the failing turn (because
   * `submittedThisTurn` was true at the time), and there is no other
   * `turn/start` producer for the now-active state.
   *
   * Ordering rationale: the clear must precede the salvage because
   * drive-forward consults `submittedThisTurn` as a benign predicate;
   * the onError must precede the salvage because the salvage may itself
   * trigger further events that callers want to disambiguate from the
   * original failure in their logs.
   */
  readonly requestDriveForwardSalvage?: () => void;
}

/**
 * Regex test for the two non-fatal `turn/interrupt` failure modes
 * documented at `protocol/types.ts:222-227`:
 *
 *   - "no active turn to interrupt"  — codex had no in-flight turn.
 *   - "expected active turn id ..."  — the captured `turnId` is stale.
 *
 * In both cases the prior turn is effectively already aborted (or never
 * existed), so the dance proceeds to `turn/start` with the new
 * orientation rather than crashing the run.
 */
function isNonFatalInterruptError(e: Error): boolean {
  const msg = e.message ?? '';
  return /no active turn to interrupt/.test(msg) || /expected active turn id/.test(msg);
}

function defaultErrorSink(e: Error): void {
  process.stderr.write(`[crossStateDance] ${e.message}\n`);
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function scheduleCrossStateDance(o: ScheduleCrossStateDanceOpts): void {
  // Register the watcher synchronously BEFORE the dispatcher returns its
  // reply. The watcher's own contract (see itemCompletedWatcher.ts)
  // guarantees that `register()` completes all bookkeeping (map insert +
  // timeout install) synchronously, so by the time this line returns,
  // the registry will dispatch a matching `item/completed`.
  const matched = o.watcherRegistry.register(o.callId);
  o.markSubmittedThisTurn();

  void (async () => {
    let suppressSalvage = false;
    let stateModelError: Error | undefined;
    try {
      await matched;
      try {
        await o.client.request<TurnInterruptResponse>(METHOD.turnInterrupt, {
          threadId: o.activeThreadBinding.require(),
          turnId: o.turnId,
        } satisfies TurnInterruptParams);
      } catch (e) {
        const err = e as Error;
        if (!isNonFatalInterruptError(err)) throw err;
        // Non-fatal: prior turn is effectively already aborted; proceed
        // to `turn/start`. Per the pseudocode in the plan this branch is
        // swallowed silently — the surfaced error path is reserved for
        // unexpected failures (timeouts, other JSON-RPC errors).
      }
      if (o.applyStateModel !== undefined) {
        try {
          await o.applyStateModel();
        } catch (e) {
          stateModelError = asError(e);
          suppressSalvage = true;
          throw stateModelError;
        }
      }
      await o.client.request<TurnStartResponse>(METHOD.turnStart, {
        threadId: o.activeThreadBinding.require(),
        input: [{ type: 'text', text: o.orientationText }],
      } satisfies TurnStartParams);
    } catch (e) {
      // F1 salvage ordering — see `requestDriveForwardSalvage` doc:
      //   1) clear the per-turn flag so drive-forward's default branch
      //      is reachable on the salvage re-entry,
      //   2) surface the original failure to the error sink,
      //   3) ask drive-forward to issue a recovery `turn/start`.
      const err = asError(e);
      o.clearSubmittedThisTurn?.();
      (o.onError ?? defaultErrorSink)(err);
      if (stateModelError !== undefined) {
        o.onStateModelFailure?.(stateModelError);
      }
      if (!suppressSalvage) {
        o.requestDriveForwardSalvage?.();
      }
    }
  })();
}
