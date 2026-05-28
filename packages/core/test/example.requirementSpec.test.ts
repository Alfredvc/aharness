/**
 * FSM-compiles smoke for the requirement-spec fixture. Imports the
 * fixture module via vitest's resolver — exercising the `@aharness/core`
 * re-export surface end-to-end and asserting the machine constructs
 * with the expected `id` and contains the canonical 9 states.
 *
 * The runtime traversal lives in `phase9.realtui.e2e.test.ts`, which
 * spawns a real `codex --remote` TUI through the CLI and asserts on
 * the run-dir artifacts. That test is gated behind `hasCodex` + an
 * explicit `AHARNESS_E2E_REAL_CODEX=1` opt-in.
 */
import { describe, expect, it } from 'vitest';

import { machine } from './fixtures/requirement-spec.fsm.js';

const EXPECTED_STATES = [
  'askGoal',
  'iterateRequirements',
  'research',
  'flagIncompatibilities',
  'probeMissingRequirements',
  'presentDraft',
  'reviseWithOwner',
  'reviewerPass',
  'finalize',
] as const;

describe('requirement-spec fixture', () => {
  it('FSM compiles unchanged against @aharness/core re-exports', () => {
    expect(machine).toBeDefined();
    expect(machine.id).toBe('requirement-spec');

    const stateIds = Object.keys(machine.states);
    for (const expected of EXPECTED_STATES) {
      expect(stateIds).toContain(expected);
    }
    expect(stateIds).toHaveLength(EXPECTED_STATES.length);
  });

  // Runtime traversal lives in `phase9.realtui.e2e.test.ts`.
});
