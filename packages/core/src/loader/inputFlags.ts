/**
 * Tiny argv parser for FSM `input` flags. Hand-rolled in the style of
 * `cli/main.ts:90-112` — no external dep.
 *
 *   - Recognised tokens: `--<kebab-name> <value>` and bare `--<kebab-name>`
 *     (boolean true).
 *   - Field name conversion: kebab-case → camelCase to match the loader-
 *     extracted field names.
 *   - Coercion: number → Number(), boolean → bare-flag-implies-true,
 *     other types pass through unchanged. Hand-rolled because AJV's
 *     `coerceTypes` is brittle across versions and silently mutates input
 *     shape.
 *   - Validation: per-field via the loader-extracted JSON Schema (Ajv).
 *     AJV is used for VALIDATION ONLY, not coercion.
 *   - Defaults: `flags[field].default` populates omitted optional fields.
 *
 * Limitations (MVP):
 *   - Values may not start with `--` (the parser would mis-parse them as
 *     the next flag). Authors who need such values use shell quoting and
 *     a non-collision-prone flag name.
 *   - No POSIX `--` separator. Out of scope; deferred.
 */
import { Ajv } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import type { ArgFlagMeta } from './inputSchema.js';

export interface ParseInputFlagsOptions {
  readonly args: ReadonlyArray<string>;
  readonly schema: JSONSchema7;
  readonly flags: Record<string, ArgFlagMeta>;
}

export type ParseInputFlagsResult =
  | { readonly ok: true; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

export function parseInputFlags(opts: ParseInputFlagsOptions): ParseInputFlagsResult {
  const { args, schema, flags } = opts;
  const fieldsByKebab: Record<string, string> = {};
  const propTypes: Record<string, string | undefined> = {};
  const required = new Set(schema.required ?? []);
  const propEntries = Object.entries(schema.properties ?? {}) as Array<[string, JSONSchema7]>;
  for (const [field, fieldSchema] of propEntries) {
    fieldsByKebab[camelToKebab(field)] = field;
    propTypes[field] = typeof fieldSchema.type === 'string' ? fieldSchema.type : undefined;
  }
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok || !tok.startsWith('--')) {
      errors.push(`unexpected positional token: ${String(tok)}`);
      continue;
    }
    const kebab = tok.slice(2);
    const field = fieldsByKebab[kebab];
    if (!field) {
      errors.push(`unknown flag --${kebab}`);
      continue;
    }
    const ty = propTypes[field];
    if (ty === 'boolean') {
      const next = args[i + 1];
      if (next === 'true' || next === 'false') {
        values[field] = next === 'true';
        i++;
      } else {
        values[field] = true;
      }
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(`flag --${kebab} requires a value`);
      continue;
    }
    if (ty === 'number' || ty === 'integer') {
      const n = Number(next);
      if (!Number.isFinite(n)) {
        errors.push(`flag --${kebab} expects a number; got '${next}'`);
        i++;
        continue;
      }
      values[field] = n;
    } else {
      values[field] = next;
    }
    i++;
  }

  for (const [field, meta] of Object.entries(flags)) {
    if (!(field in values) && meta.default !== undefined) {
      values[field] = meta.default;
    }
  }
  for (const field of required) {
    if (!(field in values)) {
      errors.push(`missing required flag --${camelToKebab(field)}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  if (!validate(values)) {
    const out: string[] = (validate.errors ?? []).map((e) => {
      const field = (e.instancePath || '/').replace(/^\//, '');
      const flag = field.length > 0 ? `--${camelToKebab(field)}` : '<root>';
      return `${flag}: ${e.message ?? 'invalid'}`;
    });
    return { ok: false, errors: out };
  }
  return { ok: true, values };
}

/**
 * Canonical camelCase → kebab-case for FSM input field names. Single
 * uppercase boundaries flip cleanly (`ideafilePath` ↔ `ideafile-path`);
 * uppercase-acronym runs (`httpURL`) decay to per-letter kebabs
 * (`http-u-r-l`). If a project ever hits the acronym case, add a verifier
 * check `input-field-no-acronym-runs` rather than complicating the
 * conversion — Phase 4's bridge relies on round-trip identity here.
 */
export function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * Inverse of `camelToKebab` — used by the completion bridge to map a
 * `--<kebab-name>` flag back to its declared field name. Round-trips
 * with `camelToKebab` for the canonical single-uppercase-boundary case.
 */
export function kebabToCamel(s: string): string {
  return s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}
