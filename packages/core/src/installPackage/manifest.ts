import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import semver from 'semver';

import {
  isPathInsideOrEqual,
  validatePackagePath,
  type PackagePathDiagnostic,
} from '../internal/packagePaths.js';

import { findDuplicateCommandKeys } from './packageJsonAst.js';
import type {
  InstallPackageCommand,
  InstallPackageDiagnostic,
  InstallPackageManifest,
  InstallPackageResult,
  PackageJsonObject,
} from './types.js';

const CORE_DEPENDENCY = '@aharness/core';
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const FSM_ENTRY_SUFFIX = '.fsm.ts';

export interface ValidateInstallPackageManifestOptions {
  readonly packageRoot: string;
  readonly packageJsonPath: string;
  readonly packageJson: PackageJsonObject;
  readonly packageJsonText?: string;
  readonly currentCoreVersion: string;
}

export interface ReadInstallPackageManifestOptions {
  readonly packageRoot: string;
  readonly currentCoreVersion: string;
}

interface ParsedCommandShape {
  readonly commandName: string;
  readonly entry: string;
  readonly field: string;
  readonly description?: string;
}

export async function readInstallPackageManifest(
  opts: ReadInstallPackageManifestOptions,
): Promise<InstallPackageResult<InstallPackageManifest>> {
  const packageRoot = path.resolve(opts.packageRoot);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let packageJsonText: string;
  try {
    packageJsonText = await fs.readFile(packageJsonPath, 'utf8');
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'package-json-invalid',
          path: packageJsonPath,
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
          path: packageJsonPath,
          message: 'package.json must contain an object',
        },
      ],
    };
  }

  return validateInstallPackageManifest({
    packageRoot,
    packageJsonPath,
    packageJson: parsed,
    packageJsonText,
    currentCoreVersion: opts.currentCoreVersion,
  });
}

export async function validateInstallPackageManifest(
  opts: ValidateInstallPackageManifestOptions,
): Promise<InstallPackageResult<InstallPackageManifest>> {
  const packageRoot = path.resolve(opts.packageRoot);
  const packageJsonPath = path.resolve(opts.packageJsonPath);
  const packageJson = opts.packageJson;
  const diagnostics: InstallPackageDiagnostic[] = [];

  const packageName = readRequiredString(packageJson, 'name', diagnostics, {
    code: 'package-name-invalid',
    message: 'package.json name must be a non-empty string',
  });

  const rawVersion = packageJson['version'];
  const packageVersion = rawVersion === undefined ? undefined : readOptionalString(rawVersion);
  if (rawVersion !== undefined && packageVersion === undefined) {
    diagnostics.push({
      code: 'package-version-invalid',
      field: 'version',
      message: 'package.json version must be a string when present',
    });
  }

  const coreDependencyRange = validateCoreDependencyRange(
    packageJson,
    opts.currentCoreVersion,
    diagnostics,
  );

  const aharnessPackage = readAharnessPackage(packageJson, diagnostics);
  const commands = aharnessPackage
    ? parseCommandShapes(aharnessPackage, opts.packageJsonText, diagnostics)
    : [];

  const validatedCommands: InstallPackageCommand[] = [];
  if (commands.length > 0) {
    const realPackageRoot = await resolvePackageRoot(packageRoot, diagnostics);
    for (const command of commands) {
      const validated = realPackageRoot
        ? await validateCommandEntry({ packageRoot, realPackageRoot, command, diagnostics })
        : null;
      if (validated) validatedCommands.push(validated);
    }
  }

  if (
    diagnostics.length > 0 ||
    !packageName ||
    (packageVersion === undefined) !== (rawVersion === undefined) ||
    !coreDependencyRange ||
    commands.length === 0 ||
    validatedCommands.length !== commands.length
  ) {
    return { ok: false, diagnostics };
  }

  validatedCommands.sort((a, b) => a.commandName.localeCompare(b.commandName));
  return {
    ok: true,
    value: {
      packageRoot,
      packageJsonPath,
      packageName,
      ...(packageVersion !== undefined ? { packageVersion } : {}),
      coreDependencyRange,
      commands: validatedCommands,
    },
  };
}

