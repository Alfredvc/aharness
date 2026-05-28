import { aharness, state, exit, final, arg } from '../../../src/index.js';

interface PayloadOk {
  readonly ok: boolean;
}

export default aharness.machine({
  id: 'childWithInput',
  input: { topic: arg<string>() },
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: {
        out: exit<PayloadOk>({ to: 'shipped' }),
      },
    }),
    shipped: final({ outcome: 'success' }),
    failed: final({ outcome: 'failure' }),
  },
});
