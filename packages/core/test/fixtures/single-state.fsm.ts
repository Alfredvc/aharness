/**
 * Passing FSM fixture for the codex-side `aharness verify` CLI test.
 *
 * Single stateful state with one submit exit targeting a terminal state.
 * Mirrors `packages/sdk/src/loader/fixtures/simple.fsm.ts` so the schema
 * sidecar extractor (which is keyed off `@aharness/core` imports) can
 * discover the `state(...)` call and emit a `payload` JSON Schema for the
 * `askGoal::ok` exit.
 *
 * The exit is named `ok` for fixture-symmetry with `simple.fsm.ts`. Either
 * `ok` or `submit` would verify — the retired `mcp-submit-tool-name-collision`
 * check used to reject `submit` here, but author identifiers (state ids,
 * exit names) live in JSON payload fields under MCP routing and never
 * surface as tool names, so no collision exists.
 */
import { harness, state, terminal, exit } from '@aharness/core';

interface AskGoalPayload {
  goal: string;
}

export const machine = harness.machine({
  id: 'single-state',
  initial: 'askGoal',
  // Seed framework-managed context so `getRunCtx` does not crash if the
  // bundle is ever instantiated.
  context: () => ({ __harness_visitCount: {} as Record<string, number> }),
  states: {
    askGoal: state({
      entryPrompt: 'Ask the goal.',
      exits: {
        ok: exit<AskGoalPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
