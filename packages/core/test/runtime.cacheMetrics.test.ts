/**
 * Tests for `daemon/cacheMetrics.ts`. Pins:
 *
 *   - the running totals add correctly across observations,
 *   - the cumulative ratio is `null` during the four-turn warm-up
 *     window and computed from turn five onward,
 *   - `healthy` flips to `false` once the post-warm-up ratio falls
 *     below the 70 % soft floor.
 *
 * The observe-API uses snake_case (`input_tokens`,
 * `cached_input_tokens`) intentionally; see the file-level doc-comment
 * on `cacheMetrics.ts` for the rationale (codex's persisted shape uses
 * snake_case; the v2 wire surface is camelCase and the router does the
 * boundary translation).
 */
import { describe, expect, it } from 'vitest';

import { CacheMetrics } from '../src/runtime/cacheMetrics.js';

describe('CacheMetrics', () => {
  it('tracks cached-input ratio across turns', () => {
    const m = new CacheMetrics();
    m.observe({ input_tokens: 1000, cached_input_tokens: 0 });
    m.observe({ input_tokens: 1100, cached_input_tokens: 800 });
    m.observe({ input_tokens: 1300, cached_input_tokens: 1000 });
    const r = m.summary();
    expect(r.totalInput).toBe(3400);
    expect(r.totalCached).toBe(1800);
    expect(r.ratioPctSinceTurn5).toBeNull(); // <5 turns
  });

  it('flags warning when ratio drops below threshold after turn 5', () => {
    const m = new CacheMetrics();
    for (let i = 0; i < 6; i++) m.observe({ input_tokens: 1000, cached_input_tokens: 100 }); // 10%
    const r = m.summary();
    expect(r.ratioPctSinceTurn5).not.toBeNull();
    expect(r.ratioPctSinceTurn5!).toBeLessThan(70);
    expect(r.healthy).toBe(false);
  });
});
