import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { normalizePackageRelativePath, validatePackagePath } from './paths.js';
import type {
  CommandMetadata,
  FsmPackageConfig,
  FsmPackageDiagnostic,
  FsmPackageResult,
  PackageJsonFile,
  PackageJsonObject,
} from './types.js';

const OFFICIAL_SCOPE = '@aharness/';
const CORE_DEPENDENCY = '@aharness/core';
const BIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export async function readPackageJson(
  packageRoot: string,
): Promise<FsmPackageResult<PackageJsonFile>> {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let body: string;
  try {
    body = await fs.readFile(packageJsonPath, 'utf8');
  } catch (err) {
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

  return { ok: true, value: { path: packageJsonPath, packageJson: parsed.value } };
}

export function parsePackageJsonBody(opts: {
  readonly packageJsonPath: string;
  readonly body: string;
}): FsmPackageResult<PackageJsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.body);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-json-invalid',
          path: opts.packageJsonPath,
          message: `package.json is not valid JSON: ${errorMessage(err)}`,
        },
      ],
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-json-invalid',
          path: opts.packageJsonPath,
          message: 'package.json must contain an object',
        },
      ],
    };
  }

  return { ok: true, value: parsed };
}

export async function writePackageJson(
  packageRoot: string,
  packageJson: PackageJsonObject,
): Promise<FsmPackageResult<PackageJsonFile>> {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  try {
    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-json-write-failed',
          path: packageJsonPath,
          message: `could not write package.json: ${errorMessage(err)}`,
        },
      ],
    };
  }
  return { ok: true, value: { path: packageJsonPath, packageJson } };
}

export function deriveDefaultBinName(packageName: string): string {
  if (packageName.startsWith(OFFICIAL_SCOPE)) {
    return `ah-${packageName.slice(OFFICIAL_SCOPE.length)}`;
  }
  if (packageName.startsWith('@')) {
    const slashIndex = packageName.indexOf('/');
    if (slashIndex >= 0 && slashIndex < packageName.length - 1) {
      return packageName.slice(slashIndex + 1);
    }
  }
  return packageName;
}

export interface ValidatePackageConfigOptions {
  readonly packageRoot: string;
  readonly packageJson: PackageJsonObject;
}

export function validatePackageConfig(
  opts: ValidatePackageConfigOptions,
): FsmPackageResult<FsmPackageConfig> {
  const packageRoot = path.resolve(opts.packageRoot);
  const diagnostics: FsmPackageDiagnostic[] = [];
  const pkg = opts.packageJson;

  const packageName = stringField(pkg, 'name');
  if (!packageName) {
    diagnostics.push({
      code: 'package-name-invalid',
      field: 'name',
      message: 'package.json name must be a non-empty string',
    });
  }

  const aharnessPackage = readAharnessPackage(pkg, diagnostics);
  const parsedCommands = aharnessPackage ? parseCommandMetadata(aharnessPackage, diagnostics) : {};

  const binName = aharnessPackage ? stringField(aharnessPackage, 'bin') : null;
  if (aharnessPackage && !binName) {
    diagnostics.push({
      code: 'bin-invalid',
      field: 'aharness.package.bin',
      message: 'aharness.package.bin must be a non-empty string',
    });
  } else if (binName && !BIN_NAME_RE.test(binName)) {
    diagnostics.push({
      code: 'bin-invalid',
      field: 'aharness.package.bin',
      message: 'aharness.package.bin must be a valid command name',
    });
  }

  const fsmsDir = aharnessPackage ? stringField(aharnessPackage, 'fsmsDir') : null;
  let fsmsDirPath: string | null = null;
  let fsmsDirRelative: string | null = null;
  if (aharnessPackage && !fsmsDir) {
    diagnostics.push({
      code: 'fsms-dir-invalid',
      field: 'aharness.package.fsmsDir',
      message: 'aharness.package.fsmsDir must be a non-empty string',
    });
  } else if (fsmsDir) {
    const fsmsDirResult = validatePackagePath({
      packageRoot,
      relativePath: fsmsDir,
      field: 'aharness.package.fsmsDir',
    });
    if (fsmsDirResult.ok) {
      fsmsDirPath = fsmsDirResult.value.absolutePath;
      fsmsDirRelative = fsmsDirResult.value.relativePath;
    } else {
      diagnostics.push(...fsmsDirResult.diagnostics);
    }
  }

  if (packageName && binName && packageName.startsWith(OFFICIAL_SCOPE)) {
    const expected = deriveDefaultBinName(packageName);
    if (binName !== expected) {
      diagnostics.push({
        code: 'official-bin-invalid',
        field: 'aharness.package.bin',
        message: `official aharness packages must use bin '${expected}'`,
      });
    }
  }

  const binInfo = validateBin(pkg, binName, packageRoot, diagnostics);
  validateFiles(pkg, fsmsDirRelative, binInfo?.relativePath ?? null, diagnostics);
  validateCoreDependency(pkg, diagnostics);

  if (
    diagnostics.length > 0 ||
    !packageName ||
    !binName ||
    !fsmsDir ||
    !fsmsDirPath ||
    !fsmsDirRelative ||
    !binInfo
  ) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      packageRoot,
      packageJson: pkg,
      packageName,
      binName,
      binPath: binInfo.absolutePath,
      binRelativePath: binInfo.relativePath,
      fsmsDir: fsmsDirRelative,
      fsmsDirPath,
      commandMetadata: parsedCommands,
    },
  };
}

