import { Ajv, type ErrorObject } from 'ajv';
import type { JSONSchema7 } from 'json-schema';

import { camelToKebab } from '../loader/inputFlags.js';
import type { ArgFlagMeta } from '../loader/inputSchema.js';

export interface NormalizeProgrammaticRunInputOptions {
  readonly targetLabel: string;
  readonly input?: unknown;
  readonly inputSchema?: JSONSchema7;
  readonly inputFlags?: Record<string, ArgFlagMeta>;
}

export type NormalizeProgrammaticRunInputResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly message: string;
      readonly errors: ReadonlyArray<string>;
    };

export function normalizeProgrammaticRunInput(
  opts: NormalizeProgrammaticRunInputOptions,
): NormalizeProgrammaticRunInputResult {
  const input = opts.input === undefined ? {} : opts.input;
  const objectInput = runtimeInputRecord(input);
  if (!objectInput.ok) {
    return invalidInput(opts.targetLabel, [objectInput.error]);
  }
  const undefinedValues = undefinedInputValues(objectInput.input);
  if (undefinedValues.length > 0) {
    return invalidInput(
      opts.targetLabel,
      undefinedValues.map((field) => `${formatInputFieldName(field)}: input value is undefined`),
    );
  }

  if (!opts.inputSchema) {
    const unexpected = Object.keys(objectInput.input);
    if (unexpected.length === 0) {
      return { ok: true, input: {} };
    }
    return invalidInput(opts.targetLabel, [
      `FSM declares no input fields; unexpected input fields: ${unexpected
        .map(formatInputFieldName)
        .join(', ')}`,
    ]);
  }

  const normalized = applyRunInputDefaults(objectInput.input, opts.inputFlags ?? {});
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(opts.inputSchema as object);
  if (!validate(normalized)) {
    return invalidInput(
      opts.targetLabel,
      (validate.errors ?? []).map((error) => formatAjvInputError(error)),
    );
  }

  return { ok: true, input: normalized };
}

export function applyRunInputDefaults(
  input: Readonly<Record<string, unknown>>,
  flags: Record<string, ArgFlagMeta>,
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...input };
  for (const [field, meta] of Object.entries(flags)) {
    if (!Object.prototype.hasOwnProperty.call(values, field) && meta.default !== undefined) {
      values[field] = meta.default;
    }
  }
  return values;
}

export function createActorRunInput(
  runId: string,
  runDir: unknown,
  input?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { runId, runDir, ...input };
}

function runtimeInputRecord(
  input: unknown,
):
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly error: string } {
  if (input === null) {
    return { ok: false, error: 'input must be an object; got null' };
  }
  if (Array.isArray(input)) {
    return { ok: false, error: 'input must be an object; got array' };
  }
  if (typeof input !== 'object') {
    return { ok: false, error: `input must be an object; got ${typeof input}` };
  }
  return { ok: true, input: { ...(input as Record<string, unknown>) } };
}

function undefinedInputValues(input: Record<string, unknown>): string[] {
  const fields: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (value === undefined) {
      fields.push(path);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      visit(nested, path.length > 0 ? `${path}.${key}` : key);
    }
  };
  for (const [field, value] of Object.entries(input)) {
    visit(value, field);
  }
  return fields;
}

function invalidInput(
  targetLabel: string,
  errors: ReadonlyArray<string>,
): NormalizeProgrammaticRunInputResult {
  return {
    ok: false,
    message: [`invalid input for ${targetLabel}:`, ...errors.map((error) => `  ${error}`)].join(
      '\n',
    ),
    errors,
  };
}

function formatAjvInputError(error: ErrorObject): string {
  if (error.keyword === 'required') {
    const missing = unknownParam(error.params, 'missingProperty');
    if (typeof missing === 'string' && missing.length > 0) {
      return `${formatInputFieldName(missing)}: required input is missing`;
    }
  }
  if (error.keyword === 'additionalProperties') {
    const additional = unknownParam(error.params, 'additionalProperty');
    if (typeof additional === 'string' && additional.length > 0) {
      return `${formatInputFieldName(additional)}: unknown input field`;
    }
  }

  const path = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
  const field = path.length > 0 ? formatInputFieldName(path) : '<input>';
  return `${field}: ${error.message ?? 'invalid'}`;
}

function unknownParam(params: ErrorObject['params'], key: string): unknown {
  return (params as Record<string, unknown>)[key];
}

function formatInputFieldName(field: string): string {
  return `--${camelToKebab(field)}`;
}
