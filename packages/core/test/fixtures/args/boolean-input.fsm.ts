import { aharness, state, exit, final, arg } from '@aharness/core';

export default aharness.machine({
  input: {
    worktree: arg<boolean>({ description: 'Use a git worktree', default: false }),
    ideafilePath: arg<string>({ description: 'Path to ideafile', completion: 'file' }),
    topic: arg<string>({ description: 'Project slug' }),
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
