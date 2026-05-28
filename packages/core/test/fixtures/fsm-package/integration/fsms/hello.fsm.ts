import { exit, aharness, state, terminal } from '@aharness/core';

interface HelloPayload {
  name: string;
}

export const machine = aharness.machine({
  id: 'hello',
  initial: 'ask',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
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
