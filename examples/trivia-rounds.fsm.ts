import { createFsm } from '@aharness/core';

interface RoundRecord {
  round: number;
  genre: string;
  correct: number;
  total: number;
}

interface Data {
  round: number;
  qInRound: number;
  currentGenre: string | null;
  currentRoundCorrect: number;
  rounds: RoundRecord[];
}

interface AskQuestionPayload {
  question: string;
  correctAnswer: 'A' | 'B' | 'C' | 'D';
  ownerAnswer: 'A' | 'B' | 'C' | 'D';
  wasCorrect: boolean;
}

const TOTAL_ROUNDS = 3;
const QUESTIONS_PER_ROUND = 3;

const fsm = createFsm<Data>();

const renderScoreboardMd = (data: Readonly<Data>): string => {
  const total = data.rounds.reduce((s, r) => s + r.correct, 0);
  const max = data.rounds.reduce((s, r) => s + r.total, 0);
  const lines = [
    '# Trivia Scoreboard',
    '',
    `**Final score: ${total} / ${max}**`,
    '',
    '| Round | Genre | Correct | Total |',
    '|---|---|---|---|',
  ];
  for (const r of data.rounds) {
    lines.push(`| ${r.round} | ${r.genre} | ${r.correct} | ${r.total} |`);
  }
  return lines.join('\n') + '\n';
};

function appendRound(data: Readonly<Data>, payload: AskQuestionPayload): RoundRecord {
  const finalCorrect = data.currentRoundCorrect + (payload.wasCorrect ? 1 : 0);
  return {
    round: data.round,
    genre: data.currentGenre ?? '(unknown)',
    correct: finalCorrect,
    total: QUESTIONS_PER_ROUND,
  };
}

export default fsm.machine({
  id: 'trivia-rounds',
  initial: 'pickGenre',
  data: () => ({
    round: 1,
    qInRound: 0,
    currentGenre: null,
    currentRoundCorrect: 0,
    rounds: [],
  }),
  states: {
    pickGenre: fsm.state({
      prompt:
        'This is the first round of a 3-round trivia game. Map the owner reply to a short genre label ' +
        '(e.g. "movies", "science", "history", "sports"). Submit the genre.',
      ask: (data) =>
        `Round ${data.round} of ${TOTAL_ROUNDS}. ` +
        'Pick a trivia genre: 1) movies  2) science  3) history. Reply with a number or genre name.',
      on: {
        submit: fsm.submit<{ genre: string }>({
          to: 'askQuestion',
          reduce: (draft, payload) => {
            draft.currentGenre = payload.genre;
            draft.qInRound = 0;
            draft.currentRoundCorrect = 0;
          },
        }),
      },
    }),
    pickGenreFresh: fsm.state({
      prompt: (data) =>
        `This is round ${data.round} of 3. The aharness cleared your model context between rounds — ` +
        'tell the owner one short sentence acknowledging that you have no memory of the earlier rounds, ' +
        'then ask for the new genre. Map the owner reply to a short genre label ' +
        '(e.g. "movies", "science", "history", "sports"). Submit the genre.',
      ask: (data) =>
        `Round ${data.round} of ${TOTAL_ROUNDS}. ` +
        'Pick a trivia genre: 1) movies  2) science  3) history. Reply with a number or genre name.',
      clearOnEntry: true,
      on: {
        submit: fsm.submit<{ genre: string }>({
          to: 'askQuestion',
          reduce: (draft, payload) => {
            draft.currentGenre = payload.genre;
            draft.qInRound = 0;
            draft.currentRoundCorrect = 0;
          },
        }),
      },
    }),
    askQuestion: fsm.state({
      prompt: (data) =>
        `Compose ONE multiple-choice trivia question on the genre "${data.currentGenre ?? '?'}". ` +
        `This is question ${data.qInRound + 1} of ${QUESTIONS_PER_ROUND} in round ${data.round}. ` +
        'Present it as a short text message with four labelled choices A) B) C) D), then ' +
        'use request_user_input to ask the owner to reply with a single letter A/B/C/D. ' +
        'After the owner replies, judge correctness yourself and submit the full record ' +
        "(question text, the correct letter, the owner's letter, and wasCorrect).",
      ask: 'Your answer? Reply with A, B, C, or D.',
      on: {
        submit: fsm.submit<AskQuestionPayload>({
          route: [
            {
              if: (data, payload) => {
                const correctNow = (payload.wasCorrect ? 1 : 0) + data.currentRoundCorrect;
                return (
                  data.qInRound + 1 >= QUESTIONS_PER_ROUND &&
                  data.round >= TOTAL_ROUNDS &&
                  correctNow >= 0
                );
              },
              to: 'finalize',
              reduce: (draft, payload) => {
                draft.rounds = [...draft.rounds, appendRound(draft, payload)];
                draft.currentRoundCorrect += payload.wasCorrect ? 1 : 0;
                draft.qInRound += 1;
              },
            },
            {
              if: (data) => data.qInRound + 1 >= QUESTIONS_PER_ROUND,
              to: 'pickGenreFresh',
              reduce: (draft, payload) => {
                draft.rounds = [...draft.rounds, appendRound(draft, payload)];
                draft.round += 1;
                draft.qInRound = 0;
                draft.currentRoundCorrect = 0;
                draft.currentGenre = null;
              },
            },
            {
              to: 'askQuestion',
              reduce: (draft, payload) => {
                draft.qInRound += 1;
                draft.currentRoundCorrect += payload.wasCorrect ? 1 : 0;
              },
            },
          ],
        }),
      },
    }),
    finalize: fsm.final({
      outcome: 'success',
      artifacts: {
        'scoreboard.md': renderScoreboardMd,
      },
    }),
  },
});
