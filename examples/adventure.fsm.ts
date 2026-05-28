import { createFsm } from '@aharness/core';

interface Data {
  trail: string[];
  ending: string | null;
  outcome: 'victory' | 'defeat' | null;
}

const fsm = createFsm<Data>();

const renderEndingMd = (data: Readonly<Data>): string => {
  const lines = [
    '# Adventure',
    '',
    `Outcome: **${data.outcome ?? '(unknown)'}**`,
    '',
    '## Trail',
    '',
  ];
  for (const step of data.trail) lines.push(`- ${step}`);
  lines.push('', '## Ending', '', data.ending ?? '(no ending recorded)', '');
  return lines.join('\n');
};

export default fsm.machine({
  id: 'adventure',
  initial: 'entrance',
  data: (): Data => ({
    trail: [],
    ending: null,
    outcome: null,
  }),
  states: {
    entrance: fsm.state({
      prompt:
        'Open a short fantasy-adventure scene (~3 sentences) where the hero stands at a crossroads. ' +
        'Present three options labelled 1, 2, 3 — one leads to a forest, one to a cave, one to a river. ' +
        'After the owner picks, submit the chosen number (1=forest, 2=cave, 3=river) and a one-line ' +
        'recap of the scene under `scene`.',
      ask: 'Forest, cave, or river? Reply 1, 2, or 3.',
      on: {
        submit: fsm.submit<{ choice: 1 | 2 | 3; scene: string }>({
          route: [
            {
              if: (data, payload) => payload.choice === 1,
              to: 'forest',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `entrance: ${payload.scene}`];
              },
            },
            {
              if: (data, payload) => payload.choice === 2,
              to: 'cave',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `entrance: ${payload.scene}`];
              },
            },
            {
              to: 'river',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `entrance: ${payload.scene}`];
              },
            },
          ],
        }),
      },
    }),
    forest: fsm.state({
      prompt:
        'Continue the story in the forest (~3 sentences). Present two options labelled 1, 2 — ' +
        'one is bold, one is cautious. After the owner picks, judge it dramatically: ' +
        '1 leads to victory, 2 leads to defeat. Submit the choice, a one-line scene recap, ' +
        'and a 1–2 sentence ending paragraph.',
      ask: 'Bold or cautious? Reply 1 or 2.',
      on: {
        submit: fsm.submit<{ choice: 1 | 2; scene: string; ending: string }>({
          route: [
            {
              if: (data, payload) => payload.choice === 1,
              to: 'victory',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `forest: ${payload.scene}`];
                draft.ending = payload.ending;
                draft.outcome = 'victory';
              },
            },
            {
              to: 'defeat',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `forest: ${payload.scene}`];
                draft.ending = payload.ending;
                draft.outcome = 'defeat';
              },
            },
          ],
        }),
      },
    }),
    cave: fsm.state({
      prompt:
        'Continue the story in the cave (~3 sentences). Present two options labelled 1, 2 — ' +
        'one is bold, one is cautious. 1 leads to defeat (the cave is treacherous); ' +
        '2 leads to victory. Submit the choice, scene recap, and 1–2 sentence ending.',
      ask: 'Bold or cautious? Reply 1 or 2.',
      on: {
        submit: fsm.submit<{ choice: 1 | 2; scene: string; ending: string }>({
          route: [
            {
              if: (data, payload) => payload.choice === 1,
              to: 'defeat',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `cave: ${payload.scene}`];
                draft.ending = payload.ending;
                draft.outcome = 'defeat';
              },
            },
            {
              to: 'victory',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `cave: ${payload.scene}`];
                draft.ending = payload.ending;
                draft.outcome = 'victory';
              },
            },
          ],
        }),
      },
    }),
    river: fsm.state({
      prompt:
        'Continue the story at the river (~3 sentences). Present two options labelled 1, 2 — ' +
        'one is bold, one is cautious. 1 leads to victory; 2 leads to defeat. ' +
        'Submit the choice, scene recap, and 1–2 sentence ending.',
      ask: 'Bold or cautious? Reply 1 or 2.',
      on: {
        submit: fsm.submit<{ choice: 1 | 2; scene: string; ending: string }>({
          route: [
            {
              if: (data, payload) => payload.choice === 1,
              to: 'victory',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `river: ${payload.scene}`];
                draft.ending = payload.ending;
                draft.outcome = 'victory';
              },
            },
            {
              to: 'defeat',
              reduce: (draft, payload) => {
                draft.trail = [...draft.trail, `river: ${payload.scene}`];
                draft.ending = payload.ending;
                draft.outcome = 'defeat';
              },
            },
          ],
        }),
      },
    }),
    victory: fsm.final({
      outcome: 'success',
      artifacts: {
        'adventure.md': renderEndingMd,
      },
    }),
    defeat: fsm.final({
      outcome: 'failure',
      artifacts: {
        'adventure.md': renderEndingMd,
      },
    }),
  },
});
