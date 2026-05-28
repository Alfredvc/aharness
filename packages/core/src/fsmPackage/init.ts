import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { deriveDefaultBinName, parsePackageJsonBody, writePackageJson } from './config.js';
import {
  normalizePackageRelativePath,
  validatePackagePath,
  validatePackageWriteTarget,
} from './paths.js';
import type { FsmPackageDiagnostic, FsmPackageResult, PackageJsonObject } from './types.js';

const CORE_DEPENDENCY = '@aharness/core';
const DEFAULT_FSMS_DIR = 'fsms';
const GENERATED_BIN_DIR = 'bin';
const SKILLS_DIR = 'skills';
const BIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface InitFsmPackageOptions {
  readonly packageRoot: string;
  readonly packageName?: string;
  readonly binName?: string;
  readonly fsmsDir?: string;
  readonly force: boolean;
  readonly harnessCoreVersion: string;
}

export interface InitFsmPackageValue {
  readonly packageJsonPath: string;
}

export async function initFsmPackage(
  opts: InitFsmPackageOptions,
): Promise<FsmPackageResult<InitFsmPackageValue>> {
  const packageRoot = path.resolve(opts.packageRoot);
  const read = await readPackageJsonForInit(packageRoot);
  if (!read.ok) return read;

  const diagnostics: FsmPackageDiagnostic[] = [];
  const packageJson = { ...read.value.packageJson };

  if (!read.value.exists && !opts.packageName) {
    diagnostics.push({
      code: 'package-name-required',
      field: 'name',
      message: '--name is required when package.json is missing',
    });
  }

  diagnostics.push(...validateMergeablePackageJson(packageJson));

  const existingName = stringField(packageJson, 'name');
  const packageName = opts.packageName ?? existingName;
  if (!packageName) {
    diagnostics.push({
      code: 'package-name-invalid',
      field: 'name',
      message: 'package.json name must be a non-empty string or --name must be provided',
    });
  }

  const existingHarnessPackage = readExistingHarnessPackage(packageJson);
  const existingFsmsDir = stringField(existingHarnessPackage ?? {}, 'fsmsDir');
  const fsmsDirInput = opts.fsmsDir ?? existingFsmsDir ?? DEFAULT_FSMS_DIR;
  const fsmsDirResult = validatePackagePath({
    packageRoot,
    relativePath: fsmsDirInput,
    field: 'harness.package.fsmsDir',
  });
  if (!fsmsDirResult.ok) diagnostics.push(...fsmsDirResult.diagnostics);

  const binName = opts.binName ?? (packageName ? deriveDefaultBinName(packageName) : null);
  if (!binName) {
    diagnostics.push({
      code: 'bin-invalid',
      field: 'harness.package.bin',
      message: 'harness.package.bin must be a non-empty string',
    });
  } else if (!BIN_NAME_RE.test(binName)) {
    diagnostics.push({
      code: 'bin-invalid',
      field: 'harness.package.bin',
      message: 'harness.package.bin must be a valid command name',
    });
  }

  const binRelativePath = binName
    ? normalizePackageRelativePath(`${GENERATED_BIN_DIR}/${binName}.mjs`)
    : '';
  if (binName) {
    diagnostics.push(
      ...validateBinMerge({
        packageJson,
        binName,
        binRelativePath,
        force: opts.force,
      }),
    );
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  if (!packageName || !binName || !fsmsDirResult.ok) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-init-internal-invalid',
          message: 'package initialization could not resolve required metadata',
        },
      ],
    };
  }

  const fsmsWriteTarget = await validatePackageWriteTarget({
    packageRoot,
    relativePath: normalizePackageRelativePath(
      path.posix.join(fsmsDirResult.value.relativePath, '.harness-init-dir-check'),
    ),
    field: 'harness.package.fsmsDir',
  });
  if (!fsmsWriteTarget.ok) return fsmsWriteTarget;

  const ensured = await ensureFsmsDir(fsmsDirResult.value.absolutePath);
  if (!ensured.ok) return ensured;

  const updatedPackageJson = buildUpdatedPackageJson({
    packageJson,
    packageName,
    binName,
    binRelativePath,
    fsmsDir: fsmsDirResult.value.relativePath,
    harnessCoreVersion: opts.harnessCoreVersion,
  });

  const written = await writePackageJson(packageRoot, updatedPackageJson);
  if (!written.ok) return written;

  return {
    ok: true,
    value: {
      packageJsonPath: written.value.path,
    },
  };
}

