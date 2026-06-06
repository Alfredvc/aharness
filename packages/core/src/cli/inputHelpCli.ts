import { resolve } from 'node:path';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';

import { camelToKebab } from '../loader/inputFlags.js';
import type { ArgFlagMeta } from '../loader/inputSchema.js';
import type { PackageResolutionContext } from '../loader/packageResolution.js';
import { extractSchemaSidecar } from '../loader/sidecar.js';

type ExtractSchemaSidecar = typeof extractSchemaSidecar;

interface FsmInputHelpOptions {
  readonly target: string;
  readonly filePath: string;
  readonly usage: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly packageResolution?: PackageResolutionContext;
}

interface FsmInputHelpTestOptions extends FsmInputHelpOptions {
  readonly extractSchemaSidecarImpl?: ExtractSchemaSidecar;
}

interface LocalFsmInputHelpOptions {
  readonly cwd: string;
  readonly target: string;
  readonly usage: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

interface LocalFsmInputHelpTestOptions extends LocalFsmInputHelpOptions {
  readonly extractSchemaSidecarImpl?: ExtractSchemaSidecar;
}

interface FormatFsmInputHelpOptions {
  readonly usage: string;
  readonly target: string;
  readonly filePath: string;
  readonly inputSchema: JSONSchema7 | undefined;
  readonly inputFlags: Record<string, ArgFlagMeta> | undefined;
}

interface InputFieldHelp {
  readonly flagName: string;
  readonly typeLabel: string;
  readonly marker: string;
  readonly required: boolean;
  readonly defaultValue: unknown;
  readonly hasDefault: boolean;
  readonly description: string | undefined;
}

export function formatFsmInputHelp(opts: FormatFsmInputHelpOptions): string {
  const lines = [`Usage: ${opts.usage}`, `Target: ${opts.target}`, `FSM: ${opts.filePath}`, ''];
  const fields = describeInputFields(opts.inputSchema, opts.inputFlags);

  if (fields.length === 0) {
    lines.push('Inputs: none', '');
    return lines.join('\n');
  }

  renderInputFieldSection(
    lines,
    'Required input flags:',
    fields.filter((field) => field.required),
  );
  renderInputFieldSection(
    lines,
    'Optional input flags:',
    fields.filter((field) => !field.required),
  );
  lines.push('');
  return lines.join('\n');
}

export const formatLocalFsmInputHelp = formatFsmInputHelp;

export async function runFsmInputHelp(opts: FsmInputHelpOptions): Promise<{
  readonly exitCode: number;
}> {
  return runFsmInputHelpForTest(opts);
}

export async function runFsmInputHelpForTest(
  opts: FsmInputHelpTestOptions,
): Promise<{ readonly exitCode: number }> {
  const extractSchemaSidecarImpl = opts.extractSchemaSidecarImpl ?? extractSchemaSidecar;
  try {
    const extraction = await extractSchemaSidecarImpl({
      filePath: opts.filePath,
      ...(opts.packageResolution ? { packageResolution: opts.packageResolution } : {}),
    });
    const text = formatFsmInputHelp({
      usage: opts.usage,
      target: opts.target,
      filePath: opts.filePath,
      inputSchema: extraction.inputSchema,
      inputFlags: extraction.inputFlags,
    });
    opts.stdout.write(text);
    return { exitCode: 0 };
  } catch (err) {
    opts.stderr.write(`aharness: failed to read FSM input metadata: ${errorMessage(err)}\n`);
    return { exitCode: 1 };
  }
}

export async function runLocalFsmInputHelp(opts: LocalFsmInputHelpOptions): Promise<{
  readonly exitCode: number;
}> {
  return runLocalFsmInputHelpForTest(opts);
}

export async function runLocalFsmInputHelpForTest(
  opts: LocalFsmInputHelpTestOptions,
): Promise<{ readonly exitCode: number }> {
  const filePath = resolve(opts.cwd, opts.target);
  return runFsmInputHelpForTest({
    target: opts.target,
    usage: opts.usage,
    stdout: opts.stdout,
    stderr: opts.stderr,
    filePath,
    ...(opts.extractSchemaSidecarImpl
      ? { extractSchemaSidecarImpl: opts.extractSchemaSidecarImpl }
      : {}),
  });
}

function describeInputFields(
  inputSchema: JSONSchema7 | undefined,
  inputFlags: Record<string, ArgFlagMeta> | undefined,
): InputFieldHelp[] {
  if (inputSchema === undefined) return [];
  const properties = inputSchema.properties ?? {};
  const fields = Object.keys(properties);
  if (fields.length === 0) return [];
  if (inputFlags === undefined) {
    throw new Error('missing inputFlags metadata');
  }

  const required = new Set(inputSchema.required ?? []);
  return fields
    .map((field) => {
      const meta = inputFlags[field];
      if (meta === undefined) {
        throw new Error(`missing inputFlags metadata for field ${field}`);
      }
      const typeLabel = schemaTypeLabel(properties[field]);
      return {
        flagName: camelToKebab(field),
        typeLabel,
        marker: flagMarker(typeLabel),
        required: required.has(field),
        defaultValue: meta.default,
        hasDefault: Object.hasOwn(meta, 'default'),
        description: meta.description,
      };
    })
    .sort((a, b) => a.flagName.localeCompare(b.flagName));
}

function renderInputFieldSection(lines: string[], title: string, fields: InputFieldHelp[]): void {
  lines.push(title);
  if (fields.length === 0) {
    lines.push('  none');
    return;
  }

  for (const field of fields) {
    const details = [field.typeLabel];
    if (field.hasDefault) details.push(`default: ${formatDefault(field.defaultValue)}`);
    const marker = field.marker ? ` ${field.marker}` : '';
    const description = field.description ? ` - ${field.description}` : '';
    lines.push(`  --${field.flagName}${marker} (${details.join(', ')})${description}`);
  }
}

function schemaTypeLabel(schema: JSONSchema7Definition | undefined): string {
  if (schema && typeof schema === 'object' && typeof schema.type === 'string') {
    return schema.type;
  }
  return 'value';
}

function flagMarker(typeLabel: string): string {
  if (typeLabel === 'boolean') return '';
  if (typeLabel === 'string' || typeLabel === 'number' || typeLabel === 'integer') {
    return `<${typeLabel}>`;
  }
  return '<value>';
}

function formatDefault(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
