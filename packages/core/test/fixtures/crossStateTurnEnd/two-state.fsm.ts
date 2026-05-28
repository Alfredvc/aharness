/**
 * Minimal two-state FSM fixture for the cross-state turn-end integration
 * tests in `daemon.main.test.ts`.
 *
 * Topology:
 *
 *   a (stateful) ──go→ b (stateful) ──finish→ done (terminal)
 *
 * The `entryPrompt` tokens are unique substrings the tests grep for
 * in the recorded `turn/start.input` payload to confirm the daemon
 * issued the post-transition orientation for the correct state.
 */
import { aharness, state, terminal, exit } from '@aharness/core';
import { assign } from 'xstate';

interface Ctx {
  count: number;
}

interface GoPayload {
  inc: number;
}

export default aharness.machine({
  id: 'cross-state-turn-end',
  initial: 'a',
  context: (): Ctx => ({ count: 0 }),
  states: {
    a: state({
      exits: {
        go: exit<GoPayload>({
          to: 'b',
          actions: assign({
            count: ({ context, event }) =>
              context.count + (event as { payload: GoPayload }).payload.inc,
          }),
        }),
      },
      entryPrompt: 'STATE_A_ORIENTATION_TOKEN',
    }),
    b: state({
      exits: {
        finish: exit<{}>({ to: 'done' }),
      },
      entryPrompt: 'STATE_B_ORIENTATION_TOKEN',
    }),
    done: terminal('success'),
  },
});
