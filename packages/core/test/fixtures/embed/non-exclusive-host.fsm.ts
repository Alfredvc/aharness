import { aharness, state, exit, final, embed } from '../../../src/index.js';
import child from './child.fsm.js';

// Bypass attempt: spread embed(child, ...) and bolt extras on. This is what
// the verifier check must catch.
const compound = embed(child, {
  on: {
    shipped: { target: 'done' },
    failed: { target: 'router' },
  },
});

export default aharness.machine({
  id: 'nonExclusive',
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'go',
      exits: { go: exit<{ pick: 1 }>({ to: 'inner' }) },
    }),
    inner: {
      ...compound,
      // Author bolt-ons that must be rejected:
      entryPrompt: 'should not be here' as never,
    } as never,
    done: final({ outcome: 'success' }),
  },
});
