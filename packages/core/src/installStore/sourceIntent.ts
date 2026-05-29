import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstallStoreDiagnostic, InstallStoreResult } from './types.js';

export interface ResolveLocalDirectorySourceOptions {
  readonly source: string;
  readonly cwd: string;
}

export async function resolveLocalDirectorySource(
  opts: ResolveLocalDirectorySourceOptions,
): Promise<string | null> {
  const candidate = localDirectoryCandidate(opts.source, opts.cwd);
  if (candidate === null) return null;

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  try {
    const packageJsonStat = await fs.stat(path.join(candidate, 'package.json'));
    if (!packageJsonStat.isFile()) return null;
  } catch {
    return null;
  }

  return path.resolve(candidate);
}

export async function computeSourceIntentKey(opts: {
  readonly source: string;
  readonly cwd: string;
}): Promise<InstallStoreResult<string>> {
  const localDirectory = await resolveLocalDirectorySource(opts);
  if (localDirectory !== null) {
    try {
      return { ok: true, value: `local-directory:${await fs.realpath(localDirectory)}` };
    } catch (err) {
      return failure({
        code: 'source-intent-local-realpath-failed',
        path: localDirectory,
        message: `could not resolve local install source realpath: ${errorMessage(err)}`,
      });
    }
  }

  const alias = parseAliasSource(opts.source);
  if (alias) {
    const targetPackage = parseRegistryPackageName(alias.target);
    if (targetPackage) return { ok: true, value: `registry:${targetPackage}` };
  }

  const registryPackage = parseRegistryPackageName(opts.source);
  if (registryPackage) return { ok: true, value: `registry:${registryPackage}` };

  return { ok: true, value: `spec:${opts.source}` };
}

export function identifyDirectDependencyKey(opts: {
  readonly before: Readonly<Record<string, string>>;
  readonly after: Readonly<Record<string, string>>;
  readonly source: string;
}): InstallStoreResult<string> {
  const changed = Object.keys(opts.after)
    .filter((key) => opts.before[key] !== opts.after[key])
    .sort();
  if (changed.length === 1) return { ok: true, value: changed[0]! };
  if (changed.length > 1) {
    return failure({
      code: 'direct-dependency-key-ambiguous',
      field: 'dependencies',
      message:
        `npm changed more than one direct dependency while installing '${opts.source}': ` +
        changed.join(', '),
    });
  }

  const parsed = parseDirectDependencyKeyFromSource(opts.source);
  if (parsed && opts.after[parsed] !== undefined) return { ok: true, value: parsed };

  return failure({
    code: 'direct-dependency-key-not-found',
    field: 'dependencies',
    message: `could not identify the direct dependency key npm saved for '${opts.source}'`,
  });
}

export async function deriveDependencyKeyFromSource(opts: {
  readonly source: string;
  readonly cwd: string;
}): Promise<InstallStoreResult<string>> {
  const parsed = parseDirectDependencyKeyFromSource(opts.source);
  if (parsed) return { ok: true, value: parsed };

  const localDirectory = await resolveLocalDirectorySource(opts);
  if (localDirectory !== null) {
    const packageJsonPath = path.join(localDirectory, 'package.json');
    let parsedPackage: unknown;
    try {
      parsedPackage = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    } catch (err) {
      return failure({
        code: 'direct-dependency-package-json-read-failed',
        path: packageJsonPath,
        message: `could not read local install source package.json: ${errorMessage(err)}`,
      });
    }
    if (isRecord(parsedPackage) && typeof parsedPackage['name'] === 'string') {
      return { ok: true, value: parsedPackage['name'] };
    }
    return failure({
      code: 'direct-dependency-package-name-invalid',
      path: packageJsonPath,
      field: 'name',
      message: 'local install source package.json name must be a string',
    });
  }

  return failure({
    code: 'direct-dependency-key-not-found',
    message: `could not infer a direct dependency key for '${opts.source}'`,
  });
}

function parseDirectDependencyKeyFromSource(source: string): string | null {
  const alias = parseAliasSource(source);
  if (alias) return alias.alias;
  return parseRegistryPackageName(source);
}

function parseAliasSource(
  source: string,
): { readonly alias: string; readonly target: string } | null {
  const marker = '@npm:';
  const markerIndex = source.indexOf(marker);
  if (markerIndex <= 0) return null;
  const alias = source.slice(0, markerIndex);
  const target = source.slice(markerIndex + marker.length);
  if (!alias || !target) return null;
  return { alias, target };
}

function parseRegistryPackageName(source: string): string | null {
  const spec = source.startsWith('npm:') ? source.slice('npm:'.length) : source;
  if (spec.startsWith('@')) {
    const match = /^(@[^/@\s]+\/[^/@\s]+)(?:@.+)?$/.exec(spec);
    return match?.[1] ?? null;
  }

  if (spec.includes('/') || spec.includes(':') || spec.includes('#')) return null;
  const match = /^([^@\s]+)(?:@.+)?$/.exec(spec);
  return match?.[1] ?? null;
}

function localDirectoryCandidate(source: string, cwd: string): string | null {
  if (source.startsWith('file://')) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith('file:')) {
    return path.resolve(cwd, source.slice('file:'.length));
  }
  if (source.startsWith('.') || path.isAbsolute(source)) {
    return path.resolve(cwd, source);
  }
  return null;
}

function failure(diagnostic: InstallStoreDiagnostic): InstallStoreResult<never> {
  return { ok: false, diagnostics: [diagnostic] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
