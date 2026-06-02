import { aharness, exit, final, state, skill } from '@aharness/core';

interface LocalPayload {
  readonly ok: boolean;
}

export default aharness.machine({
  id: 'same-package-child',
  availableSkills: [skill({ path: './same-child-skill/SKILL.md' })],
  initial: 'local',
  states: {
    local: state({
      entryPrompt: 'same package child',
      exits: {
        done: exit<LocalPayload>({
          when: [{ guard: ({ event }) => event.payload.ok, to: 'shipped' }, { to: 'failed' }],
        }),
      },
    }),
    shipped: final({ outcome: 'success' }),
    failed: final({ outcome: 'failure' }),
  },
});
