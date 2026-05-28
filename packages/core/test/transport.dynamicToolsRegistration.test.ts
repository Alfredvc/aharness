/**
 * Phase 1 dynamic-tools registration helper tests
 * (`transport/dynamicToolsRegistration.ts`).
 *
 * Phase 1 ships exactly the frozen `SUBMIT_TOOL` on every
 * `thread/start.dynamicTools` call. Description must stay byte-identical
 * so codex's prompt-cache key derived from `dynamicTools` stays stable
 * (spec §10).
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-1a-transport-backbone.md` Task 6.
 *
 * Note: this test imports from the module's direct path (not the
 * `runtime.ts` barrel) because the barrel re-export is consolidated
 * across the parallel Group D tasks in a separate commit; the helper
 * itself is the unit under test.
 */
import { describe, it, expect } from 'vitest';

import { buildDynamicToolsRegistration } from '../src/transport/dynamicToolsRegistration.js';
import { SUBMIT_TOOL } from '../src/protocol/submitTool.js';

describe('buildDynamicToolsRegistration', () => {
  it('returns an array containing exactly the aharness_submit tool', () => {
    const tools = buildDynamicToolsRegistration();
    expect(tools).toEqual([SUBMIT_TOOL]);
  });
});
