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
    pickColor: fsm.state({
      prompt: "Map the owner's reply to red or green.",
      ask: 'Pick red or green.',
      on: {
        submit: fsm.submit<{ color: Color }>({
          to: 'pickFruit',
          reduce: (draft, payload) => {
            draft.color = payload.color;
          },
        }),
      },
    }),
    pickFruit: fsm.state({
      prompt: (data) => `Pick a fruit matching ${data.color}.`,
      skills: [fsm.skill('fruit-picker', { optional: true })],
      on: {
        submit: fsm.submit<{ fruit: string; reason: string }>({
          to: 'confirm',
          reduce: (draft, payload) => {
            draft.fruit = payload.fruit;
            draft.reason = payload.reason;
          },
        }),
      },
    }),
    confirm: fsm.state({
      prompt: 'Map the owner reply to accepted.',
      ask: (data) => `Suggested ${data.fruit}. Accept?`,
      on: {
        submit: fsm.submit<{ accepted: boolean }>({
          route: [
            { if: (_data, payload) => payload.accepted, to: 'done' },
            {
              to: 'pickFruit',
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
