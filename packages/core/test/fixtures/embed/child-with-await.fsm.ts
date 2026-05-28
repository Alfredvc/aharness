/**
 * Test fixture for the daemon-path embed-meta parity tests
 * (`daemon.embed.dispatch.test.ts`).
 *
 * Topology:
 *
 *   ask (stateful, awaitsOwnerText, submit→shipped) ─submit→ shipped (final)
 *
 * The combination of `awaitsOwnerText` + a SUBMIT exit on the same leaf is
 * what makes this fixture useful for fencing the daemon's meta-readers
 * against an embedded leaf: the `currentMeta()` projection must surface
 * the leaf's `awaitsOwnerText`, `entryPrompt`, and `exits` verbatim
 * once the leaf is the active leaf inside an embed-host parent.
 */
import { aharness, state, exit, final } from '../../../src/index.js';

interface ReplyPayload {
  readonly reply: string;
}

export default aharness.machine({
  id: 'childWithAwait',
  initial: 'ask',
  states: {
    ask: state({
      entryPrompt: 'ask the user',
      awaitsOwnerText: { messageToUser: 'Tell me' },
      exits: {
        out: exit<ReplyPayload>({ to: 'shipped' }),
      },
    }),
    shipped: final({ outcome: 'success' }),
  },
});
