import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { canonicalJson } from '../internal/canonicalJson.js';
import type { InstallStoreDiagnostic, InstallStoreResult } from './types.js';

export interface ComputeLockFingerprintOptions {
  readonly managedProjectRoot: string;
  readonly dependencyKey: string;
  readonly packageName: string;
  readonly packageVersion?: string;
}

export async function computeLockFingerprint(
  opts: ComputeLockFingerprintOptions,
): Promise<InstallStoreResult<string>> {
  const lockfilePath = path.join(path.resolve(opts.managedProjectRoot), 'package-lock.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
  } catch (err) {
    return failure({
      code: 'lockfile-read-failed',
      path: lockfilePath,
      message: `could not read npm package-lock.json: ${errorMessage(err)}`,
    });
  }

  if (!isRecord(parsed)) {
    return failure({
      code: 'lockfile-invalid',
      path: lockfilePath,
      message: 'npm package-lock.json must contain an object',
    });
  }

  const packages = parsed['packages'];
  if (!isRecord(packages)) {
    return failure({
      code: 'lockfile-packages-missing',
      path: lockfilePath,
      field: 'packages',
      message: 'npm package-lock.json must contain npm v7+ packages entries',
    });
  }

  const directEntryKey = `node_modules/${opts.dependencyKey}`;
  if (!isRecord(packages[directEntryKey])) {
    return failure({
      code: 'lockfile-direct-entry-missing',
      path: lockfilePath,
      field: `packages.${directEntryKey}`,
      message: `npm package-lock.json is missing direct package entry '${directEntryKey}'`,
    });
  }

  const walked = walkReachablePackageEntries({
    packages,
    directEntryKey,
    lockfilePath,
  });
  if (!walked.ok) return walked;

  const hash = createHash('sha256');
  hash.update(
    canonicalJson({
      packageName: opts.packageName,
      ...(opts.packageVersion !== undefined ? { packageVersion: opts.packageVersion } : {}),
      dependencyKey: opts.dependencyKey,
      entries: walked.value,
    }),
  );
  return { ok: true, value: hash.digest('hex') };
}

function walkReachablePackageEntries(opts: {
  readonly packages: Record<string, unknown>;
  readonly directEntryKey: string;
  readonly lockfilePath: string;
}): InstallStoreResult<Record<string, unknown>> {
  const diagnostics: InstallStoreDiagnostic[] = [];
  const seen = new Set<string>();
  const queue = [opts.directEntryKey];
  const out: Record<string, unknown> = {};

  while (queue.length > 0) {
    const entryKey = queue.shift()!;
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);

    const entry = opts.packages[entryKey];
    if (!isRecord(entry)) {
      diagnostics.push({
        code: 'lockfile-entry-invalid',
        path: opts.lockfilePath,
        field: `packages.${entryKey}`,
        message: `npm package-lock entry '${entryKey}' must be an object`,
      });
      continue;
    }
    out[entryKey] = entry;

    const dependencies = entry['dependencies'];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      diagnostics.push({
        code: 'lockfile-entry-dependencies-invalid',
        path: opts.lockfilePath,
        field: `packages.${entryKey}.dependencies`,
        message: `npm package-lock entry '${entryKey}' dependencies must be an object`,
      });
      continue;
    }

    for (const dependencyName of Object.keys(dependencies).sort()) {
      const dependencyEntryKey = resolveDependencyEntryKey(opts.packages, entryKey, dependencyName);
      if (dependencyEntryKey === null) {
        diagnostics.push({
          code: 'lockfile-dependency-entry-missing',
          path: opts.lockfilePath,
          field: `packages.${entryKey}.dependencies.${dependencyName}`,
          message:
            `npm package-lock entry '${entryKey}' depends on '${dependencyName}' ` +
            'but no reachable package entry was found',
        });
        continue;
      }
      queue.push(dependencyEntryKey);
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(out).sort()) {
    sorted[key] = out[key];
  }
  return { ok: true, value: sorted };
}

function resolveDependencyEntryKey(
  packages: Record<string, unknown>,
  entryKey: string,
  dependencyName: string,
): string | null {
  const nested = `${entryKey}/node_modules/${dependencyName}`;
  if (packages[nested] !== undefined) return nested;
  const hoisted = `node_modules/${dependencyName}`;
  if (packages[hoisted] !== undefined) return hoisted;
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
