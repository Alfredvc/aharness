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
  const directEntry = packages[directEntryKey];
  if (!isRecord(directEntry)) {
    return failure({
      code: 'lockfile-direct-entry-missing',
      path: lockfilePath,
      field: `packages.${directEntryKey}`,
      message: `npm package-lock.json is missing direct package entry '${directEntryKey}'`,
    });
  }
  if (directEntry['link'] === true) {
    return failure({
      code: 'lockfile-direct-entry-linked',
      path: lockfilePath,
      field: `packages.${directEntryKey}.link`,
      message:
        `npm package-lock direct entry '${directEntryKey}' is still a link; ` +
        'reinstall the package so aharness verifies a snapshot',
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

    const dependencyNames = dependencyNamesForEntry(
      entry,
      entryKey,
      opts.lockfilePath,
      diagnostics,
    );

    for (const dependencyName of dependencyNames) {
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

function dependencyNamesForEntry(
  entry: Record<string, unknown>,
  entryKey: string,
  lockfilePath: string,
  diagnostics: InstallStoreDiagnostic[],
): readonly string[] {
  const names = new Set<string>();
  for (const fieldName of ['dependencies', 'optionalDependencies'] as const) {
    const dependencies = entry[fieldName];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      diagnostics.push({
        code: 'lockfile-entry-dependencies-invalid',
        path: lockfilePath,
        field: `packages.${entryKey}.${fieldName}`,
        message: `npm package-lock entry '${entryKey}' ${fieldName} must be an object`,
      });
      continue;
    }
    for (const dependencyName of Object.keys(dependencies)) {
      names.add(dependencyName);
    }
  }
  return Array.from(names).sort();
}

function resolveDependencyEntryKey(
  packages: Record<string, unknown>,
  entryKey: string,
  dependencyName: string,
): string | null {
  for (const packageEntryKey of packageEntrySearchOrder(entryKey)) {
    const candidate = `${packageEntryKey}/node_modules/${dependencyName}`;
    if (packages[candidate] !== undefined) return candidate;
  }
  const hoisted = `node_modules/${dependencyName}`;
  if (packages[hoisted] !== undefined) return hoisted;
  return null;
}

function packageEntrySearchOrder(entryKey: string): readonly string[] {
  const parts = entryKey.split('/node_modules/');
  const searchOrder: string[] = [];
  for (let end = parts.length; end >= 1; end -= 1) {
    searchOrder.push(parts.slice(0, end).join('/node_modules/'));
  }
  return searchOrder;
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
