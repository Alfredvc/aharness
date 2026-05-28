/**
 * Clear-walk fixture for the fresh-clear end-to-end integration test.
 *
 * Topology:
 *
 *   a (stateful) --next--> b (stateful, clearOnEntry) --done--> c (terminal)
 *
 * The fixture exercises author-facing `clearOnEntry` lowering: after
 * a committed non-self transition into `b`, the runtime replaces the
 * parent thread and starts a fresh turn with state b's orientation.
 */
import { aharness, state, exit, terminal } from '@aharness/core';
import { sseFunctionCall, sseResponseCreated, sseTurnComplete, type SseEvent } from '../sse.js';

interface NextPayload {
  readonly note: string;
}

interface DonePayload {
  readonly ok: boolean;
}

export const clearWalkMachine: unknown = aharness.machine({
  id: 'clear-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'clear walk state a',
      exits: {
        next: exit<NextPayload>({ to: 'b' }),
      },
    }),
    b: state({
      entryPrompt: 'CLEAR_WALK_STATE_B_MARKER',
      clearOnEntry: true,
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});

export const CLEAR_WALK_FSM_SOURCE = `import { aharness, state, exit, terminal } from '@aharness/core';

interface NextPayload {
  note: string;
}

interface DonePayload {
  ok: boolean;
}

export default aharness.machine({
  id: 'clear-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'clear walk state a',
      exits: {
        next: exit<NextPayload>({ to: 'b' }),
      },
    }),
    b: state({
      entryPrompt: 'CLEAR_WALK_STATE_B_MARKER',
      clearOnEntry: true,
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});
`;

export function buildClearWalkSubmitTurn(
  stateId: string,
  exitName: string,
  data: unknown,
): SseEvent[] {
  return [
    sseResponseCreated(),
    sseFunctionCall('aharness_submit', { state: stateId, exit: exitName, data }),
    sseTurnComplete(),
  ];
}
