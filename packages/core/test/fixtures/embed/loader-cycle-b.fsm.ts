// See `loader-cycle-a.fsm.ts` for the static-only fixture rationale.
import { harness, state, exit, final, embed } from '@aharness/core';
import other from './loader-cycle-a.fsm.js';

export default harness.machine({
  id: 'loaderCycleB',
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: {
        out: exit<{ ok: boolean }>({ to: 'inner' }),
      },
    }),
    inner: embed(other, {
      on: {
        finished: { target: 'done' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
