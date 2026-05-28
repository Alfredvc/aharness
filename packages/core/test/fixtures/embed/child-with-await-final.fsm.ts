/**
 * Test fixture for the AWAIT-driven branch of the embed boundary.
 *
 * Topology:
 *
 *   ask (stateful) ──await→ shipped (final, success)
 *
 * Used by `state.embed.runToCompletion.test.ts` to fence run-to-completion
 * semantics on the AWAIT path through the embed boundary, parallel to
 * `child.fsm.ts`'s SUBMIT path.
 */
import { aharness, state, final } from '../../../src/index.js';

export default aharness.machine({
  id: 'child-await',
  initial: 'ask',
  states: {
    ask: state({
      entryPrompt: 'wait for it',
      exits: {
        wait: { kind: 'await', to: 'shipped' },
      },
    }),
    shipped: final({ outcome: 'success' }),
  },
});