function readAharnessPackage(
  pkg: PackageJsonObject,
  diagnostics: FsmPackageDiagnostic[],
): Record<string, unknown> | null {
  const aharness = pkg['aharness'];
  if (!isRecord(aharness)) {
    diagnostics.push({
      code: 'aharness-package-missing',
      field: 'aharness.package',
      message: 'package.json must contain aharness.package metadata',
    });
    return null;
  }

  const aharnessPackage = aharness['package'];
  if (!isRecord(aharnessPackage)) {
    diagnostics.push({
      code: 'aharness-package-missing',
      field: 'aharness.package',
      message: 'package.json must contain aharness.package metadata',
    });
    return null;
  }

  return aharnessPackage;
}

function parseCommandMetadata(
  aharnessPackage: Record<string, unknown>,
  diagnostics: FsmPackageDiagnostic[],
): Record<string, CommandMetadata> {
  const rawCommands = aharnessPackage['commands'];
  if (rawCommands === undefined) return {};
  if (!isRecord(rawCommands)) {
    diagnostics.push({
      code: 'commands-invalid',
      field: 'aharness.package.commands',
      message: 'aharness.package.commands must be an object when present',
    });
    return {};
  }

  const commands: Record<string, CommandMetadata> = {};
  for (const [name, raw] of Object.entries(rawCommands)) {
    if (!isRecord(raw)) {
      diagnostics.push({
        code: 'command-metadata-invalid',
        field: `aharness.package.commands.${name}`,
        commandName: name,
        message: 'command metadata entries must be objects',
      });
      continue;
    }

    const metadata: { target?: string; description?: string } = {};
    const target = raw['target'];
    if (target !== undefined) {
      if (typeof target !== 'string' || target.length === 0) {
        diagnostics.push({
          code: 'command-target-invalid',
          field: `aharness.package.commands.${name}.target`,
          commandName: name,
          message: 'command metadata target must be a non-empty string',
        });
      } else {
        metadata.target = target;
      }
    }

    const description = raw['description'];
    if (description !== undefined) {
      if (typeof description !== 'string') {
        diagnostics.push({
          code: 'command-description-invalid',
          field: `aharness.package.commands.${name}.description`,
          commandName: name,
          message: 'command metadata description must be a string',
        });
      } else {
        metadata.description = description;
      }
    }

    commands[name] = metadata;
  }

  return commands;
}

