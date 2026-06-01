import { promises as fs } from 'node:fs';

import { compareCommandIndexGeneration } from './records.js';
import { resolveInstallStorePaths, type InstallStorePaths } from './paths.js';
import { validateTrustedCommandsFile, validateTrustedInstallsFile } from './schema.js';
import { readTrustedJson } from './trustedJson.js';
import {
  INSTALL_STORE_SCHEMA_VERSION,
  type TrustedCommandsFile,
  type TrustedInstallsFile,
} from './types.js';
import type { InstalledRuntimeSnapshot } from './runtime.js';

export interface ReadInstalledCompletionSnapshotOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly paths?: InstallStorePaths;
}

export async function readInstalledCompletionSnapshot(
  opts: ReadInstalledCompletionSnapshotOptions = {},
): Promise<InstalledRuntimeSnapshot> {
  const paths =
    opts.paths ??
    resolveInstallStorePaths({
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    });

  const empty = (): InstalledRuntimeSnapshot => ({
    paths,
    installs: emptyInstallsFile(),
    commands: emptyCommandsFile(),
  });

  if (!(await exists(paths.installsPath)) || !(await exists(paths.commandsPath))) {
    return empty();
  }

  const installs = await readTrustedJson(paths.installsPath, validateTrustedInstallsFile);
  if (!installs.ok) return empty();

  const commands = await readTrustedJson(paths.commandsPath, validateTrustedCommandsFile);
  if (!commands.ok) return empty();

  const generation = compareCommandIndexGeneration(installs.value, commands.value);
  if (!generation.current) return empty();

  return { paths, installs: installs.value, commands: commands.value };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function emptyInstallsFile(): TrustedInstallsFile {
  return { schemaVersion: INSTALL_STORE_SCHEMA_VERSION, generation: 'empty', installs: {} };
}

function emptyCommandsFile(): TrustedCommandsFile {
  return { schemaVersion: INSTALL_STORE_SCHEMA_VERSION, generation: 'empty', commands: {} };
}
