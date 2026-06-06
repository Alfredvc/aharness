import { aharness, arg, exit, final, state } from '@aharness/core';

export default aharness.machine({
  input: {
    topic: arg<string>({ description: 'Topic' }),
  },
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'Run the installed CLI shim command.',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
