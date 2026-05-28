import { createFsm } from '@aharness/core';

interface Data {
  replies: {
    lint: string | null;
    test: string | null;
  };
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-await-checkpoints',
  data: () => ({ replies: { lint: null, test: null } }),
  initial: 'lint',
  states: {
    lint: fsm.state({
      prompt: 'Report lint status, then wait for the owner.',
      on: {
        proceed: fsm.await({
          ask: 'Lint passed. Proceed to tests?',
          to: 'tests',
          reduce: (draft, ownerReply) => {
            draft.replies.lint = ownerReply;
          },
        }),
      },
    }),
    tests: fsm.state({
      prompt: 'Report test status, then wait for the owner.',
      on: {
        proceed: fsm.await({
          ask: 'Tests passed. Finish?',
          to: 'done',
          effect: async ({ ownerReply }) => {
            if (ownerReply.length === 0) throw new Error('empty owner reply');
          },
          reduce: (draft, ownerReply) => {
            draft.replies.test = ownerReply;
          },
        }),
      },
    }),
    done: fsm.final({ outcome: 'success', output: (data) => data.replies }),
  },
});
