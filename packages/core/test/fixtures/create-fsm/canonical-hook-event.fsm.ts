import { createFsm } from '@aharness/core';

interface Data {
  allowed: boolean;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-hook-event',
  data: () => ({ allowed: false }),
  initial: 'review',
  states: {
    review: fsm.state({
      prompt: 'Review the command request.',
      on: {
        permissionRequest: {
          match: '^Bash$',
          reduce: (draft) => {
            draft.allowed = true;
          },
          return: () => 'delegate',
        },
        submit: fsm.submit<{ done: boolean }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
