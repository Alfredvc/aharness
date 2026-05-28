import { harness, state, exit, final, arg } from '@aharness/core';

interface Choice {
  readonly value: 'a' | 'b' | 'c';
}

export default harness.machine({
  input: {
    ideafilePath: arg<string>({ description: 'Path to ideafile', completion: 'file' }),
    topic: arg<string>({ description: 'Project slug' }),
    runs: arg<number>({ description: 'Iterations', default: 3 }),
    choice: arg<Choice>({ description: 'Branch', completion: { values: ['a', 'b', 'c'] } }),
  },
  context: ({
    input,
  }: {
    input: { ideafilePath: string; topic: string; runs: number; choice: Choice };
  }) => ({
    ideafilePath: input.ideafilePath,
    topic: input.topic,
    runs: input.runs,
    choice: input.choice,
  }),
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
