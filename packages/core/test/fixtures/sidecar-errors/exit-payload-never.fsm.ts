// Fixture: submit exit declares exit<never>(...).
// Expected issue: exit-payload-never for stateId='s1', exitName='done'.
import { harness, state, exit, final } from '@aharness/core';

export default harness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        done: exit<never>({ to: 'end' }),
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
