// Static-only fixture: the child's submit exit declares `exit<any>(...)`
// so the loader emits an `exit-payload-any` issue. Used to assert that child
// issues forward up to the parent's sidecar with stateIds prefixed.
import { aharness, state, exit, final } from '@aharness/core';

export default aharness.machine({
  id: 'childWithError',
  initial: 'broken',
  states: {
    broken: state({
      entryPrompt: 'broken',
      exits: {
        // oxlint-disable-next-line typescript/no-explicit-any
        out: exit<any>({ to: 'shipped' }),
      },
    }),
    shipped: final({ outcome: 'success' }),
  },
});
