import { createFsm } from '@aharness/core';

interface Data {
  checkpoints: string[];
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-await-checkpoints',
  data: () => ({ checkpoints: [] }),
  initial: 'lint',
  states: {
    lint: fsm.state({
      prompt: 'Report lint status.',
      on: {
        submit: fsm.submit<{ ok: boolean }>({
          to: 'lintGate',
          reduce: (draft) => {
            draft.checkpoints.push('lint');
          },
        }),
      },
    }),
    lintGate: fsm.choice({
      question: 'Lint passed. Proceed to tests?',
      options: [{ label: 'Proceed to tests', to: 'tests' }],
    }),
    tests: fsm.state({
      prompt: 'Report test status.',
      on: {
        submit: fsm.submit<{ ok: boolean }>({
          to: 'testsGate',
          reduce: (draft) => {
            draft.checkpoints.push('tests');
          },
        }),
      },
    }),
    testsGate: fsm.choice({
      question: 'Tests passed. Finish?',
      options: [{ label: 'Finish', to: 'done' }],
    }),
    done: fsm.final({ outcome: 'success', output: (data) => data.checkpoints }),
  },
});
