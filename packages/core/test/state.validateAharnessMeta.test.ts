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

describe('validateAharnessMeta — clearOnEntry metadata', () => {
  const baseStatefulMeta = {
    kind: 'stateful',
    open: false,
    entryPrompt: 'do thing',
    exits: {},
  };

  it('accepts true and object-form clearOnEntry metadata', () => {
    const fn = () => '/abs/path';

    expect(validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: true })).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: true,
    });
    expect(
      validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: '/abs/path' } }),
    ).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: { cwd: '/abs/path' },
    });
    expect(validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: fn } })).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: { cwd: fn },
    });
  });

  it('rejects malformed clearOnEntry metadata', () => {
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: false })).toThrow(
      /clearOnEntry/,
    );
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: {} })).toThrow(
      /clearOnEntry\.cwd/,
    );
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: undefined } }),
    ).toThrow(/clearOnEntry\.cwd/);
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: undefined })).toThrow(
      /clearOnEntry/,
    );
  });
});
