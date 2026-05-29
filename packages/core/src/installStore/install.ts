import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { readInstallPackageManifest } from '../installPackage/index.js';
import type { InstallPackageDiagnostic } from '../installPackage/types.js';
import { loadInstalledFsm } from '../loader/index.js';
import { verify } from '../verify/index.js';
import {
  INSTALL_STORE_SCHEMA_VERSION,
  type InstallStoreDiagnostic,
  type TrustedCommandMetadata,
  type TrustedInstallsFile,
} from './types.js';
import { resolveInstallStorePaths, type InstallStorePaths } from './paths.js';
import { ensureManagedProject, readManagedProjectDependencies } from './managedProject.js';
import { runNpmInstall, type InstallNpmRunner } from './npmRunner.js';
import {
  computeInstalledSourceIntentKey,
  deriveDependencyKeyFromSource,
  identifyDependencyKeyBySourceIntent,
  identifyDirectDependencyKey,
} from './sourceIntent.js';
import { computeLockFingerprint } from './lockfile.js';
import { readTrustedJson, writeTrustedJson } from './trustedJson.js';
import { validateTrustedInstallsFile } from './schema.js';
import { deriveCommandIndexFromInstalls } from './records.js';

export interface InstallPackageFromSourceOptions {
  readonly source: string;
  readonly cwd: string;
  readonly currentCoreVersion: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly paths?: InstallStorePaths;
  readonly npmInstall?: InstallNpmRunner;
  readonly loadInstalledFsmImpl?: typeof loadInstalledFsm;
  readonly verifyImpl?: typeof verify;
  readonly generationId?: () => string;
}

export interface InstallPackageSuccess {
  readonly packageName: string;
  readonly verifiedCommandCount: number;
  readonly generation: string;
}

export type InstallPackageMutationResult =
  | {
      readonly ok: true;
      readonly value: InstallPackageSuccess;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly InstallStoreDiagnostic[];
      readonly npmMutated: boolean;
      readonly managedProjectRoot?: string;
    };

