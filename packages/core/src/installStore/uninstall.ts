import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { deriveCommandIndexFromInstalls } from './records.js';
import { resolveInstallStorePaths, type InstallStorePaths } from './paths.js';
import { runNpmUninstall, type UninstallNpmRunner } from './npmRunner.js';
import { readTrustedJson, writeTrustedJson } from './trustedJson.js';
import { validateTrustedInstallsFile } from './schema.js';
import {
  INSTALL_STORE_SCHEMA_VERSION,
  type InstallStoreDiagnostic,
  type TrustedInstallsFile,
} from './types.js';

export interface UninstallPackageOptions {
  readonly packageName: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly paths?: InstallStorePaths;
  readonly npmUninstall?: UninstallNpmRunner;
  readonly generationId?: () => string;
  readonly writeTrustedJsonImpl?: typeof writeTrustedJson;
}

export interface UninstallPackageSuccess {
  readonly packageName: string;
  readonly removedCommandCount: number;
  readonly generation: string;
}

export type UninstallPackageMutationResult =
  | {
      readonly ok: true;
      readonly value: UninstallPackageSuccess;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly InstallStoreDiagnostic[];
    };

export async function uninstallPackage(
  opts: UninstallPackageOptions,
): Promise<UninstallPackageMutationResult> {
  void opts.cwd;
  const paths =
    opts.paths ??
    resolveInstallStorePaths({
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    });
  const npmUninstall = opts.npmUninstall ?? runNpmUninstall;
  const generationId = opts.generationId ?? randomUUID;
  const writeTrustedJsonImpl = opts.writeTrustedJsonImpl ?? writeTrustedJson;

  const existingInstalls = await readTrustedInstallsOrEmpty(paths);
  if (!existingInstalls.ok) return { ok: false, diagnostics: existingInstalls.diagnostics };

  const record = findInstallRecord(existingInstalls.value, opts.packageName);
  if (!record) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'installed-package-not-found',
          field: `installs.${opts.packageName}`,
          message: `package '${opts.packageName}' is not installed`,
        },
      ],
    };
  }

  const npmResult = await npmUninstall({
    managedProjectRoot: paths.managedProjectRoot,
    dependencyKey: record.dependencyKey,
  });
  if (!npmResult.ok) return { ok: false, diagnostics: npmResult.diagnostics };

  const generation = generationId();
  const remainingInstalls = { ...existingInstalls.value.installs };
  for (const [key, install] of Object.entries(remainingInstalls)) {
    if (install.packageName === record.packageName) {
      delete remainingInstalls[key];
    }
  }
  const candidateInstalls: TrustedInstallsFile = {
    schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
    generation,
    installs: remainingInstalls,
  };

  const commandIndex = deriveCommandIndexFromInstalls(candidateInstalls);
  if (!commandIndex.ok) return { ok: false, diagnostics: commandIndex.diagnostics };

  const installsWrite = await writeTrustedJsonImpl(paths.installsPath, candidateInstalls);
  if (!installsWrite.ok) return { ok: false, diagnostics: installsWrite.diagnostics };

  const commandsWrite = await writeTrustedJsonImpl(paths.commandsPath, commandIndex.value);
  if (!commandsWrite.ok) {
    return {
      ok: false,
      diagnostics: [
        ...commandsWrite.diagnostics,
        {
          code: 'command-index-write-after-installs-failed',
          path: paths.commandsPath,
          message:
            'installs.json was written but commands.json was not; command-index recovery will ' +
            'regenerate the derived index before installed commands are trusted',
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      packageName: record.packageName,
      removedCommandCount: Object.keys(record.commands).length,
      generation,
    },
  };
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

function findInstallRecord(
  installsFile: TrustedInstallsFile,
  packageName: string,
): TrustedInstallsFile['installs'][string] | undefined {
  return (
    installsFile.installs[packageName] ??
    Object.values(installsFile.installs).find((record) => record.packageName === packageName)
  );
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

export type { UninstallNpmRunner };
