import { aharness, createFsm, skill } from '@aharness/core';

const fsm = createFsm();
const maybeOptional = Math.random() > 0.5;

export default aharness.machine({
  id: 'malformedAvailableOptional',
  availableSkills: [
    skill({ path: './direct-valid/SKILL.md', optional: false }),
    skill({ path: './direct-dynamic/SKILL.md', optional: maybeOptional }),
    fsm.skill.path('./canonical-valid/SKILL.md', { optional: true }),
    fsm.skill.path('./canonical-dynamic/SKILL.md', { optional: maybeOptional }),
  ],
  initial: 'done',
  states: {
    done: { type: 'final' },
  },
});
