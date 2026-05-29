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
    expect(
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: { model: 'gpt-5.1-codex' },
      }),
    ).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: { model: 'gpt-5.1-codex' },
    });
    expect(
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: { reasoningEffort: 'high' },
      }),
    ).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: { reasoningEffort: 'high' },
    });
    expect(
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: { model: 'gpt-5.1-codex', reasoningEffort: 'high' },
      }),
    ).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: { model: 'gpt-5.1-codex', reasoningEffort: 'high' },
    });
    expect(
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: {
          cwd: '/abs/path',
          model: 'gpt-5.1-codex',
          reasoningEffort: 'minimal',
        },
      }),
    ).toEqual({
      ...baseStatefulMeta,
      clearOnEntry: {
        cwd: '/abs/path',
        model: 'gpt-5.1-codex',
        reasoningEffort: 'minimal',
      },
    });
  });

  it('rejects malformed clearOnEntry metadata', () => {
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: false })).toThrow(
      /clearOnEntry/,
    );
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: {} })).toThrow(
      /cwd, model, reasoningEffort/,
    );
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: undefined } }),
    ).toThrow(/cwd, model, reasoningEffort/);
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { cwd: 5 } })).toThrow(
      /clearOnEntry\.cwd/,
    );
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { model: 5 } })).toThrow(
      /clearOnEntry\.model/,
    );
    expect(() =>
      validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: { reasoningEffort: true } }),
    ).toThrow(/clearOnEntry\.reasoningEffort/);
    expect(() =>
      validateAharnessMeta({
        ...baseStatefulMeta,
        clearOnEntry: { reasoningEffort: 'extreme' },
      }),
    ).toThrow(/none, minimal, low, medium, high, xhigh/);
    expect(() => validateAharnessMeta({ ...baseStatefulMeta, clearOnEntry: undefined })).toThrow(
      /clearOnEntry/,
    );
  });
});
