import { promises as fs } from 'node:fs';

import { compareCommandIndexGeneration, type CommandIndexGenerationComparison } from './records.js';
import { resolveCommandFromIndex } from './commands.js';
import { computeLockFingerprint, type ComputeLockFingerprintOptions } from './lockfile.js';
import { resolveInstallStorePaths, type InstallStorePaths } from './paths.js';
import { regenerateCommandIndexFromInstalls } from './recovery.js';
import { validateTrustedCommandsFile, validateTrustedInstallsFile } from './schema.js';
import { readTrustedJson, writeTrustedJson } from './trustedJson.js';
import {
  INSTALL_STORE_SCHEMA_VERSION,
  type InstallStoreDiagnostic,
  type InstallStoreResult,
  type TrustedCommandIndexEntry,
  type TrustedCommandMetadata,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from './types.js';

export interface InstalledRuntimeSnapshot {
  readonly paths: InstallStorePaths;
  readonly installs: TrustedInstallsFile;
  readonly commands: TrustedCommandsFile;
}

export interface ReadInstalledRuntimeSnapshotOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly paths?: InstallStorePaths;
  readonly computeLockFingerprintImpl?: (
    opts: ComputeLockFingerprintOptions,
  ) => Promise<InstallStoreResult<string>>;
  readonly writeTrustedJsonImpl?: typeof writeTrustedJson;
}

export interface ResolvedInstalledCommand {
  readonly identity: string;
  readonly indexEntry: TrustedCommandIndexEntry;
  readonly install: TrustedInstallRecord;
  readonly command: TrustedCommandMetadata;
}

export interface ResolvedInstalledPackage {
  readonly packageName: string;
  readonly install: TrustedInstallRecord;
}

export interface CheckInstalledLockFingerprintDeps {
  readonly computeLockFingerprintImpl?: (
    opts: ComputeLockFingerprintOptions,
  ) => Promise<InstallStoreResult<string>>;
}

export async function readInstalledRuntimeSnapshot(
  opts: ReadInstalledRuntimeSnapshotOptions = {},
): Promise<InstallStoreResult<InstalledRuntimeSnapshot>> {
  const paths =
    opts.paths ??
    resolveInstallStorePaths({
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    });

  const installsPresence = await filePresence(paths.installsPath);
  const commandsPresence = await filePresence(paths.commandsPath);
  if (!installsPresence.ok) return { ok: false, diagnostics: installsPresence.diagnostics };
  if (!commandsPresence.ok) return { ok: false, diagnostics: commandsPresence.diagnostics };

  if (!installsPresence.exists && !commandsPresence.exists) {
    return {
      ok: true,
      value: {
        paths,
        installs: {
          schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
          generation: 'empty',
          installs: {},
        },
        commands: {
          schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
          generation: 'empty',
          commands: {},
        },
      },
    };
  }

  if (!installsPresence.exists && commandsPresence.exists) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'trusted-runtime-files-incomplete',
          path: paths.installsPath,
          message:
            'trusted install runtime files are incomplete; installs.json and commands.json ' +
            'must both exist before installed commands are trusted',
        },
      ],
    };
  }

  const installs = await readTrustedJson(paths.installsPath, validateTrustedInstallsFile);
  if (!installs.ok) {
    return {
      ok: false,
      diagnostics: [...installs.diagnostics, unrecoverableInstallsDiagnostic(paths.installsPath)],
    };
  }

  if (!commandsPresence.exists) {
    return recoverRuntimeSnapshot({ paths, installs: installs.value, opts });
  }

  const commands = await readTrustedJson(paths.commandsPath, validateTrustedCommandsFile);
  if (!commands.ok) {
    return recoverRuntimeSnapshot({ paths, installs: installs.value, opts });
  }

  const generation: CommandIndexGenerationComparison = compareCommandIndexGeneration(
    installs.value,
    commands.value,
  );
  if (!generation.current) {
    return recoverRuntimeSnapshot({ paths, installs: installs.value, opts });
  }

  return {
    ok: true,
    value: {
      paths,
      installs: installs.value,
      commands: commands.value,
    },
  };
}