export async function installPackageFromSource(
  opts: InstallPackageFromSourceOptions,
): Promise<InstallPackageMutationResult> {
  const paths =
    opts.paths ??
    resolveInstallStorePaths({
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    });
  const npmInstall = opts.npmInstall ?? runNpmInstall;
  const loadInstalledFsmImpl = opts.loadInstalledFsmImpl ?? loadInstalledFsm;
  const verifyImpl = opts.verifyImpl ?? verify;
  const generationId = opts.generationId ?? randomUUID;

  const ensured = await ensureManagedProject(paths);
  if (!ensured.ok) return failure(ensured.diagnostics, false, paths);

  const beforeDependencies = await readManagedProjectDependencies(paths.managedProjectRoot);
  if (!beforeDependencies.ok) return failure(beforeDependencies.diagnostics, false, paths);

  const npmResult = await npmInstall({
    managedProjectRoot: paths.managedProjectRoot,
    cwd: opts.cwd,
    source: opts.source,
  });
  if (!npmResult.ok) return failure(npmResult.diagnostics, false, paths);

  const afterDependencies = await readManagedProjectDependencies(paths.managedProjectRoot);
  if (!afterDependencies.ok) return failure(afterDependencies.diagnostics, true, paths);

  let dependencyKeyResult = identifyDirectDependencyKey({
    before: beforeDependencies.value,
    after: afterDependencies.value,
    source: opts.source,
  });
  if (!dependencyKeyResult.ok && onlyDirectDependencyNotFound(dependencyKeyResult.diagnostics)) {
    dependencyKeyResult = await deriveDependencyKeyFromSource({
      source: opts.source,
      cwd: opts.cwd,
    });
  }
  if (!dependencyKeyResult.ok && onlyDirectDependencyNotFound(dependencyKeyResult.diagnostics)) {
    dependencyKeyResult = await identifyDependencyKeyBySourceIntent({
      source: opts.source,
      sourceCwd: opts.cwd,
      dependencyCwd: paths.managedProjectRoot,
      dependencies: afterDependencies.value,
    });
  }
  if (!dependencyKeyResult.ok) return failure(dependencyKeyResult.diagnostics, true, paths);

  const dependencyKey = dependencyKeyResult.value;
  if (afterDependencies.value[dependencyKey] === undefined) {
    return failure(
      [
        {
          code: 'direct-dependency-key-not-found',
          field: `dependencies.${dependencyKey}`,
          message: `npm did not save direct dependency '${dependencyKey}' for '${opts.source}'`,
        },
      ],
      true,
      paths,
    );
  }

  const sourceIntentKey = await computeInstalledSourceIntentKey({
    source: opts.source,
    cwd: opts.cwd,
    managedProjectRoot: paths.managedProjectRoot,
    dependencyKey,
  });
  if (!sourceIntentKey.ok) return failure(sourceIntentKey.diagnostics, true, paths);

  const packageRoot = path.join(paths.managedProjectRoot, 'node_modules', dependencyKey);
  const manifest = await readInstallPackageManifest({
    packageRoot,
    currentCoreVersion: opts.currentCoreVersion,
  });
  if (!manifest.ok) return failure(mapInstallPackageDiagnostics(manifest.diagnostics), true, paths);

  const existingInstalls = await readTrustedInstallsOrEmpty(paths);
  if (!existingInstalls.ok) return failure(existingInstalls.diagnostics, true, paths);

  const existingRecord = existingInstalls.value.installs[manifest.value.packageName];
  if (existingRecord && existingRecord.sourceIntentKey !== sourceIntentKey.value) {
    return failure(
      [
        {
          code: 'install-source-collision',
          field: `installs.${manifest.value.packageName}.sourceIntentKey`,
          message:
            `package '${manifest.value.packageName}' is already installed from a different source; ` +
            'uninstall it before installing a different source with the same package name',
        },
      ],
      true,
      paths,
    );
  }

  const lockFingerprint = await computeLockFingerprint({
    managedProjectRoot: paths.managedProjectRoot,
    dependencyKey,
    packageName: manifest.value.packageName,
    ...(manifest.value.packageVersion !== undefined
      ? { packageVersion: manifest.value.packageVersion }
      : {}),
  });
  if (!lockFingerprint.ok) return failure(lockFingerprint.diagnostics, true, paths);

  const verification = await verifyInstallCommands({
    commands: manifest.value.commands,
    packageName: manifest.value.packageName,
    packageRoot,
    managedProjectRoot: paths.managedProjectRoot,
    storeRoot: paths.storeRoot,
    lockFingerprint: lockFingerprint.value,
    loadInstalledFsmImpl,
    verifyImpl,
  });
  if (!verification.ok) return failure(verification.diagnostics, true, paths);

  const commandSnapshots = buildCommandSnapshots(manifest.value.commands);
  const generation = generationId();
  const candidateInstalls: TrustedInstallsFile = {
    schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
    generation,
    installs: {
      ...existingInstalls.value.installs,
      [manifest.value.packageName]: {
        packageName: manifest.value.packageName,
        dependencyKey,
        requestedSpec: opts.source,
        packageRoot,
        ...(manifest.value.packageVersion !== undefined
          ? { packageVersion: manifest.value.packageVersion }
          : {}),
        sourceIntentKey: sourceIntentKey.value,
        lockFingerprint: lockFingerprint.value,
        commands: commandSnapshots,
      },
    },
  };

  const commandIndex = deriveCommandIndexFromInstalls(candidateInstalls);
  if (!commandIndex.ok) return failure(commandIndex.diagnostics, true, paths);

  const installsWrite = await writeTrustedJson(paths.installsPath, candidateInstalls);
  if (!installsWrite.ok) return failure(installsWrite.diagnostics, true, paths);

  const commandsWrite = await writeTrustedJson(paths.commandsPath, commandIndex.value);
  if (!commandsWrite.ok) {
    return failure(
      [
        ...commandsWrite.diagnostics,
        {
          code: 'command-index-write-after-installs-failed',
          path: paths.commandsPath,
          message:
            'installs.json was written but commands.json was not; generation mismatch recovery ' +
            'must regenerate the command index before installed commands are trusted',
        },
      ],
      true,
      paths,
    );
  }

  return {
    ok: true,
    value: {
      packageName: manifest.value.packageName,
      verifiedCommandCount: manifest.value.commands.length,
      generation,
    },
  };
}