function buildUpdatedPackageJson(opts: {
  readonly packageJson: PackageJsonObject;
  readonly packageName: string;
  readonly binName: string;
  readonly binRelativePath: string;
  readonly fsmsDir: string;
  readonly harnessCoreVersion: string;
}): PackageJsonObject {
  const scripts = readRecord(opts.packageJson['scripts']);
  const dependencies = readRecord(opts.packageJson['dependencies']);
  const harness = readRecord(opts.packageJson['harness']);
  const harnessPackage = readRecord(harness['package']);

  return {
    ...opts.packageJson,
    name: opts.packageName,
    bin: {
      [opts.binName]: `./${opts.binRelativePath}`,
    },
    files: mergeFiles(opts.packageJson['files'], [GENERATED_BIN_DIR, opts.fsmsDir, SKILLS_DIR]),
    scripts: {
      ...scripts,
      prepack: 'aharness package build',
      'package:verify': 'aharness package verify',
    },
    dependencies: {
      ...dependencies,
      [CORE_DEPENDENCY]: opts.harnessCoreVersion,
    },
    harness: {
      ...harness,
      package: {
        ...harnessPackage,
        bin: opts.binName,
        fsmsDir: opts.fsmsDir,
      },
    },
  };
}

function validateMergeablePackageJson(packageJson: PackageJsonObject): FsmPackageDiagnostic[] {
  const diagnostics: FsmPackageDiagnostic[] = [];

  if (packageJson['scripts'] !== undefined && !isRecord(packageJson['scripts'])) {
    diagnostics.push({
      code: 'package-init-conflict',
      field: 'scripts',
      message: 'package.json scripts must be an object to merge package scripts',
    });
  }

  if (packageJson['dependencies'] !== undefined && !isRecord(packageJson['dependencies'])) {
    diagnostics.push({
      code: 'package-init-conflict',
      field: 'dependencies',
      message: 'package.json dependencies must be an object to merge @aharness/core',
    });
  }

  if (packageJson['harness'] !== undefined) {
    if (!isRecord(packageJson['harness'])) {
      diagnostics.push({
        code: 'package-init-conflict',
        field: 'harness',
        message: 'package.json harness must be an object to merge harness.package',
      });
    } else {
      const harnessPackage = packageJson['harness']['package'];
      if (harnessPackage !== undefined && !isRecord(harnessPackage)) {
        diagnostics.push({
          code: 'package-init-conflict',
          field: 'harness.package',
          message: 'package.json harness.package must be an object to merge package metadata',
        });
      }
    }
  }

  if (packageJson['files'] !== undefined) {
    if (!Array.isArray(packageJson['files'])) {
      diagnostics.push({
        code: 'package-init-conflict',
        field: 'files',
        message: 'package.json files must be an array to merge package publish entries',
      });
    } else {
      for (const [index, entry] of packageJson['files'].entries()) {
        if (typeof entry !== 'string' || entry.length === 0) {
          diagnostics.push({
            code: 'package-init-conflict',
            field: `files.${String(index)}`,
            message: 'package.json files entries must be non-empty strings',
          });
        }
      }
    }
  }

  return diagnostics;
}

