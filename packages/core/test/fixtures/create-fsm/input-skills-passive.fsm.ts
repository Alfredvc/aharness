import { createFsm } from '@aharness/core';

interface Data {
  topic: string;
  rounds: number;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'canonical-input-skills-passive',
  input: {
    topic: fsm.input.string({
      description: 'Project topic',
      complete: fsm.input.values(['auth', 'billing']),
    }),
    rounds: fsm.input.number({ default: 3 }),
    specPath: fsm.input.path({ description: 'Spec file', complete: 'file' }),
  },
  data: ({ input }) => ({ topic: input.topic, rounds: input.rounds }),
  initial: 'prepare',
  states: {
    prepare: fsm.state({
      prompt: (data) => `Prepare ${data.topic}.`,
      skills: [fsm.skill.path('./skills/reviewer/SKILL.md', { optional: true })],
      on: {
        submit: fsm.submit<{ ready: boolean }>({
          route: [{ if: (_data, payload) => payload.ready, to: 'wait' }, { to: 'prepare' }],
        }),
      },
    }),
    wait: fsm.passive({
      always: { target: 'done' },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
