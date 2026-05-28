/**
 * Cross-state walk fixture for the Phase 2a end-to-end integration test.
 *
 * Topology:
 *
 *   a (stateful) ──next→ b (stateful) ──done→ c (terminal:'success')
 *
 * The fixture exercises the cross-state turn-end dance:
 * `wait-for-item-completed → turn/interrupt → turn/start({input: <state b
 * nudge>})`. Companion integration test
 * `packages/core/test/integration.crossStateWalk.test.ts` queues
 * two mock-model turns:
 *
 *   1. `harness_submit({state: "a", exit: "next", data: {note: "hi"}})`
 *      — drives a → b; the dispatcher fires the cross-state dance.
 *   2. `harness_submit({state: "b", exit: "done", data: {ok: true}})`
 *      — drives b → c; the dispatcher's terminal branch fires and the
 *      run exits 0.
 *
 * The fixture exposes:
 *   - `CROSS_STATE_WALK_FSM_SOURCE` — source string written to disk by
 *     the integration test so `loadFsm` can esbuild + dynamic-import it
 *     against the synthetic `repoRoot`. The FSM source uses bare
 *     `@aharness/core` imports (externalised by the loader compile step,
 *     `packages/core/src/loader/compile.ts:38-124`), not
 *     relative paths, so it works from any synthetic `mkdtempSync`
 *     directory.
 *   - `buildCrossStateSubmitTurn(stateId, exitName, data)` — assembles
 *     a single-tool-call turn whose function_call carries the bare
 *     `harness_submit` name (no MCP namespace; Phase 2a uses
 *     `dynamic_tools`, not the per-run MCP server).
 *
 * Per `docs/plans/2026-05-12-headless-phase-2a-cross-state.md` §Task 5.
 */
import { harness, state, exit, terminal, type HarnessMachine } from '@aharness/core';
import { sseFunctionCall, sseResponseCreated, sseTurnComplete, type SseEvent } from '../sse.js';

interface NextPayload {
  readonly note: string;
}

interface DonePayload {
  readonly ok: boolean;
}

/**
 * In-process machine matching `CROSS_STATE_WALK_FSM_SOURCE` for callers
 * that want to introspect the topology without going through `loadFsm`
 * (e.g. for unit-level checks of state ids and exit shapes). The
 * integration test still writes the source string to disk and lets
 * `loadFsm` esbuild + dynamic-import it — the on-disk path is what
 * `runCliForTest` consumes; this in-process machine is a convenience
 * mirror, not the runtime entry point.
 */
export const crossStateWalkMachine: HarnessMachine<
  unknown,
  unknown,
  Record<string, unknown>
> = harness.machine({
  id: 'cross-state-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'state a active',
      exits: {
        next: exit<NextPayload>({ to: 'b' }),
      },
    }),
    b: state({
      entryPrompt: 'state b active',
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});

/**
 * FSM source for the cross-state walk. Two stateful states + one
 * terminal. The `entryPrompt` on `b` contains the `"state b active"`
 * substring asserted by the integration test (alongside the
 * framework-generated `[harness] Now in state "b"` header and the
 * rendered `done` exit, both of which the test also asserts).
 *
 * Written to disk in the integration test's synthetic `repoRoot` so
 * `loadFsm` can esbuild + dynamic-import it (the loader's compile step
 * externalises bare `@aharness/core` / `xstate` imports to absolute
 * install paths — see `packages/core/src/loader/compile.ts`).
 * Kept in sync with `crossStateWalkMachine` above.
 */
export const CROSS_STATE_WALK_FSM_SOURCE = `import { harness, state, exit, terminal } from '@aharness/core';

interface NextPayload {
  note: string;
}

interface DonePayload {
  ok: boolean;
}

export default harness.machine({
  id: 'cross-state-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'state a active',
      exits: {
        next: exit<NextPayload>({ to: 'b' }),
      },
    }),
    b: state({
      entryPrompt: 'state b active',
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});
`;

/**
 * Build a single-turn SSE stream that emits one `harness_submit`
 * function_call. Wire shape mirrors `cli.runCli.phase1.test.ts:90-98`'s
 * encoding — `response.created` → `function_call` (bare name, no
 * namespace) → `response.completed`.
 *
 * `data` is JSON-stringified by `sseFunctionCall` when packing into the
 * `arguments` field of the function_call output item; the dispatcher
 * decodes it via the existing `dispatchIfSubmit` path.
 */
export function buildCrossStateSubmitTurn(
  stateId: string,
  exitName: string,
  data: unknown,
): SseEvent[] {
  return [
    sseResponseCreated(),
    sseFunctionCall('harness_submit', { state: stateId, exit: exitName, data }),
    sseTurnComplete(),
  ];
}
