// Fixture: an await-kind exit erroneously wrapped in exit<T>(...).
// Expected issue: await-with-payload for stateId='s1', exitName='done'.
//
// Note: this intentionally violates the exit() runtime contract (await exits
// must be plain object literals, not passed through the exit() factory). The
// loader's AST walker detects `kind: 'await'` inside the factory argument and
// emits `await-with-payload`. The fixture is @ts-nocheck because the runtime
// type signature of exit() does not accept kind:'await' arguments; the loader
// builds its own TS program with skipTypeCheck:true so AST extraction still works.
//
// @ts-nocheck
import { aharness, state, exit, final } from '@aharness/core';

export default aharness.machine({
  initial: 's1',
  states: {
    s1: state({
      entryPrompt: 'go',
      exits: {
        // await exits must be plain object literals — wrapping in exit() is
        // an authoring error detected at the AST level.
        done: exit({ kind: 'await', to: 'end' }),
      },
    }),
    end: final({ outcome: 'success' }),
  },
});
