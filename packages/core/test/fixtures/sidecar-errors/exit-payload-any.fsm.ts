// Fixture: submit exit declares exit<any>(...).
// Expected issue: exit-payload-any for stateId='s1', exitName='done'.
import { harness, state, exit, final } from '@aharness/core';

export default harness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        // oxlint-disable-next-line typescript/no-explicit-any
        done: exit<any>({ to: 'end' }),
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
