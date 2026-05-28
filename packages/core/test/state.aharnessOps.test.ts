import { describe, expect, it } from 'vitest';

import { createAharnessOps } from '../src/state/aharnessOps.js';

describe('createAharnessOps', () => {
  it('exposes an empty reserved operations object', () => {
    const h = createAharnessOps();
    expect(h.ops).toEqual({});
  });

  it('does not expose clear at runtime', () => {
    const h = createAharnessOps();
    expect('clear' in h.ops).toBe(false);
  });
});
