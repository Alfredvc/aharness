/**
 * Fixture for Task 21 dynamic-completion bridge tests
 * (`cli.completion.test.ts`).
 *
 * Two `arg`s exercise both legs of the dynamic-callback path:
 *   - `project`: callback returns prefix-filtered matches (happy path).
 *   - `broken`: callback throws unconditionally (asserts the bridge's
 *     per-callback try/catch swallows errors and emits nothing).
 */
import { aharness, state, exit, final, arg } from '@aharness/core';

export default aharness.machine({
  input: {
    project: arg<string>({
      description: 'Project name',
      completion: {
        dynamic: (partial) => ['alpha', 'beta', 'gamma'].filter((s) => s.startsWith(partial)),
      },
    }),
    broken: arg<string>({
      description: 'Always-throwing callback (for error-suppression test)',
      completion: {
        dynamic: () => {
          throw new Error('intentional callback failure');
        },
      },
    }),
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
