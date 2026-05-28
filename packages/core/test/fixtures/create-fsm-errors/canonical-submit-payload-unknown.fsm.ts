import { createFsm } from '@aharness/core';

interface Data {
  ok: boolean;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-submit-payload-unknown',
  data: () => ({ ok: false }),
  initial: 's1',
  states: {
    s1: fsm.state({
      prompt: 'x',
      on: {
        done: fsm.submit<unknown>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
