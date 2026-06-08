import { createFsm, skill } from '@aharness/core';

interface Data {
  status: string;
}

const base = createFsm<Data>();
const fsm = base.withEvents({
  sidecarDone: base.event<{ status: string }>(),
});

export default fsm.machine({
  id: 'sidecar-thread-fixture',
  threadSkills: {
    research: skill({ path: './skills/sidecar-research/SKILL.md' }),
  },
  data: () => ({ status: 'pending' }),
  initial: 'work',
  states: {
    work: fsm.state({
      prompt: 'Launch a sidecar and report its boundary result.',
      entry: async (_data, ops) => {
        const thread = await ops.codex.createThread('research', {
          initialSkills: ['research'],
          label: 'Research',
        });
        const result = await thread.send('Summarize the sidecar fixture constraints.');
        await thread.close();
        await ops.emit('sidecarDone', {
          status: result.ok ? result.kind : result.reason,
        });
      },
      on: {
        sidecarDone: {
          to: 'done',
          reduce: (draft, payload) => {
            draft.status = payload.status;
          },
        },
      },
    }),
    done: fsm.final({
      outcome: 'success',
      artifacts: {
        'sidecar-status.txt': (data) => data.status,
      },
    }),
  },
});
