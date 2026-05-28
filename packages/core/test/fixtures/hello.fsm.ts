import { harness, state, exit, terminal } from '@aharness/core';

interface FinishPayload {
  _empty?: never;
}

export default harness.machine({
  id: 'hello',
  initial: 'greet',
  states: {
    greet: state({
      entryPrompt:
        'Call harness_submit({state: "greet", exit: "finish", data: {}}) to end the run.',
      exits: {
        finish: exit<FinishPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});
