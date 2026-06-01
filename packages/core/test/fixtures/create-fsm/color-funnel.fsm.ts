import { createFsm } from '@aharness/core';

type Color = 'red' | 'green';

interface Data {
  color: Color | null;
  fruit: string | null;
  reason: string | null;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-color-funnel',
  data: () => ({ color: null, fruit: null, reason: null }),
  initial: 'pickColor',
  states: {
    pickColor: fsm.choice({
      question: 'Pick red or green.',
      options: [
        { label: 'red', to: 'pickRedFruit' },
        { label: 'green', to: 'pickGreenFruit' },
      ],
    }),
    pickRedFruit: fsm.state({
      prompt: 'Pick a fruit matching red.',
      skills: [fsm.skill('fruit-picker', { optional: true })],
      on: {
        submit: fsm.submit<{ fruit: string; reason: string }>({
          to: 'confirm',
          reduce: (draft, payload) => {
            draft.color = 'red';
            draft.fruit = payload.fruit;
            draft.reason = payload.reason;
          },
        }),
      },
    }),
    pickGreenFruit: fsm.state({
      prompt: 'Pick a fruit matching green.',
      skills: [fsm.skill('fruit-picker', { optional: true })],
      on: {
        submit: fsm.submit<{ fruit: string; reason: string }>({
          to: 'confirm',
          reduce: (draft, payload) => {
            draft.color = 'green';
            draft.fruit = payload.fruit;
            draft.reason = payload.reason;
          },
        }),
      },
    }),
    confirm: fsm.choice({
      question: (data) => `Suggested ${data.fruit}. Accept?`,
      options: [
        { label: 'Accept', to: 'done' },
        { label: 'Try again', to: 'resetFruit' },
      ],
    }),
    resetFruit: fsm.state({
      prompt: 'Reset the suggested fruit and submit the next color-specific picking state.',
      on: {
        submit: fsm.submit<{ color: Color }>({
          route: [
            {
              if: (_data, payload) => payload.color === 'red',
              to: 'pickRedFruit',
              reduce: (draft) => {
                draft.fruit = null;
                draft.reason = null;
              },
            },
            {
              to: 'pickGreenFruit',
              reduce: (draft) => {
                draft.fruit = null;
                draft.reason = null;
              },
            },
          ],
        }),
      },
    }),
    done: fsm.final({
      outcome: 'success',
      output: (data) => ({ fruit: data.fruit }),
      artifacts: {
        'result.md': (data) => `# Result\n\nFruit: ${data.fruit ?? 'none'}\n`,
      },
    }),
  },
});
