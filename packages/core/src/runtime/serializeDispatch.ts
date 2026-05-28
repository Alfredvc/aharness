/**
 * Serialized dispatch helper for runtime mutator paths.
 *
 * Spec §5.6 step 6 + §10: submit dispatch and per-state hook dispatch
 * (PreToolUse / PostToolUse / UserPromptSubmit) must run one-at-a-time
 * against each other, so an FSM transition triggered by an in-flight
 * submit cannot fire mid-handler. This is belt-and-suspenders alongside
 * codex's RwLock and dynamic-tool turn sequencing.
 *
 * The factory returns a serializer closure that captures its own
 * `dispatchChain`, so multiple runtimes in one process (e.g. tests
 * running in parallel inside the same vitest worker) do not share
 * state.
 *
 * **No-poison invariant:** rejection inside one segment must NOT poison
 * the chain — `.catch(() => undefined)` neutralizes the error after the
 * segment's caller has already received the rejection through the
 * returned promise. The next caller sees a resolved chain and proceeds
 * normally.
 */
export function makeSerializeDispatch(): <T>(fn: () => Promise<T>) => Promise<T> {
  let dispatchChain: Promise<unknown> = Promise.resolve();
  return function serializeDispatch<T>(fn: () => Promise<T>): Promise<T> {
    const next = dispatchChain.then(fn, fn);
    dispatchChain = next.catch(() => undefined);
    return next;
  };
}
