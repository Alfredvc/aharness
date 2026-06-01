import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readInstalledCompletionSnapshot,
  resolveInstallStorePaths,
  type InstallStorePaths,
  type TrustedCommandIndexEntry,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('install store completion snapshot helper', () => {
  let storeRoot: string;
  let paths: InstallStorePaths;

  beforeEach(async () => {
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-completion-'));
    paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
  });

  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('reads valid matching trusted install and command files', async () => {
    const install = installRecord('@scope/tools', { build: commandMetadata('build') });
    await writeTrustedPair({
      installs: installsFile({ installs: { '@scope/tools': install } }),
      commands: commandsFile({
        commands: {
          '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
        },
      }),
    });

    const snapshot = await readInstalledCompletionSnapshot({ paths });

    expect(snapshot.installs.installs['@scope/tools']).toEqual(install);
    expect(snapshot.commands.commands['@scope/tools/build']).toEqual(
      commandIndexEntry('@scope/tools', 'build'),
    );
    expect(snapshot.paths.storeRoot).toBe(storeRoot);
  });

  it('returns empty commands when commands.json is missing without creating it', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(
      paths.installsPath,
      installsFile({
        installs: {
          '@scope/tools': installRecord('@scope/tools', { build: commandMetadata('build') }),
        },
      }),
    );

    const snapshot = await readInstalledCompletionSnapshot({ paths });

    expect(snapshot.installs.installs).toEqual({});
    expect(snapshot.commands.commands).toEqual({});
    await expect(readFile(paths.commandsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns empty snapshots when commands.json exists without installs.json and leaves commands unchanged', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(paths.commandsPath, commandsFile());
    const before = await readFile(paths.commandsPath, 'utf8');

    const snapshot = await readInstalledCompletionSnapshot({ paths });

    expect(snapshot.installs.installs).toEqual({});
    expect(snapshot.commands.commands).toEqual({});
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe(before);
  });

  it('returns empty snapshots for malformed installs.json and leaves commands unchanged', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeFile(paths.installsPath, '{ nope');
    await writeJson(paths.commandsPath, commandsFile());
    const before = await readFile(paths.commandsPath, 'utf8');

    const snapshot = await readInstalledCompletionSnapshot({ paths });

    expect(snapshot.installs.installs).toEqual({});
    expect(snapshot.commands.commands).toEqual({});
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe(before);
  });

  it('returns empty commands for malformed commands.json and leaves it unchanged', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(
      paths.installsPath,
      installsFile({
        installs: {
          '@scope/tools': installRecord('@scope/tools', { build: commandMetadata('build') }),
        },
      }),
    );
    await writeFile(paths.commandsPath, '{ nope');

    const snapshot = await readInstalledCompletionSnapshot({ paths });

    expect(snapshot.installs.installs).toEqual({});
    expect(snapshot.commands.commands).toEqual({});
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe('{ nope');
  });

  it('returns empty snapshots when the command index generation is stale', async () => {
    await writeTrustedPair({
      installs: installsFile({
        generation: 'gen-2',
        installs: {
          '@scope/tools': installRecord('@scope/tools', { build: commandMetadata('build') }),
        },
      }),
      commands: commandsFile({
        generation: 'gen-1',
        commands: {
          '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
        },
      }),
    });

    const snapshot = await readInstalledCompletionSnapshot({ paths });

    expect(snapshot.installs.installs).toEqual({});
    expect(snapshot.commands.commands).toEqual({});
  });

  async function writeTrustedPair(opts: {
    readonly installs: TrustedInstallsFile;
    readonly commands: TrustedCommandsFile;
  }): Promise<void> {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(paths.installsPath, opts.installs);
    await writeJson(paths.commandsPath, opts.commands);
  }
});

function installsFile(
  opts: {
    readonly generation?: string;
    readonly installs?: Record<string, TrustedInstallRecord>;
  } = {},
): TrustedInstallsFile {
  return {
    schemaVersion: 1,
    generation: opts.generation ?? 'gen-1',
    installs: opts.installs ?? {},
  };
}

function commandsFile(
  opts: {
    readonly generation?: string;
    readonly commands?: Record<string, TrustedCommandIndexEntry>;
  } = {},
): TrustedCommandsFile {
  return {
    schemaVersion: 1,
    generation: opts.generation ?? 'gen-1',
    commands: opts.commands ?? {},
  };
}

function installRecord(
  packageName: string,
  commands: TrustedInstallRecord['commands'],
): TrustedInstallRecord {
  return {
    packageName,
    dependencyKey: packageName,
    requestedSpec: `${packageName}@latest`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    sourceIntentKey: `registry:${packageName}`,
    lockFingerprint: 'verified-lock',
    commands,
  };
}

function commandMetadata(commandName: string): TrustedInstallRecord['commands'][string] {
  return {
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
  };
}

function commandIndexEntry(packageName: string, commandName: string): TrustedCommandIndexEntry {
  return {
    packageName,
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    lockFingerprint: 'verified-lock',
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
