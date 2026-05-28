/**
 * Hello-world FSM scaffolded by `aharness init`.
 *
 * Two states:
 *   greet — asks the user for their name, then submits to `done`.
 *   done  — success final.
 */
import { createFsm } from '@aharness/core';

interface Data {
  name: string | null;
}

const fsm = createFsm<Data>();

export const machine = fsm.machine({
  id: 'hello',
  initial: 'greet',
  data: () => ({
    name: null,
  }),
  states: {
    greet: fsm.state({
      prompt:
        'Greet the user warmly, then ask their name. ' +
        'After they reply, submit their name under `name`.',
      ask: 'What is your name?',
      on: {
        submit: fsm.submit<{ name: string }>({
          to: 'done',
          reduce: (draft, payload) => {
            draft.name = payload.name;
          },
        }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});

export default machine;
