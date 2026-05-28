import { describe, expect, it } from 'vitest';
import { camelToKebab, kebabToCamel, parseInputFlags } from '../src/loader/inputFlags.js';

const schema = {
  type: 'object',
  properties: {
    ideafilePath: { type: 'string' },
    topic: { type: 'string' },
    runs: { type: 'number' },
    flag: { type: 'boolean' },
  },
  required: ['ideafilePath', 'topic'],
  additionalProperties: false,
} as const;

const flagMeta = {
  ideafilePath: { description: 'p' },
  topic: { description: 't' },
  runs: { description: 'r', default: 3 },
  flag: { description: 'f', default: false },
};

describe('parseInputFlags', () => {
  it('parses kebab-case flags into camelCase fields', () => {
    const r = parseInputFlags({
      args: ['--ideafile-path', 'docs/i.md', '--topic', 'auth'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.values).toEqual({
        ideafilePath: 'docs/i.md',
        topic: 'auth',
        runs: 3,
        flag: false,
      });
  });

  it('coerces numeric values', () => {
    const r = parseInputFlags({
      args: ['--ideafile-path', 'i.md', '--topic', 'auth', '--runs', '5'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.runs).toBe(5);
  });

  it('treats bare boolean flags as `true`', () => {
    const r = parseInputFlags({
      args: ['--ideafile-path', 'i.md', '--topic', 'auth', '--flag'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.flag).toBe(true);
  });

  it('rejects unknown flags', () => {
    const r = parseInputFlags({
      args: ['--ideafile-path', 'i.md', '--topic', 'auth', '--bogus', 'x'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/unknown flag --bogus/);
  });

  it('rejects missing required flags', () => {
    const r = parseInputFlags({
      args: ['--topic', 'auth'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/missing required flag --ideafile-path/);
  });

  it('rejects schema-invalid values', () => {
    const r = parseInputFlags({
      args: ['--ideafile-path', 'i.md', '--topic', 'auth', '--runs', 'notanumber'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/--runs/);
  });

  it('rejects `--`-prefixed values (parser treats them as the next flag)', () => {
    // The parser's documented limitation: a value that starts with `--` is
    // mis-parsed as the next flag token. Here the user MEANT `--topic` to be
    // the value of `--ideafile-path`, but the parser sees a missing value
    // followed by a (now duplicate) `--topic` flag.
    const r = parseInputFlags({
      args: ['--ideafile-path', '--topic', '--topic', 'auth'],
      schema: schema as never,
      flags: flagMeta,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/flag --ideafile-path requires a value/);
  });
});

describe('camelToKebab / kebabToCamel — round trip', () => {
  it.each([
    ['ideafilePath', '--ideafile-path'],
    ['topic', '--topic'],
    ['runs', '--runs'],
  ])('round-trips %s <-> %s', (camel, kebab) => {
    expect('--' + camelToKebab(camel)).toBe(kebab);
    expect(kebabToCamel(kebab.replace(/^--/, ''))).toBe(camel);
  });
});
