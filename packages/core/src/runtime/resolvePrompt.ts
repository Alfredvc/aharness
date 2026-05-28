/**
 * Resolver for `entryPrompt` — accepts the string-or-function form
 * declared by `AharnessStateMeta.entryPrompt` (verified single
 * `(ctx: RunCtx) => string` signature in `packages/sdk/src/state/exits.ts`)
 * and returns the orientation text the daemon will inject after a
 * successful submit / await transition.
 *
 * The function form lets authors compute orientation copy from live
 * `RunCtx` (e.g. interpolating accumulated counters) without having to
 * pre-bake every variant into the FSM source. The resolver is a
 * one-liner; we centralise it because three call sites (the dispatcher's
 * dry-run projection, the await resolver, and the post-commit nudge)
 * all need the same string-or-function evaluation and the same throw
 * behaviour for malformed values.
 */
import type { RunCtx } from '../types.js';

/**
 * Mirror of `AharnessStateMeta.entryPrompt`'s declared type.
 * Re-declared locally so callers depending only on this module don't
 * need to import the full state-meta surface.
 */
export type EntryPrompt = string | ((ctx: RunCtx) => string);

/**
 * Evaluate `p` against `ctx`. Strings pass through unchanged; functions
 * are called with `ctx` and their return value is used. Anything else
 * is a programming error (the FSM author surface only accepts the two
 * forms above), so we throw `TypeError` rather than silently coercing.
 */
export function resolveEntryPrompt(p: EntryPrompt, ctx: RunCtx): string {
  if (typeof p === 'string') return p;
  if (typeof p === 'function') return p(ctx);
  throw new TypeError('entryPrompt: must be string or function');
}
