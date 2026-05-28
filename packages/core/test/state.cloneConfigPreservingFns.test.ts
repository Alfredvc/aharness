import { describe, expect, it } from 'vitest';
import { cloneConfigPreservingFns } from '../src/state/cloneConfigPreservingFns.js';

describe('cloneConfigPreservingFns', () => {
  it('deep-copies plain objects and arrays', () => {
    const input = { a: 1, b: { c: 2, d: [3, 4] } };
    const out = cloneConfigPreservingFns(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect((out as { b: unknown }).b).not.toBe(input.b);
    expect((out as { b: { d: unknown } }).b.d).not.toBe(input.b.d);
  });

  it('preserves function references (does not invoke or strip)', () => {
    const fn = () => 42;
    const input = { handler: fn, nested: { cb: fn } };
    const out = cloneConfigPreservingFns(input) as { handler: unknown; nested: { cb: unknown } };
    expect(out.handler).toBe(fn);
    expect(out.nested.cb).toBe(fn);
  });

  it('preserves primitive types (string, number, boolean, null, undefined)', () => {
    const input = { s: 'x', n: 1, b: true, z: null, u: undefined };
    const out = cloneConfigPreservingFns(input);
    expect(out).toEqual(input);
  });

  it('preserves cyclic references (cyclic input → cyclic output)', () => {
    // Contract: the cloner uses a WeakMap to detect repeated visits to the
    // same object and returns the in-progress clone reference. So cyclic input
    // produces a structurally cyclic clone, not an infinite walk.
    const input: { self?: unknown } = {};
    input.self = input;
    const out = cloneConfigPreservingFns(input) as { self: unknown };
    expect(out).not.toBe(input); // a fresh top-level
    expect(out.self).toBe(out); // pointing at itself, not at input
  });

  it('does not mutate the input', () => {
    const input = { a: { b: 1 } };
    cloneConfigPreservingFns(input);
    expect(input).toEqual({ a: { b: 1 } });
  });

  it('throws clearly on unsupported exotic objects (Map, Set, Date, RegExp, class instances)', () => {
    // The walker only understands plain objects, arrays, primitives, and
    // function references. MachineConfig is our shape — we control it — so
    // exotic-object input is a programmer error worth surfacing loudly.
    expect(() => cloneConfigPreservingFns({ d: new Date() })).toThrow(/unsupported/);
    expect(() => cloneConfigPreservingFns({ m: new Map() })).toThrow(/unsupported/);
    expect(() => cloneConfigPreservingFns({ s: new Set() })).toThrow(/unsupported/);
    expect(() => cloneConfigPreservingFns({ r: /a/ })).toThrow(/unsupported/);
    class C {
      x = 1;
    }
    expect(() => cloneConfigPreservingFns({ c: new C() })).toThrow(/unsupported/);
  });
});
