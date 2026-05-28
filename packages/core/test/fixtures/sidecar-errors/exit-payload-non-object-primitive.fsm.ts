// Fixture: submit exit declares exit<string>(...) — a non-object primitive.
// Expected issue: exit-payload-non-object for stateId='s1', exitName='done'.
import { aharness, state, exit, final } from '@aharness/core';

export default aharness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        done: exit<string>({ to: 'end' }),
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
