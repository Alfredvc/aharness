import { createFsm } from '@aharness/core';

interface Data {
  topic: string;
  passed: boolean;
}

const fsm = createFsm<Data>().withEvents({
  testsFinished: createFsm<Data>().event<{ passed: boolean }>(),
});

export default fsm.machine({
  id: 'canonical-with-events-chained',
  input: {
    topic: fsm.input.string({ description: 'Chained topic' }),
  },
  data: ({ input }) => ({ topic: input.topic, passed: false }),
  initial: 'review',
  states: {
    review: fsm.state({
      prompt: (data) => `Review ${data.topic}.`,
      on: {
        testsFinished: {
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
