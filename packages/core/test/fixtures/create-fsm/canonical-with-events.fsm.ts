import { createFsm } from '@aharness/core';

interface Data {
  topic: string;
  passed: boolean;
}

const base = createFsm<Data>();
const fsm = base.withEvents({
  testsFinished: base.event<{ passed: boolean }>(),
});

export default fsm.machine({
  id: 'canonical-with-events',
  input: {
    topic: fsm.input.string({ description: 'Work topic' }),
  },
  data: ({ input }) => ({ topic: input.topic, passed: false }),
  initial: 'review',
  states: {
    review: fsm.state({
      prompt: (data) => `Review ${data.topic}.`,
      on: {
        testsFinished: {
          to: 'review',
          reduce: (draft, payload) => {
            draft.passed = payload.passed;
          },
        },
        submit: fsm.submit<{ accepted: boolean }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
