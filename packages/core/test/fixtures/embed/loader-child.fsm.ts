import { aharness, state, exit, final } from '@aharness/core';

interface PayloadOk {
  readonly ok: boolean;
}

export default aharness.machine({
  id: 'loaderChild',
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: {
        out: exit<PayloadOk>({ to: 'shipped' }),
        bad: exit<PayloadOk>({ to: 'failed' }),
      },
    }),
    shipped: final({ outcome: 'success' }),
    failed: final({ outcome: 'failure' }),
  },
});
