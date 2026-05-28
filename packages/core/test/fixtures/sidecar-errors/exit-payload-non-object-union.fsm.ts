// Fixture: submit exit declares a discriminated union at the top level.
// Expected issue: exit-payload-non-object for stateId='s1', exitName='done'.
// The union must be wrapped in an object property (e.g. exit<{ next: A | B }>).
import { harness, state, exit, final } from '@aharness/core';

interface BranchA {
  readonly kind: 'a';
  readonly value: number;
}
interface BranchB {
  readonly kind: 'b';
  readonly label: string;
}

export default harness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        done: exit<BranchA | BranchB>({ to: 'end' }),
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