function readAharnessPackage(
  packageJson: PackageJsonObject,
  diagnostics: InstallPackageDiagnostic[],
): Record<string, unknown> | null {
  const aharness = packageJson['aharness'];
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

function parseCommandShapes(
  aharnessPackage: Record<string, unknown>,
  packageJsonText: string | undefined,
  diagnostics: InstallPackageDiagnostic[],
): readonly ParsedCommandShape[] {
  const rawCommands = aharnessPackage['commands'];
  if (rawCommands === undefined) {
    diagnostics.push({
      code: 'install-commands-missing',
      field: 'aharness.package.commands',
      message: 'installable packages must declare aharness.package.commands',
    });
    return [];
  }

  if (!isRecord(rawCommands)) {
    diagnostics.push({
      code: 'install-commands-invalid',
      field: 'aharness.package.commands',
      message: 'aharness.package.commands must be an object',
    });
    return [];
  }

  if (Object.keys(rawCommands).length === 0) {
    diagnostics.push({
      code: 'install-commands-empty',
      field: 'aharness.package.commands',
      message: 'aharness.package.commands must declare at least one command',
    });
    return [];
  }

  if (packageJsonText !== undefined) {
    for (const duplicate of findDuplicateCommandKeys(packageJsonText)) {
      diagnostics.push({
        code: 'command-name-duplicate',
        field: `aharness.package.commands.${duplicate.commandName}`,
        commandName: duplicate.commandName,
        message: `duplicate install command '${duplicate.commandName}'`,
      });
    }
  }

  const commands: ParsedCommandShape[] = [];
  for (const [commandName, rawCommand] of Object.entries(rawCommands)) {
    const commandField = `aharness.package.commands.${commandName}`;
    if (!COMMAND_NAME_RE.test(commandName)) {
      diagnostics.push({
        code: 'command-name-invalid',
        field: commandField,
        commandName,
        message: `command name '${commandName}' must match ${COMMAND_NAME_RE.source}`,
      });
    }

    if (!isRecord(rawCommand)) {
      diagnostics.push({
        code: 'command-entry-invalid',
        field: commandField,
        commandName,
        message: 'install command metadata entries must be objects',
      });
      continue;
    }

    const entryField = `${commandField}.entry`;
    const rawEntry = rawCommand['entry'];
    if (rawEntry === undefined) {
      diagnostics.push({
        code: 'command-entry-missing',
        field: entryField,
        commandName,
        message: 'install command entry is required',
      });
      continue;
    }
    if (typeof rawEntry !== 'string') {
      diagnostics.push({
        code: 'command-entry-invalid',
        field: entryField,
        commandName,
        message: 'install command entry must be a non-empty string',
      });
      continue;
    }
    if (rawEntry.length === 0) {
      diagnostics.push({
        code: 'command-entry-invalid',
        field: entryField,
        commandName,
        path: rawEntry,
        message: 'install command entry must be a non-empty string',
      });
      continue;
    }

    const rawDescription = rawCommand['description'];
    let description: string | undefined;
    if (rawDescription !== undefined) {
      if (typeof rawDescription !== 'string') {
        diagnostics.push({
          code: 'command-description-invalid',
          field: `${commandField}.description`,
          commandName,
          message: 'install command description must be a string',
        });
      } else {
        description = rawDescription;
      }
    }

    commands.push({
      commandName,
      entry: rawEntry,
      field: entryField,
      ...(description !== undefined ? { description } : {}),
    });
  }

  return commands;
}

async function validateCommandEntry(opts: {
  readonly packageRoot: string;
  readonly realPackageRoot: string;
  readonly command: ParsedCommandShape;
  readonly diagnostics: InstallPackageDiagnostic[];
}): Promise<InstallPackageCommand | null> {
  const pathResult = validatePackagePath({
    packageRoot: opts.packageRoot,
    relativePath: opts.command.entry,
    field: opts.command.field,
  });
  if (!pathResult.ok) {
    opts.diagnostics.push(
      ...pathResult.diagnostics.map((diagnostic) =>
        withCommand(diagnostic, opts.command.commandName),
      ),
    );
    return null;
  }

  if (!pathResult.value.relativePath.endsWith(FSM_ENTRY_SUFFIX)) {
    opts.diagnostics.push({
      code: 'entry-extension-invalid',
      field: opts.command.field,
      commandName: opts.command.commandName,
      path: opts.command.entry,
      resolvedFile: pathResult.value.absolutePath,
      message: 'install command entry must point to a .fsm.ts file',
    });
    return null;
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(pathResult.value.absolutePath);
  } catch (err) {
    opts.diagnostics.push({
      code: 'entry-stat-failed',
      field: opts.command.field,
      commandName: opts.command.commandName,
      path: opts.command.entry,
      resolvedFile: pathResult.value.absolutePath,
      message: `could not inspect install command entry: ${errorMessage(err)}`,
    });
    return null;
  }

  if (stat.isSymbolicLink()) {
    opts.diagnostics.push({
      code: 'entry-symlink-rejected',
      field: opts.command.field,
      commandName: opts.command.commandName,
      path: opts.command.entry,
      resolvedFile: pathResult.value.absolutePath,
      message: 'install command entries must not be symlinks',
    });
    return null;
  }

  if (!stat.isFile()) {
    opts.diagnostics.push({
      code: 'entry-not-file',
      field: opts.command.field,
      commandName: opts.command.commandName,
      path: opts.command.entry,
      resolvedFile: pathResult.value.absolutePath,
      message: 'install command entry must resolve to a regular file',
    });
    return null;
  }

  let realEntryPath: string;
  try {
    realEntryPath = await fs.realpath(pathResult.value.absolutePath);
  } catch (err) {
    opts.diagnostics.push({
      code: 'entry-realpath-failed',
      field: opts.command.field,
      commandName: opts.command.commandName,
      path: opts.command.entry,
      resolvedFile: pathResult.value.absolutePath,
      message: `could not resolve install command entry realpath: ${errorMessage(err)}`,
    });
    return null;
  }

  if (!isPathInsideOrEqual(opts.realPackageRoot, realEntryPath)) {
    opts.diagnostics.push({
      code: 'entry-realpath-escapes',
      field: opts.command.field,
      commandName: opts.command.commandName,
      path: opts.command.entry,
      resolvedFile: realEntryPath,
      message: 'install command entry resolves outside the package root',
    });
    return null;
  }

  return {
    commandName: opts.command.commandName,
    entry: pathResult.value.relativePath,
    entryPath: pathResult.value.absolutePath,
    ...(opts.command.description !== undefined ? { description: opts.command.description } : {}),
  };
}

function validateCoreDependencyRange(
  packageJson: PackageJsonObject,
  currentCoreVersion: string,
  diagnostics: InstallPackageDiagnostic[],
): string | null {
  const field = `dependencies.${CORE_DEPENDENCY}`;
  const dependencies = packageJson['dependencies'];
  if (!isRecord(dependencies) || dependencies[CORE_DEPENDENCY] === undefined) {
    diagnostics.push({
      code: 'core-dependency-missing',
      field,
      message: `package.json dependencies must include ${CORE_DEPENDENCY}`,
    });
    return null;
  }

  const rawRange = dependencies[CORE_DEPENDENCY];
  if (typeof rawRange !== 'string' || rawRange.length === 0) {
    diagnostics.push({
      code: 'core-dependency-invalid',
      field,
      message: `${CORE_DEPENDENCY} dependency must be a non-empty semver range`,
    });
    return null;
  }

  if (!semver.validRange(rawRange)) {
    diagnostics.push({
      code: 'core-dependency-invalid',
      field,
      message: `${CORE_DEPENDENCY} dependency '${rawRange}' is not a valid semver range`,
    });
    return null;
  }

  if (!semver.satisfies(currentCoreVersion, rawRange)) {
    diagnostics.push({
      code: 'core-dependency-incompatible',
      field,
      message:
        `${CORE_DEPENDENCY} dependency '${rawRange}' does not include ` +
        `current @aharness/core version ${currentCoreVersion}`,
    });
    return null;
  }

  return rawRange;
}

async function resolvePackageRoot(
  packageRoot: string,
  diagnostics: InstallPackageDiagnostic[],
): Promise<string | null> {
  try {
    return await fs.realpath(packageRoot);
  } catch (err) {
    diagnostics.push({
      code: 'package-root-realpath-failed',
      path: packageRoot,
      message: `could not resolve package root realpath: ${errorMessage(err)}`,
    });
    return null;
  }
}

function readRequiredString(
  obj: Record<string, unknown>,
  field: string,
  diagnostics: InstallPackageDiagnostic[],
  diagnostic: { readonly code: string; readonly message: string },
): string | null {
  const value = obj[field];
  if (typeof value === 'string' && value.length > 0) return value;
  diagnostics.push({
    code: diagnostic.code,
    field,
    message: diagnostic.message,
  });
  return null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function withCommand(
  diagnostic: PackagePathDiagnostic,
  commandName: string,
): InstallPackageDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    commandName,
    ...(diagnostic.field !== undefined ? { field: diagnostic.field } : {}),
    ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