async function verifyInstallCommands(opts: {
  readonly commands: readonly {
    readonly commandName: string;
    readonly entry: string;
    readonly entryPath: string;
  }[];
  readonly packageName: string;
  readonly packageRoot: string;
  readonly managedProjectRoot: string;
  readonly storeRoot: string;
  readonly lockFingerprint: string;
  readonly loadInstalledFsmImpl: typeof loadInstalledFsm;
  readonly verifyImpl: typeof verify;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly diagnostics: InstallStoreDiagnostic[] }
> {
  const diagnostics: InstallStoreDiagnostic[] = [];
  for (const command of opts.commands) {
    let loaded: Awaited<ReturnType<typeof loadInstalledFsm>>;
    try {
      loaded = await opts.loadInstalledFsmImpl({
        entryFile: command.entryPath,
        packageName: opts.packageName,
        commandName: command.commandName,
        packageRoot: opts.packageRoot,
        managedProjectRoot: opts.managedProjectRoot,
        storeRoot: opts.storeRoot,
        lockFingerprint: opts.lockFingerprint,
      });
    } catch (err) {
      diagnostics.push({
        code: 'install-command-load-failed',
        commandName: command.commandName,
        path: command.entryPath,
        message: `could not load install command '${command.commandName}': ${errorMessage(err)}`,
      });
      continue;
    }

    const result = opts.verifyImpl(loaded.machine, loaded.sidecar, loaded.issues, {
      skillEnv: {
        fsmFileDir: path.dirname(command.entryPath),
        repoRoot: opts.packageRoot,
      },
    });
    if (!result.ok) {
      for (const issue of result.errors) {
        diagnostics.push({
          code: 'install-command-verify-failed',
          commandName: command.commandName,
          path: command.entryPath,
          message:
            `command '${command.commandName}' failed verifier check ${issue.check} ` +
            `(${issue.stateId}): ${issue.message}`,
        });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true };
}

function buildCommandSnapshots(
  commands: readonly {
    readonly commandName: string;
    readonly entry: string;
    readonly description?: string;
  }[],
): Record<string, TrustedCommandMetadata> {
  const snapshots: Record<string, TrustedCommandMetadata> = {};
  for (const command of commands) {
    snapshots[command.commandName] = {
      commandName: command.commandName,
      entry: command.entry,
      ...(command.description !== undefined ? { description: command.description } : {}),
    };
  }
  return snapshots;
}

async function readTrustedInstallsOrEmpty(
  paths: InstallStorePaths,
): Promise<
  | { readonly ok: true; readonly value: TrustedInstallsFile }
  | { readonly ok: false; readonly diagnostics: readonly InstallStoreDiagnostic[] }
> {
  try {
    await fs.access(paths.installsPath);
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) {
      return {
        ok: true,
        value: {
          schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
          generation: 'empty',
          installs: {},
        },
      };
    }
    return {
      ok: false,
      diagnostics: [
        {
          code: 'trusted-json-read-failed',
          path: paths.installsPath,
          message: `could not inspect trusted install file: ${errorMessage(err)}`,
        },
      ],
    };
  }

  return readTrustedJson(paths.installsPath, validateTrustedInstallsFile);
}

function mapInstallPackageDiagnostics(
  diagnostics: readonly InstallPackageDiagnostic[],
): InstallStoreDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
    ...(diagnostic.field !== undefined ? { field: diagnostic.field } : {}),
    ...(diagnostic.commandName !== undefined ? { commandName: diagnostic.commandName } : {}),
  }));
}

function failure(
  diagnostics: readonly InstallStoreDiagnostic[],
  npmMutated: boolean,
  paths: InstallStorePaths,
): InstallPackageMutationResult {
  return {
    ok: false,
    diagnostics,
    npmMutated,
    managedProjectRoot: paths.managedProjectRoot,
  };
}

function onlyDirectDependencyNotFound(diagnostics: readonly InstallStoreDiagnostic[]): boolean {
  return diagnostics.every((diagnostic) => diagnostic.code === 'direct-dependency-key-not-found');
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

export type { InstallNpmRunner };
