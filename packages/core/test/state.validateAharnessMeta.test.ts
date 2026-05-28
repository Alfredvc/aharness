import { describe, expect, it } from 'vitest';
import { validateAharnessMeta } from '../src/state/validateAharnessMeta.js';

describe('validateAharnessMeta — embedded compound shape', () => {
  it('returns undefined for an embedded compound meta (no kind field)', () => {
    const meta = {
      embedded: { source: 'child', exits: ['shipped'], onMap: { shipped: { target: 'next' } } },
    };
    expect(validateAharnessMeta(meta)).toBeUndefined();
  });

  it('still throws for genuinely malformed meta (no kind, no embedded)', () => {
    expect(() => validateAharnessMeta({ random: 'noise' })).toThrow(/unknown kind/);
  });

  it('still validates the three existing kinds', () => {
    expect(validateAharnessMeta({ kind: 'passive' })).toEqual({ kind: 'passive' });
    expect(validateAharnessMeta({ kind: 'terminal', outcome: 'success' })).toEqual({
      kind: 'terminal',
      outcome: 'success',
    });
  });
});
