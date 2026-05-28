// Static-only fixture: the loader extracts schemas via AST walking, so this
// file does not need to be runtime-evaluable. Pairing with `loader-cycle-b`
// to verify the loader's cycle guard breaks the recursion at the AST level.
// At runtime, the matching pair would form an import cycle and fail; that
// is the runtime verifier's `embedding-acyclic` job, not the loader's.
import { aharness, state, exit, final, embed } from '@aharness/core';
import other from './loader-cycle-b.fsm.js';

export default aharness.machine({
  id: 'loaderCycleA',
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
        done: { target: 'finished' },
      },
    }),
    finished: final({ outcome: 'success' }),
  },
});
