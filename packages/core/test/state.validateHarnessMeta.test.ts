import { describe, expect, it } from 'vitest';
import { validateHarnessMeta } from '../src/state/validateHarnessMeta.js';

describe('validateHarnessMeta — embedded compound shape', () => {
  it('returns undefined for an embedded compound meta (no kind field)', () => {
    const meta = {
      embedded: { source: 'child', exits: ['shipped'], onMap: { shipped: { target: 'next' } } },
    };
    expect(validateHarnessMeta(meta)).toBeUndefined();
  });

  it('still throws for genuinely malformed meta (no kind, no embedded)', () => {
    expect(() => validateHarnessMeta({ random: 'noise' })).toThrow(/unknown kind/);
  });

  it('still validates the three existing kinds', () => {
    expect(validateHarnessMeta({ kind: 'passive' })).toEqual({ kind: 'passive' });
    expect(validateHarnessMeta({ kind: 'terminal', outcome: 'success' })).toEqual({
      kind: 'terminal',
      outcome: 'success',
    });
  });
});