function validateBin(
  pkg: PackageJsonObject,
  binName: string | null,
  packageRoot: string,
  diagnostics: FsmPackageDiagnostic[],
): { absolutePath: string; relativePath: string } | null {
  const bin = pkg['bin'];
  if (!isRecord(bin)) {
    diagnostics.push({
      code: 'bin-invalid',
      field: 'bin',
      message: 'package.json bin must be an object with exactly one entry',
    });
    return null;
  }

  const entries = Object.entries(bin);
  if (entries.length !== 1) {
    diagnostics.push({
      code: 'bin-entry-count-invalid',
      field: 'bin',
      message: 'package.json bin must describe exactly one generated binary',
    });
    return null;
  }

  const [entryName, entryTarget] = entries[0] as [string, unknown];
  if (binName && entryName !== binName) {
    diagnostics.push({
      code: 'bin-entry-name-mismatch',
      field: 'bin',
      message: `package.json bin entry must be named '${binName}'`,
    });
  }

  if (typeof entryTarget !== 'string' || entryTarget.length === 0) {
    diagnostics.push({
      code: 'bin-entry-target-invalid',
      field: `bin.${entryName}`,
      message: 'package.json bin target must be a non-empty string',
    });
    return null;
  }

  const target = stripDotSlash(entryTarget);
  const pathResult = validatePackagePath({
    packageRoot,
    relativePath: target,
    field: `bin.${entryName}`,
  });
  if (!pathResult.ok) {
    diagnostics.push(...pathResult.diagnostics);
    return null;
  }
  if (!pathResult.value.relativePath.endsWith('.mjs')) {
    diagnostics.push({
      code: 'bin-entry-target-extension-invalid',
      field: `bin.${entryName}`,
      path: pathResult.value.relativePath,
      message: 'generated package bin target must end with .mjs',
    });
    return null;
  }

  return {
    absolutePath: pathResult.value.absolutePath,
    relativePath: pathResult.value.relativePath,
  };
}

function validateFiles(
  pkg: PackageJsonObject,
  fsmsDir: string | null,
  binTarget: string | null,
  diagnostics: FsmPackageDiagnostic[],
): void {
  const files = pkg['files'];
  if (!Array.isArray(files)) {
    diagnostics.push({
      code: 'files-invalid',
      field: 'files',
      message: 'package.json files must be an array',
    });
    return;
  }

  const normalizedFiles: string[] = [];
  for (const [index, entry] of files.entries()) {
    if (typeof entry !== 'string' || entry.length === 0) {
      diagnostics.push({
        code: 'files-invalid',
        field: `files.${String(index)}`,
        message: 'package.json files entries must be non-empty strings',
      });
      continue;
    }
    const normalized = normalizePackageRelativePath(stripDotSlash(entry));
    const pathResult = validatePackagePath({
      packageRoot: '/',
      relativePath: normalized,
      field: `files.${String(index)}`,
    });
    if (!pathResult.ok) {
      diagnostics.push(...pathResult.diagnostics);
      continue;
    }
    normalizedFiles.push(normalized);
  }

  if (fsmsDir && !filesCoverPath(normalizedFiles, fsmsDir)) {
    diagnostics.push({
      code: 'files-missing-entry',
      field: 'files',
      path: fsmsDir,
      message: `package.json files must include aharness.package.fsmsDir '${fsmsDir}'`,
    });
  }

  if (binTarget) {
    const binParent = normalizePackageRelativePath(path.posix.dirname(binTarget));
    if (
      !filesCoverPath(normalizedFiles, binTarget) &&
      !filesCoverPath(normalizedFiles, binParent)
    ) {
      diagnostics.push({
        code: 'files-missing-entry',
        field: 'files',
        path: binTarget,
        message:
          `package.json files must include generated bin target '${binTarget}' ` +
          `or containing directory '${binParent}'`,
      });
    }
  }
}

function validateCoreDependency(pkg: PackageJsonObject, diagnostics: FsmPackageDiagnostic[]): void {
  const deps = pkg['dependencies'];
  if (
    !isRecord(deps) ||
    typeof deps[CORE_DEPENDENCY] !== 'string' ||
    deps[CORE_DEPENDENCY] === ''
  ) {
    diagnostics.push({
      code: 'dependency-missing',
      field: `dependencies.${CORE_DEPENDENCY}`,
      message: `package.json dependencies must include ${CORE_DEPENDENCY}`,
    });
  }
}

function filesCoverPath(files: readonly string[], targetPath: string): boolean {
  return files.some((entry) => {
    if (entry === '.') return true;
    return targetPath === entry || targetPath.startsWith(`${entry}/`);
  });
}

function stringField(obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
