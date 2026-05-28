/**
 * State-entry observer — composes the per-state orientation nudge from the
 * active leaf's `HarnessStateMeta` and routes it through `injectNudge`.
 *
 * The submit dispatcher (see `daemon/dispatchSubmit.ts` §5.5 step 5) injects
 * the post-transition orientation **inline** with its success reply, which
 * covers the common case. Two transition flavours fall outside that path:
 *
 *   1. **Await resolution** — the user's reply lands via the wakeup
 *      pipeline rather than the dispatcher's reply, so there is no
 *      submit-side `injectNudge` call site to piggy-back on (§5.7).
 *   2. **Resume from snapshot** — the daemon rehydrates an actor whose
 *      current leaf needs to be re-announced to the model on the very
 *      next turn, but no transition just happened (§5.10).
 *
 * Centralising the entry-side composition here lets both call sites share
 * one definition of "what the model should see when state X becomes
 * active". The submit-inline path (which already has the projected
 * `entryPrompt` text in hand) keeps its own composition; this entry
 * observer is the *post-commit* / *post-resume* equivalent for
 * non-dispatcher transitions.
 *
 * Expected wiring (Task 35): the daemon will subscribe to its actor's
 * snapshot stream and call `onStateEntry` on every state-change boundary
 * that is *not* sourced from a submit-dispatcher commit, plus once at
 * resume time. The dispatcher path stays distinct so the inline reply
 * orientation and the inject-side orientation cannot drift.
 */
import type { RunCtx, SchemaSidecar } from '../types.js';
import type { HarnessOps } from '../state/harnessOps.js';

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
   * `meta.harness.onEntry(ctx, ops)` is invoked after the orientation
   * nudge composes (FSM meta-ops design §4.3). Errors from the author
   * hook are re-injected via `injectNudge` so the model sees the
   * failure; the entry pipeline does not propagate them.
   */
  readonly ops?: HarnessOps;
  /**
   * `true` when this entry observation is rehydrating from a snapshot
   * rather than reacting to a live transition (FSM meta-ops design
   * §4.3 — "Resume from snapshot does NOT re-fire `onEntry`"). The
   * orientation nudge still composes (the model in the new thread
   * needs orientation), but the author hook is skipped.
   */
  readonly firedFromResume?: boolean;
  /**
   * Optional skill-injection service. When provided and the active
   * state declares `meta.harness.skills`, each undeduped skill body is
   * resolved + read, the wrapped `<skill>…</skill>` text is appended to
   * the composed nudge, and the corresponding keys are committed to
   * the run-level injected set after the inject succeeds. When
   * omitted, skill blocks are skipped silently — used by tests that do
   * not exercise the injection path.
   */
  readonly skillService?: {
    readonly composeBlocksForActive: (meta: import('../state/exits.js').HarnessStateMeta) => {
      readonly textBlocks: ReadonlyArray<string>;
      readonly commit: () => void;
    };
  };
}

/**
 * Compose and inject the orientation nudge for the host's currently active
 * leaf. No-ops when the leaf has no harness meta or is non-stateful
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
    } else if (def.kind === 'await') {
      const ask = resolveAwaitAsk(def.__harnessCanonical, o.host.currentContext() as RunCtx);
      exits.push({ kind: 'await', name, ...(ask !== undefined ? { ask } : {}) });
    }
  }

  let promptText: string;
  try {
    // `currentContext()` returns `Record<string, unknown>`; the harness
    // wrapper guarantees the framework-managed `__harness_*` fields are
    // populated on every snapshot, so widening to `RunCtx` is safe.
    // Mirrors the pattern used by `dispatchSubmit.ts` for the same call.
    promptText = resolveEntryPrompt(meta.entryPrompt, o.host.currentContext() as RunCtx);
  } catch (e) {
    promptText = `(harness: error computing entryPrompt: ${(e as Error).message})`;
  }

  // Resolve `awaitsOwnerText.messageToUser` (string or function form).
  // Function-form errors fall back to a sentinel so the orientation
  // surfaces the failure rather than silently dropping the preamble.
  let awaitsOwnerText: { messageToUser: string } | undefined;
  if (meta.awaitsOwnerText !== undefined) {
    const m = meta.awaitsOwnerText.messageToUser;
    let resolved: string;
    if (typeof m === 'string') {
      resolved = m;
    } else {
      try {
        resolved = m(o.host.currentContext() as RunCtx);
      } catch (e) {
        resolved = `(harness: error computing awaitsOwnerText.messageToUser: ${(e as Error).message})`;
      }
    }
    awaitsOwnerText = { messageToUser: resolved };
  }

  // Resolve skill blocks against the run-level injected set BEFORE the
  // inject; commit AFTER the inject succeeds so a transient injection
  // failure leaves the keys flagged not-yet-injected and the next entry
  // retries. Resume-side entries also fire skills — the rehydrated set
  // already excludes them so the resolver returns empty blocks for
  // already-injected keys.
  let skillTextBlocks: ReadonlyArray<string> = [];
  let commitSkills: (() => void) | undefined;
  if (o.skillService !== undefined && meta.skills !== undefined && meta.skills.length > 0) {
    const composed = o.skillService.composeBlocksForActive(meta);
    skillTextBlocks = composed.textBlocks;
    commitSkills = composed.commit;
  }

  await o.injectNudge(
    composeStateNudge({
      stateId,
      exits,
      entryPromptText: promptText,
      ...(awaitsOwnerText !== undefined ? { awaitsOwnerText } : {}),
      ...(skillTextBlocks.length > 0 ? { skillBlocks: skillTextBlocks } : {}),
    }),
  );
  if (commitSkills !== undefined) commitSkills();

  // Author meta-ops hook. Skipped on resume — only fresh state entries
  // fire `onEntry`.
  if (!o.firedFromResume && o.ops !== undefined && meta.onEntry !== undefined) {
    try {
      await meta.onEntry(o.host.currentContext(), o.ops);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await o.injectNudge(`(harness: onEntry hook for state '${stateId}' threw: ${msg})`);
      } catch {
        // best effort — the original error already surfaced via the
        // entry-side nudge above
      }
    }
  }
}

function resolveAwaitAsk(
  meta: import('../state/exits.js').AwaitExitDef['__harnessCanonical'],
  ctx: RunCtx,
): string | undefined {
  if (meta?.kind !== 'await') return undefined;
  if (typeof meta.ask === 'string') return meta.ask;
  try {
    return meta.ask(ctx);
  } catch (e) {
    return `(harness: error computing await ask: ${(e as Error).message})`;
  }
}
