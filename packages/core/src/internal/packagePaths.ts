import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface PackagePathDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly path?: string;
}

export type PackagePathResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly PackagePathDiagnostic[];
    };

export interface PackagePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface ValidatePackagePathOptions {
  readonly packageRoot: string;
  readonly relativePath: string;
  readonly field: string;
}

export type ValidatePackageWriteTargetOptions = ValidatePackagePathOptions;

export function validatePackagePath(
  opts: ValidatePackagePathOptions,
): PackagePathResult<PackagePath> {
  const diagnostics = validateRelativePathSyntax(opts.relativePath, opts.field);
  const normalizedRelativePath = normalizePackageRelativePath(opts.relativePath);
  const packageRoot = path.resolve(opts.packageRoot);
  const absolutePath = path.resolve(packageRoot, normalizedRelativePath);

  if (!isPathInsideOrEqual(packageRoot, absolutePath)) {
    diagnostics.push({
      code: 'path-outside-package-root',
      field: opts.field,
      path: opts.relativePath,
      message: `${opts.field} must resolve inside the package root`,
    });
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      absolutePath,
      relativePath: normalizedRelativePath,
    },
  };
}

export async function validatePackageWriteTarget(
  opts: ValidatePackageWriteTargetOptions,
): Promise<PackagePathResult<PackagePath>> {
  const pathResult = validatePackagePath(opts);
  if (!pathResult.ok) return pathResult;

  const packageRoot = path.resolve(opts.packageRoot);
  let realPackageRoot: string;
  try {
    realPackageRoot = await fs.realpath(packageRoot);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-root-realpath-failed',
          field: opts.field,
          path: packageRoot,
          message: `could not resolve package root realpath: ${errorMessage(err)}`,
        },
      ],
    };
  }

  const parentDir = path.dirname(pathResult.value.absolutePath);
  const existingParentResult = await findExistingAncestor(parentDir, packageRoot);
  if (!existingParentResult.ok) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'path-parent-stat-failed',
          field: opts.field,
          path: existingParentResult.path,
          message: `could not inspect write target parent: ${existingParentResult.message}`,
        },
      ],
    };
  }

  const existingParent = existingParentResult.value;

  if (!existingParent.isDirectory) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'path-parent-not-directory',
          field: opts.field,
          path: existingParent.path,
          message: `existing parent for ${opts.field} is not a directory`,
        },
      ],
    };
  }

  let realParent: string;
  try {
    realParent = await fs.realpath(existingParent.path);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'path-parent-realpath-failed',
          field: opts.field,
          path: existingParent.path,
          message: `could not resolve write target parent realpath: ${errorMessage(err)}`,
        },
      ],
    };
  }

  if (!isPathInsideOrEqual(realPackageRoot, realParent)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'path-parent-realpath-escapes',
          field: opts.field,
          path: existingParent.path,
          message: `${opts.field} parent resolves outside the package root`,
        },
      ],
    };
  }

  return pathResult;
}

export function normalizePackageRelativePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/\\/g, '/'));
}

export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateRelativePathSyntax(relativePath: string, field: string): PackagePathDiagnostic[] {
  const diagnostics: PackagePathDiagnostic[] = [];
  if (relativePath.length === 0) {
    diagnostics.push({
      code: 'path-empty',
      field,
      path: relativePath,
      message: `${field} must not be empty`,
    });
    return diagnostics;
  }

  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    diagnostics.push({
      code: 'path-absolute',
      field,
      path: relativePath,
      message: `${field} must be a package-relative path`,
    });
  }

  const segments = relativePath.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '') {
      diagnostics.push({
        code: 'path-empty-segment',
        field,
        path: relativePath,
        message: `${field} must not contain empty path segments`,
      });
      break;
    }
  }

  if (segments.includes('..')) {
    diagnostics.push({
      code: 'path-parent-segment',
      field,
      path: relativePath,
      message: `${field} must not contain '..' path segments`,
    });
  }

  return diagnostics;
}

async function findExistingAncestor(
  startPath: string,
  packageRoot: string,
): Promise<
  | { ok: true; value: { path: string; isDirectory: boolean } }
  | { ok: false; path: string; message: string }
> {
  const root = path.resolve(packageRoot);
  let current = path.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(current);
      return { ok: true, value: { path: current, isDirectory: stat.isDirectory() } };
    } catch (err) {
      if (!isNotFoundError(err)) {
        return { ok: false, path: current, message: errorMessage(err) };
      }
    }

    if (current === root) return { ok: true, value: { path: root, isDirectory: true } };

    const parent = path.dirname(current);
    current = parent;
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
