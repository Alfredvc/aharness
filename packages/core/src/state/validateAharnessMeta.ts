import type { AharnessMeta } from '../types.js';

const clearOnEntryReasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function validateClearOnEntry(value: unknown): void {
  if (value === true) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `validateAharnessMeta: stateful meta 'clearOnEntry' must be true or an object with at least one of cwd, model, or reasoningEffort`,
    );
  }
  const clear = value as {
    readonly cwd?: unknown;
    readonly model?: unknown;
    readonly reasoningEffort?: unknown;
  };
  if (clear.cwd === undefined && clear.model === undefined && clear.reasoningEffort === undefined) {
    throw new Error(
      `validateAharnessMeta: stateful meta 'clearOnEntry' object must include at least one supported key: cwd, model, reasoningEffort`,
    );
  }
  if (clear.cwd !== undefined && typeof clear.cwd !== 'string' && typeof clear.cwd !== 'function') {
    throw new Error(
      `validateAharnessMeta: stateful meta 'clearOnEntry.cwd' must be string or function`,
    );
  }
  if (clear.model !== undefined && typeof clear.model !== 'string') {
    throw new Error(`validateAharnessMeta: stateful meta 'clearOnEntry.model' must be string`);
  }
  if (
    clear.reasoningEffort !== undefined &&
    (typeof clear.reasoningEffort !== 'string' ||
      !clearOnEntryReasoningEfforts.has(clear.reasoningEffort))
  ) {
    throw new Error(
      `validateAharnessMeta: stateful meta 'clearOnEntry.reasoningEffort' must be one of: none, minimal, low, medium, high, xhigh`,
    );
  }
}

/**
 * Runtime guard for the `meta.aharness` field on a state node. The verifier
 * already runs structural checks via `verify.ts`, but `aharness.machine(...)`
 * + `iterStates` may run outside `/aharness` (tests, programmatic callers).
 * This helper centralises the shape check so reads through `getAharnessMeta`
 * always see a valid `AharnessMeta`.
 *
 * Returns:
 *   - `undefined` when no meta is attached (the state has no aharness opinion);
 *   - the meta when it matches one of the three discriminants;
 *   - throws `Error` when meta is present but malformed (programmer error).
 */
export function validateAharnessMeta(value: unknown): AharnessMeta | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const kind = v['kind'];
  if (kind === 'passive') {
    return value as AharnessMeta;
  }
  if (kind === 'terminal') {
    const outcome = v['outcome'];
    if (outcome !== 'success' && outcome !== 'failure') {
      throw new Error(
        `validateAharnessMeta: terminal meta 'outcome' must be 'success' or 'failure' (got ${JSON.stringify(outcome)})`,
      );
    }
    return value as AharnessMeta;
  }
  if (kind === 'stateful') {
    if (v['exits'] === undefined || v['exits'] === null || typeof v['exits'] !== 'object') {
      throw new Error(`validateAharnessMeta: stateful meta missing 'exits' record`);
    }
    if (
      v['entryPrompt'] === undefined ||
      (typeof v['entryPrompt'] !== 'string' && typeof v['entryPrompt'] !== 'function')
    ) {
      throw new Error(
        `validateAharnessMeta: stateful meta 'entryPrompt' must be string or function`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(v, 'clearOnEntry')) {
      validateClearOnEntry(v['clearOnEntry']);
    }
    return value as AharnessMeta;
  }
  if (
    kind === undefined &&
    'embedded' in v &&
    typeof v['embedded'] === 'object' &&
    v['embedded'] !== null
  ) {
    // Embedded compound node — `embed()` produces `meta.aharness = { embedded: ... }`
    // without a `kind` discriminant. Compound nodes are not stateful leaves;
    // returning undefined here matches the convention used for plain compound
    // states (no aharness opinion on this node). New checks that need to read
    // the embedded provenance read it directly from `node.config.meta.aharness.embedded`,
    // bypassing this helper.
    return undefined;
  }
  throw new Error(`validateAharnessMeta: unknown kind ${JSON.stringify(kind)}`);
}
