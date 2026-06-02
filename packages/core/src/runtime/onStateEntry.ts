/**
 * State-entry observer — composes the per-state orientation nudge from the
 * active leaf's `AharnessStateMeta` and routes it through `injectNudge`.
 *
 * The submit dispatcher schedules post-transition orientation for submit
 * transitions, which covers the common case. Resume from snapshot falls
 * outside that path: the daemon rehydrates an actor whose current leaf
 * needs to be re-announced to the model on the very next turn, but no
 * transition just happened (§5.10).
 *
 * Centralising the entry-side composition here lets both call sites share
 * one definition of "what the model should see when state X becomes
 * active". The submit path keeps its own scheduling; this entry observer
 * is the post-resume equivalent for non-dispatcher transitions.
 *
 * Expected wiring (Task 35): the daemon will subscribe to its actor's
 * snapshot stream and call `onStateEntry` on every state-change boundary
 * that is *not* sourced from a submit-dispatcher commit, plus once at
 * resume time. The dispatcher path stays distinct so the inline reply
 * orientation and the inject-side orientation cannot drift.
 */
import type { RunCtx, SchemaSidecar } from '../types.js';
import type { AharnessOps } from '../state/aharnessOps.js';

import type { ActorHost } from './actorHost.js';
import { composeStateNudge, type ExitSpec } from './nudge.js';
import { resolveEntryPrompt } from './resolvePrompt.js';

export interface OnStateEntryOpts {
  readonly host: ActorHost;
  readonly sidecar: SchemaSidecar;
  /**
   * Same shape as the dispatcher's `injectNudge` — accepts orientation
   * text and forwards it to `thread/inject_items`. Errors propagate; the
   * caller (the daemon) is responsible for sinking them to its log so a
   * transient injection failure does not crash the run.
   */
  readonly injectNudge: (text: string) => Promise<void> | void;
  /**
   * Author-facing meta-ops facade. When provided AND `firedFromResume`
   * is `false`, the active leaf's
   * `meta.aharness.onEntry(ctx, ops)` is invoked after the orientation
   * nudge composes (FSM meta-ops design §4.3). Errors from the author
   * hook are re-injected via `injectNudge` so the model sees the
   * failure; the entry pipeline does not propagate them.
   */
  readonly ops?: AharnessOps;
  /**
   * `true` when this entry observation is rehydrating from a snapshot
   * rather than reacting to a live transition (FSM meta-ops design
   * §4.3 — "Resume from snapshot does NOT re-fire `onEntry`"). The
   * orientation nudge still composes (the model in the new thread
   * needs orientation), but the author hook is skipped.
   */
  readonly firedFromResume?: boolean;
}

/**
 * Compose and inject the orientation nudge for the host's currently active
 * leaf. No-ops when the leaf has no aharness meta or is non-stateful
 * (terminal / passive) — those leaves have no exits to advertise and no
 * `entryPrompt` to evaluate.
 *
 * `entryPrompt` evaluation is wrapped in try/catch so a buggy author
 * function does not abort the entry pipeline. The thrown message is
 * surfaced back to the model in-band so the failure is visible rather
 * than silent.
 */
export async function onStateEntry(o: OnStateEntryOpts): Promise<void> {
  const stateId = o.host.currentStateId();
  if (stateId === '') return;
  const meta = o.host.currentMeta();
  if (!meta || meta.kind !== 'stateful') return;

  const exits: ExitSpec[] = [];
  for (const [name, def] of Object.entries(meta.exits)) {
    if (def.kind === 'submit') {
      // Defensive `?? { type: 'object' }`: the verifier requires a
      // sidecar entry per submit exit, but the daemon must not crash
      // if the sidecar is incomplete at runtime — render a minimal
      // schema stub so the orientation still surfaces the exit name.
      const schema = o.sidecar[stateId]?.[name]?.jsonSchema ?? { type: 'object' };
      exits.push({ kind: 'submit', name, schema });
    }
  }

  let promptText: string;
  try {
    // `currentContext()` returns `Record<string, unknown>`; the aharness
    // wrapper guarantees the framework-managed `__aharness_*` fields are
    // populated on every snapshot, so widening to `RunCtx` is safe.
    // Mirrors the pattern used by `dispatchSubmit.ts` for the same call.
    promptText = resolveEntryPrompt(meta.entryPrompt, o.host.currentContext() as RunCtx);
  } catch (e) {
    promptText = `(aharness: error computing entryPrompt: ${(e as Error).message})`;
  }

  await o.injectNudge(
    composeStateNudge({
      stateId,
      exits,
      entryPromptText: promptText,
    }),
  );

  // Author meta-ops hook. Skipped on resume — only fresh state entries
  // fire `onEntry`.
  if (!o.firedFromResume && o.ops !== undefined && meta.onEntry !== undefined) {
    try {
      await meta.onEntry(o.host.currentContext(), o.ops);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await o.injectNudge(`(aharness: onEntry hook for state '${stateId}' threw: ${msg})`);
      } catch {
        // best effort — the original error already surfaced via the
        // entry-side nudge above
      }
    }
  }
}
