import { harness, state, exit, final } from '@aharness/core';

interface LeafPayload {
  readonly leafOk: boolean;
}

export default harness.machine({
  id: 'grandchild',
  initial: 'leaf',
  states: {
    leaf: state({
      entryPrompt: 'leaf',
      exits: {
        out: exit<LeafPayload>({ to: 'leafDone' }),
      },
    }),
    leafDone: final({ outcome: 'success' }),
  },
});
