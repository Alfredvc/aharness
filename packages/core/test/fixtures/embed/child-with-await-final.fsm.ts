/**
 * Test fixture for the submit-driven branch of the embed boundary.
 *
 * Topology:
 *
 *   ask (stateful) ──submit→ shipped (final, success)
 *
 * The original AWAIT fixture used the retired low-level await exit surface.
 * Slice 4 keeps this boundary coverage with a submit exit.
 */
import { aharness, state, exit, final } from '../../../src/index.js';

interface WaitData {
  readonly _empty?: never;
}

export default aharness.machine({
  id: 'child-await',
  initial: 'ask',
  states: {
    ask: state({
      entryPrompt: 'wait for it',
      exits: {
        wait: exit<WaitData>({ to: 'shipped' }),
      },
    }),
    shipped: final({ outcome: 'success' }),
  },
});
