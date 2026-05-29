import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkInstalledLockFingerprint,
  readInstalledRuntimeSnapshot,
  resolveInstallStorePaths,
  resolveInstalledCommand,
  resolveInstalledPackage,
  type InstallStorePaths,
  type TrustedCommandIndexEntry,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('install store runtime snapshot helpers', () => {
  let storeRoot: string;
  let paths: InstallStorePaths;

  beforeEach(async () => {
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-runtime-'));
    paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
  });

  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('treats a store with no trusted files as an empty runtime snapshot', async () => {
    const snapshot = await readInstalledRuntimeSnapshot({ paths });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.installs.installs).toEqual({});
    expect(snapshot.value.commands.commands).toEqual({});
    expect(snapshot.value.paths.storeRoot).toBe(storeRoot);
  });

  it('fails a partially missing trusted file pair without regenerating', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(paths.installsPath, installsFile());

    const snapshot = await readInstalledRuntimeSnapshot({ paths });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-runtime-files-incomplete',
          path: paths.commandsPath,
        }),
      ]);
    }
  });

  it('fails stale command indexes with the generation mismatch diagnostic', async () => {
    await writeTrustedPair({
      installs: installsFile({ generation: 'gen-2' }),
      commands: commandsFile({ generation: 'gen-1' }),
    });

    const snapshot = await readInstalledRuntimeSnapshot({ paths });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-index-generation-mismatch',
          field: 'generation',
        }),
      ]);
    }
  });

  it('resolves qualified and unique bare commands with matching install records', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build'),
      deploy: commandMetadata('deploy'),
    });
    const snapshot = runtimeSnapshot({
      installs: installsFile({ installs: { '@scope/tools': install } }),
      commands: commandsFile({
        commands: {
          '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
          '@scope/tools/deploy': commandIndexEntry('@scope/tools', 'deploy'),
        },
      }),
    });

    const qualified = resolveInstalledCommand('@scope/tools/build', snapshot);
    const bare = resolveInstalledCommand('deploy', snapshot);

    expect(qualified).toEqual({
      ok: true,
      value: expect.objectContaining({
        identity: '@scope/tools/build',
        install,
        command: install.commands['build'],
      }),
    });
    expect(bare).toEqual({
      ok: true,
      value: expect.objectContaining({
        identity: '@scope/tools/deploy',
        install,
        command: install.commands['deploy'],
      }),
    });
  });

  it('fails command resolution when the index cannot be joined back to installs', () => {
    const snapshot = runtimeSnapshot({
      installs: installsFile(),
      commands: commandsFile({
        commands: {
          'missing/build': commandIndexEntry('missing', 'build'),
        },
      }),
    });

    const result = resolveInstalledCommand('missing/build', snapshot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'installed-command-install-record-missing',
          commandName: 'build',
        }),
      ]);
    }
  });

  it('resolves scoped and unscoped installed packages by exact package identity', () => {
    const scoped = installRecord('@scope/tools', { build: commandMetadata('build') });
    const unscoped = installRecord('tools', { deploy: commandMetadata('deploy') });
    const snapshot = runtimeSnapshot({
      installs: installsFile({ installs: { '@scope/tools': scoped, tools: unscoped } }),
      commands: commandsFile(),
    });

    expect(resolveInstalledPackage('@scope/tools', snapshot)).toEqual({
      ok: true,
      value: { packageName: '@scope/tools', install: scoped },
    });
    expect(resolveInstalledPackage('tools', snapshot)).toEqual({
      ok: true,
      value: { packageName: 'tools', install: unscoped },
    });
  });

  it('checks the current lock fingerprint against the trusted install record', async () => {
    const record = installRecord('@scope/tools', { build: commandMetadata('build') });
    const computeLockFingerprintImpl = vi.fn(async () => ({
      ok: true as const,
      value: 'changed-lock',
    }));

    const result = await checkInstalledLockFingerprint(record, paths, {
      computeLockFingerprintImpl,
    });

    expect(computeLockFingerprintImpl).toHaveBeenCalledWith({
      managedProjectRoot: paths.managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.2.3',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'installed-lock-fingerprint-mismatch',
          field: 'lockFingerprint',
        }),
      ]);
    }
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

function runtimeSnapshot(opts: {
  readonly installs: TrustedInstallsFile;
  readonly commands: TrustedCommandsFile;
}) {
  return {
    paths: {
      storeRoot: '/store',
      managedProjectRoot: '/store/packages',
      installsPath: '/store/installs.json',
      commandsPath: '/store/commands.json',
    },
    installs: opts.installs,
    commands: opts.commands,
  };
}

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
