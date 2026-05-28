import { describe, expect, it } from 'vitest';
import { arg, isArgSentinel } from '../src/state/args.js';
import { createFsm } from '../src/index.js';

describe('arg()', () => {
  it('returns an opaque sentinel with the marker brand', () => {
    const a = arg<string>();
    expect(isArgSentinel(a)).toBe(true);
    expect((a as { __harnessArgMarker?: boolean }).__harnessArgMarker).toBe(true);
  });

  it('carries meta on the sentinel when supplied', () => {
    const a = arg<string>({ description: 'a path', completion: 'file' });
    expect(a.meta).toEqual({ description: 'a path', completion: 'file' });
  });

  it('exposes an empty meta object when no meta is supplied', () => {
    const a = arg<string>();
    expect(a.meta).toEqual({});
  });

  it('preserves a default value', () => {
    const a = arg<number>({ default: 42 });
    expect(a.meta.default).toBe(42);
  });

  it('isArgSentinel returns false for non-sentinels', () => {
    expect(isArgSentinel(undefined)).toBe(false);
    expect(isArgSentinel({})).toBe(false);
    expect(isArgSentinel({ __harnessArgMarker: false })).toBe(false);
  });
});

describe('createFsm().input helpers', () => {
  it('return existing arg sentinels with string, number, path, custom, and values metadata', () => {
    const fsm = createFsm<{ topic: string }>();
    const dynamic = () => ['alpha'];

    const inputs = {
      topic: fsm.input.string({
        description: 'topic',
        default: 'auth',
        complete: fsm.input.values(['auth', 'billing']),
      }),
      rounds: fsm.input.number({ default: 3 }),
      specPath: fsm.input.path({ description: 'spec', complete: 'file' }),
      mode: fsm.input.custom<'draft' | 'final'>({ complete: dynamic }),
      owner: fsm.input.string({ complete: fsm.input.values(['alice', 'bob']) }),
    };

    expect(isArgSentinel(inputs.topic)).toBe(true);
    expect(inputs.topic.meta).toEqual({
      description: 'topic',
      default: 'auth',
      completion: { values: ['auth', 'billing'] },
    });
    expect(inputs.rounds.meta.default).toBe(3);
    expect(inputs.specPath.meta.completion).toBe('file');
    expect(inputs.mode.meta.completion).toEqual({ dynamic });
    expect(inputs.owner.meta.completion).toEqual({ values: ['alice', 'bob'] });
  });
});
