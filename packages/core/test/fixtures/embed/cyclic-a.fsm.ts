import { aharness, state, exit, final } from '../../../src/index.js';
// NOT using embed() — the cycle is constructed by hand inside the test
// to exercise the verifier's independent walk.
export default aharness.machine({
  id: 'cyclicA',
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
