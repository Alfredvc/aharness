import { aharness, exit, final, state, skillDir } from '@aharness/core';
import { dependencyHelper } from '../src/dependency-helper.js';

interface DependencyPayload {
  readonly source: string;
}

export default aharness.machine({
  id: `dependency-child-${dependencyHelper()}`,
  availableSkills: [skillDir('./dependency-skills')],
  initial: 'dependency',
  states: {
    dependency: state({
      entryPrompt: `dependency child ${dependencyHelper()}`,
      exits: {
        done: exit<DependencyPayload>({
          when: [
            { guard: ({ event }) => event.payload.source === 'ok', to: 'dependencyDone' },
            { to: 'dependencyFailed' },
          ],
        }),
      },
    }),
    dependencyDone: final({ outcome: 'success' }),
    dependencyFailed: final({ outcome: 'failure' }),
  },
});
