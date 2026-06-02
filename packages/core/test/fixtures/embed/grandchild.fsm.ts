import { aharness, state, exit, final, skillDir } from '@aharness/core';

interface LeafPayload {
  readonly leafOk: boolean;
}

export default aharness.machine({
  id: 'grandchild',
  availableSkills: [skillDir('./grandchild-skills')],
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
