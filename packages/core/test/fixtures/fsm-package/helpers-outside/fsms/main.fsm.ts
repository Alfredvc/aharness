import { exit, harness, state, terminal } from '@aharness/core';

import { helper } from '../helper.js';

interface MainPayload {
  value: string;
}

export const machine = harness.machine({
  id: `main-${helper}`,
  initial: 'ask',
  context: () => ({ __harness_visitCount: {} as Record<string, number> }),
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
