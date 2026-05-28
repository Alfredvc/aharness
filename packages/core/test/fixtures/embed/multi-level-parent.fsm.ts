import { harness, state, exit, final, embed } from '@aharness/core';
import mid from './mid.fsm.js';

interface ParentPayload {
  readonly start: boolean;
}

export default harness.machine({
  id: 'multiLevelParent',
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'choose',
      exits: {
        go: exit<ParentPayload>({ to: 'middle' }),
      },
    }),
    middle: embed(mid, {
      on: {
        midDone: { target: 'done' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
