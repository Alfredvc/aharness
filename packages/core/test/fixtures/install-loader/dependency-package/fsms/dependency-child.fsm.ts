import { aharness, exit, final, state } from '@aharness/core';
import { dependencyHelper } from '../src/dependency-helper.js';

interface DependencyPayload {
  readonly source: string;
}

export default aharness.machine({
  id: `dependency-child-${dependencyHelper()}`,
  initial: 'dependency',
  states: {
    dependency: state({
      entryPrompt: `dependency child ${dependencyHelper()}`,
      exits: {
        done: exit<DependencyPayload>({ to: 'dependencyDone' }),
      },
    }),
    dependencyDone: final({ outcome: 'success' }),
    dependencyFailed: final({ outcome: 'failure' }),
  },
});
