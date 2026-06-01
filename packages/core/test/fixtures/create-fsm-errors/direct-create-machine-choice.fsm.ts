import { createMachine } from 'xstate';
import { createFsm } from '@aharness/core';

const fsm = createFsm<{ ok: boolean }>();

export default createMachine({
  id: 'direct-choice',
  initial: 'pick',
  states: {
    pick: fsm.choice({
      question: 'Pick',
      options: [{ label: 'Done', to: 'done' }],
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
