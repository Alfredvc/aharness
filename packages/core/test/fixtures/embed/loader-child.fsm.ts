import { aharness, state, exit, final } from '@aharness/core';
import { createFsm } from '@aharness/core';

const fsm = createFsm();

interface PayloadOk {
  readonly ok: boolean;
}

export default aharness.machine({
  id: 'loaderChild',
  availableSkills: [fsm.skill.path('./child-skill/SKILL.md'), fsm.skill.dir('./child-skills')],
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: {
        out: exit<PayloadOk>({ to: 'shipped' }),
        bad: exit<PayloadOk>({ to: 'failed' }),
      },
    }),
    shipped: final({ outcome: 'success' }),
    failed: final({ outcome: 'failure' }),
  },
});
