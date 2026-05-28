/**
 * Tests for `daemon/resolvePrompt.ts` — pin the string-or-function
 * resolution semantics for `entryPrompt`. Three call sites in the
 * daemon depend on this behaving identically; the tests guard against
 * silent type coercion regressions.
 */
import { describe, expect, it } from 'vitest';
import type { RunCtx } from '@aharness/core';

import { resolveEntryPrompt } from '../src/runtime/resolvePrompt.js';

describe('resolveEntryPrompt', () => {
  it('returns string form unchanged', () => {
    expect(resolveEntryPrompt('hi', { count: 1 } as unknown as RunCtx)).toBe('hi');
  });

  it('calls function form against ctx', () => {
    const fn = (ctx: RunCtx) => `count=${(ctx as unknown as { count: number }).count}`;
    expect(resolveEntryPrompt(fn, { count: 7 } as unknown as RunCtx)).toBe('count=7');
  });

  it('throws when undefined or non-string non-function', () => {
    expect(() =>
      resolveEntryPrompt(
        undefined as unknown as Parameters<typeof resolveEntryPrompt>[0],
        {} as RunCtx,
      ),
    ).toThrow(TypeError);
    expect(() =>
      resolveEntryPrompt(42 as unknown as Parameters<typeof resolveEntryPrompt>[0], {} as RunCtx),
    ).toThrow(TypeError);
  });
});
