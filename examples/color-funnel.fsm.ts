import { createFsm } from '@aharness/core';

type Color = 'red' | 'green' | 'blue' | 'yellow';

interface Data {
  color: Color | null;
  fruit: string | null;
  reason: string | null;
}

const fsm = createFsm<Data>();

const renderResultMd = (data: Readonly<Data>): string =>
  [
    '# Color Funnel Result',
    '',
    `- Color: ${data.color ?? '(none)'}`,
    `- Fruit: ${data.fruit ?? '(none)'}`,
    '',
    '## Why this fruit',
    '',
    data.reason ?? '(none)',
    '',
  ].join('\n');

export default fsm.machine({
  id: 'color-funnel',
  initial: 'pickColor',
  data: () => ({
    color: null,
    fruit: null,
    reason: null,
  }),
  states: {
    pickColor: fsm.state({
      prompt:
        "Capture the owner's color choice. Map their reply to one of: red, green, blue, yellow. " +
        'If their reply does not clearly match one of those, default to red.',
      ask: 'Pick a color: 1) red  2) green  3) blue  4) yellow. Reply with a number or the color name.',
      on: {
        submit: fsm.submit<{ color: Color }>({
          to: 'modelPicksFruit',
          reduce: (draft, payload) => {
            draft.color = payload.color;
          },
        }),
      },
    }),
    modelPicksFruit: fsm.state({
      prompt: (data) =>
        `The owner picked the color "${data.color ?? '(unknown)'}". ` +
        'Pick one specific real-world fruit whose typical exterior matches that color, ' +
        'and explain in one sentence why. Submit the fruit name and the reason.',
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
      prompt:
        "Read the owner's yes/no reply. Map yes/y/sure/ok to accepted=true; map no/n/nope to accepted=false. " +
        'If ambiguous, default to false so they get another suggestion.',
      ask: (data) => `Suggested fruit: ${data.fruit ?? '(none)'}. Want this one? Reply yes or no.`,
      on: {
        submit: fsm.submit<{ accepted: boolean }>({
          route: [
            { if: (data, payload) => payload.accepted === true, to: 'finalize' },
            {
              to: 'modelPicksFruit',
              reduce: (draft) => {
                draft.fruit = null;
                draft.reason = null;
              },
            },
          ],
        }),
      },
    }),
    finalize: fsm.final({
      outcome: 'success',
      artifacts: {
        'result.md': renderResultMd,
      },
    }),
  },
});
