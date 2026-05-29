import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { InstallStoreDiagnostic, InstallStoreResult } from './types.js';

export interface EnsureManagedProjectOptions {
  readonly managedProjectRoot: string;
}

export async function ensureManagedProject(
  opts: EnsureManagedProjectOptions,
): Promise<InstallStoreResult<{ readonly manifestPath: string }>> {
  const managedProjectRoot = path.resolve(opts.managedProjectRoot);
  const manifestPath = path.join(managedProjectRoot, 'package.json');

  try {
    await fs.mkdir(managedProjectRoot, { recursive: true });
  } catch (err) {
    return failure({
      code: 'managed-project-create-failed',
      path: managedProjectRoot,
      message: `could not create managed npm project directory: ${errorMessage(err)}`,
    });
  }

  try {
    await fs.access(manifestPath);
  } catch (err) {
    if (!isNodeError(err, 'ENOENT')) {
      return failure({
        code: 'managed-project-package-json-read-failed',
        path: manifestPath,
        message: `could not inspect managed npm project package.json: ${errorMessage(err)}`,
      });
    }

    try {
      await fs.writeFile(
        manifestPath,
        JSON.stringify(
          {
            name: 'aharness-managed-fsm-packages',
            private: true,
            type: 'module',
            dependencies: {},
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      return { ok: true, value: { manifestPath } };
    } catch (writeErr) {
      return failure({
        code: 'managed-project-package-json-write-failed',
        path: manifestPath,
        message: `could not create managed npm project package.json: ${errorMessage(writeErr)}`,
      });
    }
  }

  const dependencies = await readManagedProjectDependencies(managedProjectRoot);
  if (!dependencies.ok) return dependencies;
  return { ok: true, value: { manifestPath } };
}

export async function readManagedProjectDependencies(
  managedProjectRoot: string,
): Promise<InstallStoreResult<Record<string, string>>> {
  const manifestPath = path.join(path.resolve(managedProjectRoot), 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    return failure({
      code: 'managed-project-package-json-read-failed',
      path: manifestPath,
      message: `could not read managed npm project package.json: ${errorMessage(err)}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return failure({
      code: 'managed-project-package-json-invalid',
      path: manifestPath,
      message: `managed npm project package.json is not valid JSON: ${errorMessage(err)}`,
    });
  }

  if (!isRecord(parsed)) {
    return failure({
      code: 'managed-project-package-json-invalid',
      path: manifestPath,
      message: 'managed npm project package.json must contain an object',
    });
  }

  const dependencies = parsed['dependencies'];
  if (dependencies === undefined) return { ok: true, value: {} };
  if (!isRecord(dependencies)) {
    return failure({
      code: 'managed-project-dependencies-invalid',
      path: manifestPath,
      field: 'dependencies',
      message: 'managed npm project dependencies must be an object when present',
    });
  }

  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') {
      return failure({
        code: 'managed-project-dependencies-invalid',
        path: manifestPath,
        field: `dependencies.${name}`,
        message: `managed npm project dependency '${name}' must be a string`,
      });
    }
    out[name] = spec;
  }
  return { ok: true, value: out };
}

function failure(diagnostic: InstallStoreDiagnostic): InstallStoreResult<never> {
  return { ok: false, diagnostics: [diagnostic] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string' &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
