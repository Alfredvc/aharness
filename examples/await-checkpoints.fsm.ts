import { createFsm } from '@aharness/core';

interface Data {
  replies: { lint: string | null; tests: string | null; build: string | null };
}

const fsm = createFsm<Data>();

const renderDeployLogMd = (data: Readonly<Data>): string =>
  [
    '# Deploy Gate Log',
    '',
    'Each row is the user reply that drove the FSM transition out of the',
    'corresponding checkpoint state. The reply text itself fired the',
    'transition (no model submit involved).',
    '',
    '| Stage  | User reply |',
    '| ------ | ---------- |',
    `| lint   | ${data.replies.lint ?? '(none)'} |`,
    `| tests  | ${data.replies.tests ?? '(none)'} |`,
    `| build  | ${data.replies.build ?? '(none)'} |`,
    '',
  ].join('\n');

export default fsm.machine({
  id: 'await-checkpoints',
  initial: 'lintCheck',
  data: () => ({
    replies: { lint: null, tests: null, build: null },
  }),
  states: {
    lintCheck: fsm.state({
      prompt:
        'Pretend a lint pass just ran. Output one short line summarizing a fake (positive) lint ' +
        'result. Then call request_user_input asking the owner exactly: ' +
        '"lint passed — proceed to tests? (yes/no)". Whatever the owner replies, the FSM will ' +
        "advance to the next checkpoint — there's no submit on this state.",
      on: {
        proceed: fsm.await({
          ask: 'lint passed — proceed to tests? (yes/no)',
          to: 'testsCheck',
          reduce: (draft, ownerReply) => {
            draft.replies.lint = ownerReply;
          },
        }),
      },
    }),
    testsCheck: fsm.state({
      prompt:
        'Pretend the test suite just ran. Output one short line summarizing a fake (positive) ' +
        'test result. Then call request_user_input asking the owner exactly: ' +
        '"tests passed — proceed to build? (yes/no)".',
      on: {
        proceed: fsm.await({
          ask: 'tests passed — proceed to build? (yes/no)',
          to: 'buildCheck',
          reduce: (draft, ownerReply) => {
            draft.replies.tests = ownerReply;
          },
        }),
      },
    }),
    buildCheck: fsm.state({
      prompt:
        'Pretend a release build just ran. Output one short line summarizing a fake (positive) ' +
        'build result. Then call request_user_input asking the owner exactly: ' +
        '"build green — ship it? (yes/no)".',
      on: {
        proceed: fsm.await({
          ask: 'build green — ship it? (yes/no)',
          to: 'done',
          reduce: (draft, ownerReply) => {
            draft.replies.build = ownerReply;
          },
        }),
      },
    }),
    done: fsm.final({
      outcome: 'success',
      artifacts: {
        'deploy-log.md': renderDeployLogMd,
      },
    }),
  },
});
