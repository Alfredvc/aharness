import { harness, final, embed } from '../../../src/index.js';
import child from './child-with-input.fsm.js';

export default harness.machine({
  id: 'parentMissingInput',
  initial: 'inner',
  states: {
    inner: embed(child, {
      // Intentionally omits `input:` projection — the child requires `topic`,
      // so the verifier must flag this.
      on: { shipped: { target: 'done' }, failed: { target: 'inner' } },
    } as never),
    done: final({ outcome: 'success' }),
  },
});
