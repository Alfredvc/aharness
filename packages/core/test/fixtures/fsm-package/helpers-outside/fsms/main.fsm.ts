import { exit, aharness, state, terminal } from '@aharness/core';

import { helper } from '../helper.js';

interface MainPayload {
  value: string;
}

export const machine = aharness.machine({
  id: `main-${helper}`,
  initial: 'ask',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    ask: state({
      entryPrompt: 'Ask for a value.',
      exits: {
        ok: exit<MainPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
