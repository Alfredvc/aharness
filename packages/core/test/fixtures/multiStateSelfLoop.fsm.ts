import { aharness, state, exit, terminal } from '@aharness/core';

interface FinishPayload {
  _empty?: never;
}

export default aharness.machine({
  id: 'multi-state-self-loop',
  initial: 'counting',
  states: {
    counting: state({
      entryPrompt:
        'Call aharness_submit with exit=increment to self-loop, or exit=finish to terminate.',
      exits: {
        increment: exit<{ delta: number }>({
          to: 'counting',
        }),
        finish: exit<FinishPayload>({
          to: 'done',
        }),
      },
    }),
    done: terminal('success'),
  },
});
