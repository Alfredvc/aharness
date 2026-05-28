/**
 * Canonical JSON encoder shared by `events.ts` (for `digestHookPayload`)
 * and `trace.ts` (for `digestPayload`). Object keys are sorted lexically
 * at every level so digests are independent of object literal order.
 * Arrays preserve their order. Non-finite numbers and `undefined` are
 * omitted (matching `JSON.stringify` semantics).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
    }
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}
