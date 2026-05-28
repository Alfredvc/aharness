/**
 * Test fixture for `daemon/main.ts` (35b) tests that need both an
 * await exit and a submit-into-terminal path.
 *
 * Topology:
 *
 *   gated (stateful) ──submit→ done    (terminal, success)
 *         │
 *         └──wait (await)→ done
 */
import { aharness, state, terminal, exit } from '@aharness/core';

interface SubmitPayload {
  result: string;
}

export const machine = aharness.machine({
  id: 'await-and-submit',
  initial: 'gated',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    gated: state({
      entryPrompt: 'Submit or wait.',
      exits: {
        submit: exit<SubmitPayload>({ to: 'done' }),
        wait: { kind: 'await', to: 'done' },
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
