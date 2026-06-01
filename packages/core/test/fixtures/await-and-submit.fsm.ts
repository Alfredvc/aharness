/**
 * Test fixture for tests that need both a submit-into-terminal path and a
 * deterministic owner choice path.
 *
 * Topology:
 *
 *   gated (stateful) ──submit→ done    (terminal, success)
 *         │
 *         └──choice→ ownerGate ──Continue→ done
 */
import { createFsm } from '@aharness/core';

interface SubmitPayload {
  result: string;
}

const fsm = createFsm<{ result: string | null }>();

export const machine = fsm.machine({
  id: 'choice-and-submit',
  initial: 'gated',
  data: () => ({ result: null }),
  states: {
    gated: fsm.state({
      prompt: 'Submit or route to the owner gate.',
      on: {
        submit: fsm.submit<SubmitPayload>({
          to: 'done',
          reduce: (draft, payload) => {
            draft.result = payload.result;
          },
        }),
        routeToGate: fsm.submit<Record<string, never>>({ to: 'ownerGate' }),
      },
    }),
    ownerGate: fsm.choice({
      question: 'Continue?',
      options: [{ label: 'Continue', to: 'done' }],
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});

export default machine;
