import { harness, state, exit, final } from '../../../src/index.js';

interface PayloadOk {
  readonly ok: boolean;
}

export default harness.machine({
  id: 'child',
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'do the thing',
      exits: {
        out: exit<PayloadOk>({ to: 'shipped' }),
        bad: exit<PayloadOk>({ to: 'failed' }),
      },
    }),
    shipped: final({
      outcome: 'success',
      // Consume the SUBMIT event that drove the transition into shipped, so
      // tests can assert event.output reflects the SUBMIT payload that caused
      // the transition rather than a default literal.
      output: ({ event }) => ({
        ok: true,
        receivedFromSubmit: (event as { payload?: { ok?: boolean } }).payload?.ok,
      }),
    }),
    failed: final({ outcome: 'failure' }),
  },
});
