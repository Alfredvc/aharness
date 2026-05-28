/**
 * Structural deep-clone of a `MachineConfig`-shaped value that preserves
 * function references (callbacks, action factories). Used by:
 *   1. `aharness.machine()` to snapshot the input config before the in-place
 *      synthesis pass mutates it; the snapshot is stashed on the compiled
 *      machine as a non-enumerable `__aharnessRawConfig` property.
 *   2. `embed()` to clone the resolved child config before lifting `states`
 *      into a compound — without the per-call clone, a second `embed()` of
 *      the same compiled child would read post-mutation nodes and clobber
 *      the first embed's qualified-id SUBMIT keys.
 *
 * Why not `structuredClone`: it strips functions. Why not lodash `cloneDeep`:
 * adds a runtime dep for what is a small bounded walk.
 *
 * Supported value shapes:
 *   - primitives (string, number, boolean, null, undefined, bigint, symbol)
 *   - functions (returned as-is, NOT invoked or wrapped)
 *   - plain objects (`{}` / `Object.create(null)`)
 *   - arrays
 *   - cyclic graphs of the above (produces a cyclic clone via WeakMap)
 *
 * Unsupported (throws): Map, Set, Date, RegExp, class instances, typed arrays.
 * `MachineConfig` is our shape — we control it — so any of those is a
 * programmer error worth surfacing loudly rather than silently stripping.
 *
 * NB: the caller (`aharness.machine`) shallow-freezes only the top-level
 * snapshot via `Object.freeze`. Inner objects (`states.go.on`, etc.) remain
 * writable so `injectFrameworkActions` can mutate them via the `embed()` clone.
 */
export function cloneConfigPreservingFns<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  function isPlainObject(o: object): boolean {
    const proto = Object.getPrototypeOf(o) as object | null;
    return proto === Object.prototype || proto === null;
  }
  function walk(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t !== 'object' && t !== 'function') return v;
    if (t === 'function') return v;
    const obj = v;
    const cached = seen.get(obj);
    if (cached !== undefined) return cached;
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      seen.set(obj, out);
      for (const item of obj) out.push(walk(item));
      return out;
    }
    if (!isPlainObject(obj)) {
      const ctor = (obj.constructor as { name?: string } | undefined)?.name ?? 'unknown';
      throw new TypeError(
        `cloneConfigPreservingFns: unsupported value type \`${ctor}\` — only plain objects, arrays, primitives, and function references are supported. MachineConfig must be POJO-shaped.`,
      );
    }
    const out: Record<string, unknown> = {};
    seen.set(obj, out);
    for (const key of Object.keys(obj)) {
      out[key] = walk((obj as Record<string, unknown>)[key]);
    }
    return out;
  }
  return walk(value) as T;
}
