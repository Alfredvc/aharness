/**
 * Fixture exercising the `skill()` author surface in the verifier path.
 * Declares a name-form skill that the test suite asserts is missing
 * (no `.agents/skills/` tree) and a path-form skill pointing at a
 * sibling file that DOES exist (the test creates it).
 */
import { harness, state, terminal, exit, skill } from '@aharness/core';

interface AskPayload {
  q: string;
}

export const machine = harness.machine({
  id: 'skills-fixture',
  initial: 'ask',
  context: () => ({ __harness_visitCount: {} as Record<string, number> }),
  states: {
    ask: state({
      entryPrompt: 'Ask.',
      skills: [skill('not-installed'), skill({ path: './skills/local.md' })],
      exits: {
        ok: exit<AskPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
