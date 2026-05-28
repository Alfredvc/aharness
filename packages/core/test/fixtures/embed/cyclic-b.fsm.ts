import { harness, state, exit, final } from '../../../src/index.js';
export default harness.machine({
  id: 'cyclicB',
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
