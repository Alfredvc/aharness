import { createFsm } from '@aharness/core';
import child from './canonical-loader-child.fsm.js';

interface ParentData {
  readonly topic: string;
  readonly shippedTopic: string | null;
}

const fsm = createFsm<ParentData>();

export default fsm.machine({
  id: 'canonical-loader-parent',
  input: {
    topic: fsm.input.string({ description: 'Project topic' }),
  },
  data: ({ input }) => ({
    topic: input.topic,
    shippedTopic: null,
  }),
  initial: 'router',
  states: {
    router: fsm.state({
      prompt: (data) => `Pipeline for topic: ${data.topic}`,
      on: {
        go: fsm.submit<{ ready: boolean }>({
          route: [{ if: (_data, payload) => payload.ready, to: 'spec' }, { to: 'router' }],
        }),
      },
    }),
    spec: fsm.embed(child, {
      input: (data) => ({ topic: data.topic }),
      on: {
        shipped: {
          to: 'done',
          reduce: (draft, output) => {
            draft.shippedTopic = output.topic;
          },
        },
        failed: { to: 'router' },
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
