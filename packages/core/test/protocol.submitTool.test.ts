/**
 * Stability test for the frozen `SUBMIT_TOOL` constant.
 *
 * The codex `app-server` derives a cache key from the `thread/start`
 * `dynamicTools` array (design §10). Any byte-level drift in the tool
 * declaration will invalidate that cache key for every prior run, which
 * is a substantial behavioural change. To prevent silent edits, this
 * test pins the SHA-256 of `JSON.stringify(SUBMIT_TOOL)`. A deliberate
 * change must update both the constant in
 * `packages/core/src/protocol/submitTool.ts` AND the hash below
 * in the same commit, with a note in the PR explaining why.
 *
 * The test additionally asserts that the constant (and its
 * `inputSchema`) are frozen, since the cache-key invariant relies on
 * the runtime object not being mutated under us.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { SUBMIT_TOOL } from '../src/protocol/submitTool.js';

const PINNED_SHA256 = '0bd11a6aa265e4dec9f1e7b9c7657418435e5e6dd876946f644fd8113a1e8b7b';

describe('SUBMIT_TOOL', () => {
  it('matches the pinned SHA-256 of its JSON serialization', () => {
    const hash = createHash('sha256').update(JSON.stringify(SUBMIT_TOOL)).digest('hex');
    expect(hash).toBe(PINNED_SHA256);
  });

  it('is frozen at the top level and at `inputSchema`', () => {
    expect(Object.isFrozen(SUBMIT_TOOL)).toBe(true);
    expect(Object.isFrozen(SUBMIT_TOOL.inputSchema)).toBe(true);
  });

  it('uses the camelCase wire field `inputSchema` (not `parameters`)', () => {
    expect(SUBMIT_TOOL).toHaveProperty('inputSchema');
    expect(SUBMIT_TOOL).not.toHaveProperty('parameters');
  });

  it('has tool name "aharness_submit"', () => {
    expect(SUBMIT_TOOL.name).toBe('aharness_submit');
  });

  it('declares `readOnlyHint: true` so codex skips the synchronous approval prompt', () => {
    expect(SUBMIT_TOOL.readOnlyHint).toBe(true);
  });
});
