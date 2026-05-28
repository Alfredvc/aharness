import type { HarnessMeta } from '../types.js';

/**
 * Runtime guard for the `meta.harness` field on a state node. The verifier
 * already runs structural checks via `verify.ts`, but `harness.machine(...)`
 * + `iterStates` may run outside `/harness` (tests, programmatic callers).
 * This helper centralises the shape check so reads through `getHarnessMeta`
 * always see a valid `HarnessMeta`.
 *
 * Returns:
 *   - `undefined` when no meta is attached (the state has no harness opinion);
 *   - the meta when it matches one of the three discriminants;
 *   - throws `Error` when meta is present but malformed (programmer error).
 */
export function validateHarnessMeta(value: unknown): HarnessMeta | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const kind = v['kind'];
  if (kind === 'passive') {
    return value as HarnessMeta;
  }
  if (kind === 'terminal') {
    const outcome = v['outcome'];
    if (outcome !== 'success' && outcome !== 'failure') {
      throw new Error(
        `validateHarnessMeta: terminal meta 'outcome' must be 'success' or 'failure' (got ${JSON.stringify(outcome)})`,
      );
    }
    return value as HarnessMeta;
  }
  if (kind === 'stateful') {
    if (v['exits'] === undefined || v['exits'] === null || typeof v['exits'] !== 'object') {
      throw new Error(`validateHarnessMeta: stateful meta missing 'exits' record`);
    }
    if (
      v['entryPrompt'] === undefined ||
      (typeof v['entryPrompt'] !== 'string' && typeof v['entryPrompt'] !== 'function')
    ) {
      throw new Error(
        `validateHarnessMeta: stateful meta 'entryPrompt' must be string or function`,
      );
    }
    return value as HarnessMeta;
  }
  if (
    kind === undefined &&
    'embedded' in v &&
    typeof v['embedded'] === 'object' &&
    v['embedded'] !== null
  ) {
    // Embedded compound node — `embed()` produces `meta.harness = { embedded: ... }`
    // without a `kind` discriminant. Compound nodes are not stateful leaves;
    // returning undefined here matches the convention used for plain compound
    // states (no harness opinion on this node). New checks that need to read
    // the embedded provenance read it directly from `node.config.meta.harness.embedded`,
    // bypassing this helper.
    return undefined;
  }
  throw new Error(`validateHarnessMeta: unknown kind ${JSON.stringify(kind)}`);
}
