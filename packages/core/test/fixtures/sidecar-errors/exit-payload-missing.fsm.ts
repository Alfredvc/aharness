// Fixture: submit exit declared as a plain object literal (no exit<T>() wrapper).
// Expected issue: exit-payload-missing for stateId='s1', exitName='done'.
import { harness, state, final } from '@aharness/core';

export default harness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        // Plain object literal — author forgot the exit<T>({...}) wrapper.
        done: { to: 'end' },
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
