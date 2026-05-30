/**
 * Phase 1 + 2a + 2b drive-forward listener. Spec §3 run loop, §4.3.2.
 *
 * Drive-forward fires on every `turn/completed` notification observed
 * by the transport-layer notification router. Posture branches (in order):
 *
 *  - `isAwaiting()` true → return without issuing a turn/start (a
 *    request_user_input ServerRequest is parked; codex holds the turn
 *    open via the tool call).
 *  - `isOpen()` true (Phase 3c) → return without issuing a fresh
 *    `turn/start`; browser free-text owns the next turn.
 *  - `submittedThisTurn()` true (Phase 2a) → return without issuing a
 *    fresh `turn/start`. The cross-state dispatcher's dance owns the
 *    next turn-start; drive-forward must not double-fire.
 *  - `isTerminal()` → call `onShutdown()` (the dispatcher's terminal
 *    reply has already landed; the model's last turn is over and the
 *    run is complete).
 *  - default → issue `turn/start({threadId, input: [{type:'text',
 *    text: composeActiveStateNudge()}]})` so the model's next turn
 *    opens with the (re-rendered) active state's nudge as a
 *    TUI-visible user message.
 *
 * Ordering rationale for `submittedThisTurn` BETWEEN the posture
 * predicates (`isAwaiting` / `isOpen`) and the
 * `isTerminal()` branch: a cross-state submit into a terminal state
 * would still want the terminal-shutdown branch to fire — and it
 * cannot, because the dispatcher's terminal path is caught before the
 * cross-state path (no dance scheduled, no flag set). So
 * `submittedThisTurn` lives strictly between the posture predicates
 * (`isAwaiting` / `isOpen`) and `isTerminal()`.
 *
 * After a self-loop submit the model's turn ends and we MUST kick a new
 * turn or the run deadlocks; self-loop does not set
 * `submittedThisTurn`, so the default branch fires for it.
 */
import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type { TurnStartParams, TurnStartResponse } from '../protocol/types.js';
import type { ActiveThreadBinding } from './activeThreadBinding.js';

export interface CreateDriveForwardOpts {
  readonly client: JsonRpcClient;
  readonly activeThreadBinding: ActiveThreadBinding;
  readonly isTerminal: () => boolean;
  readonly composeActiveStateNudge: () => string;
  readonly onShutdown: () => void | Promise<void>;
  /**
   * Phase 2b: returns true when a `request_user_input` ServerRequest is
   * parked awaiting the owner's reply. When true, drive-forward returns
   * without issuing a fresh `turn/start` — codex holds the turn open
   * via the in-flight tool call, so a recovery `turn/start` would race
   * the parked tool reply.
   */
  readonly isAwaiting?: () => boolean;
  /** Optional turn-completed hook; runs before posture predicates. */
  readonly onTurnCompletedBeforeDecision?: () => void;
  /** Phase 3c: browser free-text prompt posture. */
  readonly isOpen?: () => boolean;
  /**
   * Phase 2a: returns true when the cross-state dispatcher has scheduled
   * its own `turn/start` for the current turn. When true, drive-forward
   * returns without issuing a fresh `turn/start` (the dance owns the
   * next turn). The flag auto-clears on the next `turn/started`.
   */
  readonly submittedThisTurn?: () => boolean;
  /**
   * Shared wait gate for state model settings. Awaited immediately before
   * each aharness-owned `turn/start`.
   */
  readonly waitForSettled?: () => Promise<void>;
}

export interface DriveForwardHandle {
  onTurnCompleted(): Promise<void>;
  /**
   * F1 salvage entry point — called by `crossStateDance.ts`'s outer
   * catch when the dance fails (watcher timeout, unknown
   * `turn/interrupt` error, `turn/start` error). Re-runs the SAME
   * posture chain as `onTurnCompleted` so the run picks back up via
   * drive-forward's default branch and the dance never owns the
   * recovery `turn/start`. See spec §4.3.3 and the F1 followup at
   * `docs/followups/2026-05-13-headless-phase-2a-followups.md`.
   *
   * `submittedThisTurn` is consulted but expected to be false at this
   * point: the dance's outer catch clears it BEFORE invoking salvage.
   * Keeping the predicate in the chain is intentional defense-in-depth.
   */
  salvageAfterDanceFailure(): Promise<void>;
}

export function createDriveForward(o: CreateDriveForwardOpts): DriveForwardHandle {
  /**
   * Shared "default branch" sender. Single locus for the `turn/start`
   * wire shape so the two entry points (`onTurnCompleted` and
   * `salvageAfterDanceFailure`) cannot drift.
   */
  async function issueDefaultTurnStart(): Promise<void> {
    const nudge = o.composeActiveStateNudge();
    await o.waitForSettled?.();
    await o.client.request<TurnStartResponse>(METHOD.turnStart, {
      threadId: o.activeThreadBinding.require(),
      input: [{ type: 'text', text: nudge }],
    } satisfies TurnStartParams);
  }

  return {
    async onTurnCompleted() {
      o.onTurnCompletedBeforeDecision?.();
      if (o.isAwaiting?.() === true) {
        // Phase 2b: a request_user_input ServerRequest is parked. Codex
        // normally cannot fire turn/completed in this state (the tool call
        // holds the turn open), but if it ever does, do NOT issue a fresh
        // turn/start that would race the in-flight tool reply.
        return;
      }
      if (o.isOpen?.() === true) {
        return;
      }
      if (o.submittedThisTurn?.() === true) {
        // Cross-state dispatcher already scheduled the next `turn/start`
        // via the §4.3.3 dance. Drive-forward must not double-fire.
        return;
      }
      if (o.isTerminal()) {
        await o.onShutdown();
        return;
      }
      await issueDefaultTurnStart();
    },

    async salvageAfterDanceFailure() {
      // Mirrors `onTurnCompleted`'s posture chain. `isAwaiting` and
      // `isOpen` return silently because those postures are owned by a
      // parked owner request or browser free-text respectively.
      // `submittedThisTurn` is benign here — the dance's outer catch
      // cleared it before invoking salvage — but the predicate stays in
      // the chain as defense-in-depth.
      if (o.isAwaiting?.() === true) {
        // Phase 2b: parity with `onTurnCompleted`. If the dance fails
        // while a request_user_input ServerRequest is parked, we still
        // do NOT issue a recovery turn/start that would race the
        // parked tool reply.
        return;
      }
      if (o.isOpen?.() === true) {
        return;
      }
      if (o.submittedThisTurn?.() === true) {
        return;
      }
      if (o.isTerminal()) {
        await o.onShutdown();
        return;
      }
      await issueDefaultTurnStart();
    },
  };
}
