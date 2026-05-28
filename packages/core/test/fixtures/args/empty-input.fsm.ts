import { aharness, state, exit, final } from '@aharness/core';

export default aharness.machine({
  input: {},
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
