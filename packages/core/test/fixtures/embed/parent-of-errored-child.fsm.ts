import { aharness, state, exit, final, embed } from '@aharness/core';
import errored from './child-with-error.fsm.js';

export default aharness.machine({
  id: 'parentOfErroredChild',
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'choose',
      exits: {
        go: exit<{ ok: boolean }>({ to: 'inner' }),
      },
    }),
    inner: embed(errored, {
      on: {
        shipped: { target: 'done' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