async function recoverRuntimeSnapshot(args: {
  readonly paths: InstallStorePaths;
  readonly installs: TrustedInstallsFile;
  readonly opts: ReadInstalledRuntimeSnapshotOptions;
}): Promise<InstallStoreResult<InstalledRuntimeSnapshot>> {
  const recovered = await regenerateCommandIndexFromInstalls({
    paths: args.paths,
    installs: args.installs,
    ...(args.opts.computeLockFingerprintImpl !== undefined
      ? { computeLockFingerprintImpl: args.opts.computeLockFingerprintImpl }
      : {}),
    ...(args.opts.writeTrustedJsonImpl !== undefined
      ? { writeTrustedJsonImpl: args.opts.writeTrustedJsonImpl }
      : {}),
  });
  if (!recovered.ok) return recovered;

  return {
    ok: true,
    value: {
      paths: args.paths,
      installs: args.installs,
      commands: recovered.value,
    },
  };
}

export function resolveInstalledCommand(
  input: string,
  snapshot: InstalledRuntimeSnapshot,
): InstallStoreResult<ResolvedInstalledCommand> {
  const resolved = resolveCommandFromIndex(snapshot.commands, input);
  if (!resolved.ok) return resolved;

  const install = findInstallRecord(snapshot.installs, resolved.value.entry.packageName);
  if (!install) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'installed-command-install-record-missing',
          commandName: resolved.value.entry.commandName,
          field: `installs.${resolved.value.entry.packageName}`,
          message:
            `command '${resolved.value.identity}' is indexed, but package ` +
            `'${resolved.value.entry.packageName}' has no trusted install record`,
        },
      ],
    };
  }

  const command = install.commands[resolved.value.entry.commandName];
  if (
    command === undefined ||
    command.commandName !== resolved.value.entry.commandName ||
    command.entry !== resolved.value.entry.entry
  ) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'installed-command-install-snapshot-missing',
          commandName: resolved.value.entry.commandName,
          field: `installs.${install.packageName}.commands.${resolved.value.entry.commandName}`,
          message:
            `command '${resolved.value.identity}' is indexed, but the trusted install record ` +
            'does not contain a matching command snapshot',
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      identity: resolved.value.identity,
      indexEntry: resolved.value.entry,
      install,
      command,
    },
  };
}

export function resolveInstalledPackage(
  packageName: string,
  snapshot: InstalledRuntimeSnapshot,
): InstallStoreResult<ResolvedInstalledPackage> {
  const install = findInstallRecord(snapshot.installs, packageName);
  if (!install) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'installed-package-not-found',
          field: `installs.${packageName}`,
          message: `package '${packageName}' is not installed`,
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      packageName: install.packageName,
      install,
    },
  };
}

export async function checkInstalledLockFingerprint(
  record: TrustedInstallRecord,
  paths: InstallStorePaths,
  deps: CheckInstalledLockFingerprintDeps = {},
): Promise<InstallStoreResult<string>> {
  const computeLockFingerprintImpl = deps.computeLockFingerprintImpl ?? computeLockFingerprint;
  const fingerprint = await computeLockFingerprintImpl({
    managedProjectRoot: paths.managedProjectRoot,
    dependencyKey: record.dependencyKey,
    packageName: record.packageName,
    ...(record.packageVersion !== undefined ? { packageVersion: record.packageVersion } : {}),
  });
  if (!fingerprint.ok) return fingerprint;

  if (fingerprint.value !== record.lockFingerprint) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'installed-lock-fingerprint-mismatch',
          field: 'lockFingerprint',
          message:
            `installed package '${record.packageName}' no longer matches the verified install ` +
            'record; reinstall or uninstall the package before running or verifying it',
        },
      ],
    };
  }

  return fingerprint;
}

function findInstallRecord(
  installsFile: TrustedInstallsFile,
  packageName: string,
): TrustedInstallRecord | undefined {
  return (
    installsFile.installs[packageName] ??
    Object.values(installsFile.installs).find((record) => record.packageName === packageName)
  );
}

async function filePresence(
  filePath: string,
): Promise<
  | { readonly ok: true; readonly exists: boolean }
  | { readonly ok: false; readonly diagnostics: readonly InstallStoreDiagnostic[] }
> {
  try {
    await fs.access(filePath);
    return { ok: true, exists: true };
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) return { ok: true, exists: false };
    return {
      ok: false,
      diagnostics: [
        {
          code: 'trusted-json-read-failed',
          path: filePath,
          message: `could not inspect trusted JSON file: ${errorMessage(err)}`,
        },
      ],
    };
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string' &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function unrecoverableInstallsDiagnostic(path: string): InstallStoreDiagnostic {
  return {
    code: 'trusted-installs-unrecoverable',
    path,
    message:
      'installs.json is the trusted source of truth for installed packages; restore or remove ' +
      'that file before installed commands can be trusted',
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
