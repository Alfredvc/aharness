/**
 * Await-exit walk fixture for the Phase 2b unit-level `AWAIT__` test.
 *
 * Topology:
 *
 *   a (stateful, one `await` exit `reply`) ──reply→ b (stateful, submit `done`) ──done→ c (terminal:'success')
 *
 * Distinct from `ownerYieldWalk` (which exercises `awaitsOwnerText`
 * lowering on a state that has a SUBMIT exit) — here state `a` declares a
 * single `await`-kind exit. The framework's nudge composer (`nudge.ts:103-106`)
 * emits `- "reply" → call request_user_input (await exit, no submit data)`
 * so the model knows to call `request_user_input` for the await exit.
 *
 * When codex emits a `request_user_input` `function_call` and the
 * matching `function_call_output` lands on `rawResponseItem/completed`,
 * the `awaitResolver` in `runCli.ts` fires the synthesized
 * `AWAIT__a__reply` event against `ActorHost.commitAwait`, advancing the
 * FSM from `a → b`. Drive-forward's default branch then issues a fresh
 * `turn/start` for state `b`'s nudge on the next `turn/completed`.
 *
 * The companion integration test
 * `packages/core/test/integration.awaitExitWalk.test.ts` queues
 * two mock-model turns:
 *
 *   1. `request_user_input({questions: [{id: "q", header: "",
 *       question: "What?", isOther: false, isSecret: false}]})` —
 *       resolver fires `AWAIT__a__reply`; state advances a → b.
 *   2. `harness_submit({state: "b", exit: "done", data: {}})` —
 *       terminal transition; run exits 0.
 *
 * Per `docs/plans/2026-05-13-headless-phase-2b-owner-yield.md` §Task 8.
 */
import { harness, state, exit, terminal, type HarnessMachine } from '@aharness/core';

interface DonePayload {
  // Intentionally empty — state b's submit carries no data. The mock
  // model emits `data: {}` and the per-(b, done) sidecar accepts an
  // empty object.
  readonly _empty?: never;
}

/**
 * In-process machine matching `AWAIT_EXIT_WALK_FSM_SOURCE` for callers
 * that want to introspect the topology without going through `loadFsm`.
 * The integration test still writes the source string to disk and lets
 * `loadFsm` esbuild + dynamic-import it.
 */
export const awaitExitWalkMachine: HarnessMachine<
  unknown,
  unknown,
  Record<string, unknown>
> = harness.machine({
  id: 'await-exit-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'ask the user a free-text question',
      exits: {
        reply: { kind: 'await', to: 'b' },
      },
    }),
    b: state({
      entryPrompt: 'got the reply',
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});

/**
 * FSM source for the await-exit walk. Two stateful states + one
 * terminal. The `await` exit on state `a` and the submit exit on state
 * `b` mirror `awaitExitWalkMachine` above.
 *
 * Written to disk in the integration test's synthetic `repoRoot` so
 * `loadFsm` can esbuild + dynamic-import it (the loader's compile step
 * externalises bare `@aharness/core` / `xstate` imports to absolute
 * install paths — see `packages/core/src/loader/compile.ts`).
 * Kept in sync with `awaitExitWalkMachine` above.
 */
export const AWAIT_EXIT_WALK_FSM_SOURCE = `import { harness, state, exit, terminal } from '@aharness/core';

interface DonePayload {
  _empty?: never;
}

export default harness.machine({
  id: 'await-exit-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'ask the user a free-text question',
      exits: {
        reply: { kind: 'await', to: 'b' },
      },
    }),
    b: state({
      entryPrompt: 'got the reply',
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});
`;
