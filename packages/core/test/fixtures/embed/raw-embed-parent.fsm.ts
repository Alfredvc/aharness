import { aharness, embed, final, state, exit } from '@aharness/core';

interface Payload {
  readonly ok: boolean;
}

const rawChild = {
  id: 'rawChild',
  initial: 'leaf',
  states: {
    leaf: {
      on: {
        finish: 'done',
      },
    },
    done: { type: 'final' },
  },
};

export default aharness.machine({
  id: 'rawEmbedParent',
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'route',
      exits: {
        go: exit<Payload>({ to: 'raw' }),
      },
    }),
    raw: embed(rawChild, {
      on: {
        done: { target: 'done' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
