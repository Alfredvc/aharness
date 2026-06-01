/**
 * Retired await-exit walk fixture.
 *
 * The original fixture constructed a low-level `kind: 'await'` exit at module
 * import time. Slice 4 rejects that authoring surface, so this exported fixture
 * now uses typed submits to keep the test-support barrel importable. The old
 * AWAIT__ integration test is skipped as retired coverage.
 */
import { aharness, state, exit, terminal, type AharnessMachine } from '@aharness/core';

interface DonePayload {
  // Intentionally empty — state b's submit carries no data. The mock
  // model emits `data: {}` and the per-(b, done) sidecar accepts an
  // empty object.
  readonly _empty?: never;
}

/**
 * In-process machine matching `AWAIT_EXIT_WALK_FSM_SOURCE` for callers that
 * want to introspect the topology without going through `loadFsm`.
 */
export const awaitExitWalkMachine: AharnessMachine<
  unknown,
  unknown,
  Record<string, unknown>
> = aharness.machine({
  id: 'await-exit-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'submit the reply payload',
      exits: {
        reply: exit<DonePayload>({ to: 'b' }),
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
 * FSM source for the retired await-exit walk. Kept as a non-await two-step
 * submit fixture so importing `@aharness/test-support` does not construct
 * retired metadata.
 * Kept in sync with `awaitExitWalkMachine` above.
 */
export const AWAIT_EXIT_WALK_FSM_SOURCE = `import { aharness, state, exit, terminal } from '@aharness/core';

interface DonePayload {
  _empty?: never;
}

export default aharness.machine({
  id: 'await-exit-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'submit the reply payload',
      exits: {
        reply: exit<DonePayload>({ to: 'b' }),
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
