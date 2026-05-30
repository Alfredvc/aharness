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

describe('validateAharnessMeta — stateful metadata', () => {
  const baseStatefulMeta = {
    kind: 'stateful',
    open: false,
    entryPrompt: 'do thing',
    exits: {},
  };

  it('accepts valid clearOnEntry and state-level model metadata', () => {
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
    expect(validateAharnessMeta({ ...baseStatefulMeta, model: { name: 'gpt-5.1-codex' } })).toEqual(
      {
        ...baseStatefulMeta,
        model: { name: 'gpt-5.1-codex' },
      },
    );
    expect(validateAharnessMeta({ ...baseStatefulMeta, model: { effort: 'high' } })).toEqual({
      ...baseStatefulMeta,
      model: { effort: 'high' },
    });
    expect(
      validateAharnessMeta({
        ...baseStatefulMeta,
        model: { name: 'gpt-5.1-codex', effort: 'high' },
      }),
    ).toEqual({
      ...baseStatefulMeta,
      model: { name: 'gpt-5.1-codex', effort: 'high' },
    });
  });

  it('rejects malformed clearOnEntry and state-level model metadata', () => {
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: false })).toThrow(
      /clearOnEntry/,
    );
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: {} })).toThrow(
      /clearOnEntry.*supported key: cwd/,
    );
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: undefined } }),
    ).toThrow(/supported key: cwd/);
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: 5 } })).toThrow(
      /clearOnEntry\.cwd/,
    );
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { model: 'gpt-5.1-codex' } }),
    ).toThrow(/state-level/);
    expect(() =>
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: { model: 'gpt-5.1-codex', reasoningEffort: 'high' },
      }),
    ).toThrow(/state-level/);
    expect(() =>
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: { reasoningEffort: 'high' },
      }),
    ).toThrow(/state-level/);
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, model: {} })).toThrow(
      /at least one supported key: name, effort/,
    );
    const nonStringEffort = { effort: true } as const;
    expect(() =>
      validateAharnessMeta({
        ...baseStatefulMeta,
        model: nonStringEffort as unknown as { effort: string },
      }),
    ).toThrow(/model\.effort/);
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, model: { effort: 'extreme' } }),
    ).toThrow(/model\.effort/);
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, model: { name: 5 } as { name: string } }),
    ).toThrow(/model\.name/);
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, model: { name: '' } as { name: string } }),
    ).toThrow(/model\.name/);
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: undefined })).toThrow(
      /clearOnEntry/,
    );
  });
});
