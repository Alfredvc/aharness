import { aharness, state, exit, final, arg } from '@aharness/core';

interface Payload {
  readonly id: string;
}

export default aharness.machine({
  input: {
    topic: arg<string>({ description: 'Project topic' }),
    dryRun: arg<boolean>({ description: 'Skip execution', default: false }),
    payload: arg<Payload>({ description: 'JSON payload' }),
  },
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
