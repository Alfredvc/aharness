import { describe, expect, it } from 'vitest';

import { createHarnessOps } from '../src/state/harnessOps.js';

describe('createHarnessOps', () => {
  it('exposes an empty reserved operations object', () => {
    const h = createHarnessOps();
    expect(h.ops).toEqual({});
  });

  it('does not expose clear at runtime', () => {
    const h = createHarnessOps();
    expect('clear' in h.ops).toBe(false);
  });
});
