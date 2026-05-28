import { exit, harness, state, terminal } from '@aharness/core';

interface HelloPayload {
  name: string;
}

export const machine = harness.machine({
  id: 'hello',
  initial: 'ask',
  context: () => ({ __harness_visitCount: {} as Record<string, number> }),
  states: {
    ask: state({
      entryPrompt: 'Ask for a name.',
      exits: {
        ok: exit<HelloPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
