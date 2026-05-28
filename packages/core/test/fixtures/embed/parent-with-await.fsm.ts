/**
 * Parent fixture embedding `child-with-await-final.fsm.ts` to exercise the
 * AWAIT-driven path through the embed boundary in
 * `state.embed.runToCompletion.test.ts`.
 *
 * Topology:
 *
 *   router (stateful) ──submit→ inner (embed of child-await)
 *                                  └── ask ──await→ shipped (final)
 *                                                       │
 *                                                       └── raises 'shipped'
 *                                                              │
 *                                                              └→ done (final)
 */
import { aharness, state, exit, final, embed } from '../../../src/index.js';
import child from './child-with-await-final.fsm.js';

interface RouteData {
  readonly choice: 'embed' | 'skip';
}

export default aharness.machine({
  id: 'parent-await',
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'choose',
      exits: {
        go: exit<RouteData>({ to: 'inner' }),
      },
    }),
    inner: embed(child, {
      on: {
        shipped: { target: 'done' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
