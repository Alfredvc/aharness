// @ts-nocheck
import { createFsm } from '@aharness/core';

interface Data {
  ok: boolean;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-await-retired',
  data: () => ({ ok: false }),
  initial: 's1',
  states: {
    s1: fsm.state({
      prompt: 'x',
      on: {
        done: fsm.await({ ask: 'continue?', to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
