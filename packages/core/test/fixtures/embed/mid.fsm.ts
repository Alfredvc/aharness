import { aharness, state, exit, final, embed } from '@aharness/core';
import grandchild from './grandchild.fsm.js';

interface MidPayload {
  readonly choice: 'go' | 'stop';
}

export default aharness.machine({
  id: 'mid',
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'choose',
      exits: {
        go: exit<MidPayload>({ to: 'inner' }),
      },
    }),
    inner: embed(grandchild, {
      on: {
        leafDone: { target: 'midDone' },
      },
    }),
    midDone: final({ outcome: 'success' }),
  },
});
