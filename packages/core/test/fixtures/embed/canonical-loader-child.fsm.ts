import { createFsm } from '@aharness/core';

interface ChildData {
  readonly topic: string;
}

const fsm = createFsm<ChildData>();

export default fsm.machine({
  id: 'canonical-loader-child',
  input: {
    topic: fsm.input.string({ description: 'Topic to spec' }),
  },
  data: ({ input }) => ({
    topic: input.topic,
  }),
  initial: 'compose',
  states: {
    compose: fsm.state({
      prompt: (data) => `Compose a spec for ${data.topic}`,
      on: {
        ship: fsm.submit<{}>({ to: 'shipped' }),
        reject: fsm.submit<{}>({ to: 'failed' }),
      },
    }),
    shipped: fsm.final({
      outcome: 'success',
      output: (data) => ({ topic: data.topic }),
    }),
    failed: fsm.final({ outcome: 'failure' }),
  },
});
