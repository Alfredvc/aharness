import { aharness, state, exit, final, arg } from '@aharness/core';

throw new Error('input-help fixture was imported');

export default aharness.machine({
  input: {
    safe: arg<string>({ description: 'Static field' }),
  },
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
