// Fixture: submit exit declares exit<unknown>(...).
// Expected issue: exit-payload-unknown for stateId='s1', exitName='done'.
import { aharness, state, exit, final } from '@aharness/core';

export default aharness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        done: exit<unknown>({ to: 'end' }),
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
