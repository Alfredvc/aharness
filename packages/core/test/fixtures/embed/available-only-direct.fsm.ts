import { aharness, skill, skillDir } from '@aharness/core';

export default aharness.machine({
  id: 'availableOnlyDirect',
  availableSkills: [
    skill({ path: './direct-only/SKILL.md', optional: true }),
    skillDir('./direct-dir'),
  ],
  initial: 'done',
  states: {
    done: { type: 'final' },
  },
});