function validateBinMerge(opts: {
  readonly packageJson: PackageJsonObject;
  readonly binName: string;
  readonly binRelativePath: string;
  readonly force: boolean;
}): FsmPackageDiagnostic[] {
  const bin = opts.packageJson['bin'];
  if (bin === undefined) return [];

  if (!isRecord(bin)) {
    return opts.force
      ? []
      : [
          {
            code: 'package-init-bin-conflict',
            field: 'bin',
            message: 'package.json bin must be an object; use --force to replace it',
          },
        ];
  }

  const entries = Object.entries(bin);
  const existingEntry = entries[0];
  if (
    entries.length === 1 &&
    existingEntry !== undefined &&
    existingEntry[0] === opts.binName &&
    typeof existingEntry[1] === 'string' &&
    normalizeBinTarget(existingEntry[1]) === opts.binRelativePath
  ) {
    return [];
  }

  if (opts.force) return [];

  return [
    {
      code: 'package-init-bin-conflict',
      field: 'bin',
      message: `package.json bin already contains ${describeBinEntries(entries)}; use --force to replace it with '${opts.binName}'`,
    },
  ];
}

function mergeFiles(existing: unknown, requiredEntries: readonly string[]): string[] {
  const files = Array.isArray(existing)
    ? existing.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const merged = [...files];
  const normalizedExisting = files.map((entry) =>
    normalizePackageRelativePath(stripDotSlash(entry)),
  );

  for (const requiredEntry of requiredEntries) {
    const normalizedRequired = normalizePackageRelativePath(stripDotSlash(requiredEntry));
    if (!normalizedExisting.some((entry) => filesCoverPath(entry, normalizedRequired))) {
      merged.push(normalizedRequired);
      normalizedExisting.push(normalizedRequired);
    }
  }

  return merged;
}

async function ensureFsmsDir(fsmsDirPath: string): Promise<FsmPackageResult<null>> {
  try {
    const stat = await fs.lstat(fsmsDirPath);
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'fsms-dir-symlink-rejected',
            field: 'harness.package.fsmsDir',
            path: fsmsDirPath,
            message: 'harness.package.fsmsDir must not be a symlink',
          },
        ],
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'fsms-dir-not-directory',
            field: 'harness.package.fsmsDir',
            path: fsmsDirPath,
            message: 'harness.package.fsmsDir exists but is not a directory',
          },
        ],
      };
    }
    return { ok: true, value: null };
  } catch (err) {
    if (!isNotFoundError(err)) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'fsms-dir-stat-failed',
            field: 'harness.package.fsmsDir',
            path: fsmsDirPath,
            message: `could not inspect harness.package.fsmsDir: ${errorMessage(err)}`,
          },
        ],
      };
    }
  }

  try {
    await fs.mkdir(fsmsDirPath, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'fsms-dir-create-failed',
          field: 'harness.package.fsmsDir',
          path: fsmsDirPath,
          message: `could not create harness.package.fsmsDir: ${errorMessage(err)}`,
        },
      ],
    };
  }

  return { ok: true, value: null };
}

async function readPackageJsonForInit(
  packageRoot: string,
): Promise<
  FsmPackageResult<{ readonly exists: boolean; readonly packageJson: PackageJsonObject }>
> {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let body: string;
  try {
    body = await fs.readFile(packageJsonPath, 'utf8');
  } catch (err) {
    if (isNotFoundError(err)) {
      return { ok: true, value: { exists: false, packageJson: {} } };
    }
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-json-read-failed',
          path: packageJsonPath,
          message: `could not read package.json: ${errorMessage(err)}`,
        },
      ],
    };
  }

  const parsed = parsePackageJsonBody({ packageJsonPath, body });
  if (!parsed.ok) return parsed;

  return { ok: true, value: { exists: true, packageJson: parsed.value } };
}

function readExistingHarnessPackage(
  packageJson: PackageJsonObject,
): Record<string, unknown> | null {
  const harness = packageJson['harness'];
  if (!isRecord(harness)) return null;
  const harnessPackage = harness['package'];
  return isRecord(harnessPackage) ? harnessPackage : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeBinTarget(value: string): string {
  return normalizePackageRelativePath(stripDotSlash(value));
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function filesCoverPath(entry: string, targetPath: string): boolean {
  if (entry === '.') return true;
  return targetPath === entry || targetPath.startsWith(`${entry}/`);
}

function describeBinEntries(entries: readonly (readonly [string, unknown])[]): string {
  if (entries.length === 0) return 'no entries';
  return entries
    .map(([name, target]) => `${name}: ${typeof target === 'string' ? target : typeof target}`)
    .join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
