import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('recovers a missing command index when installs are valid and fingerprints match', async () => {
    const install = installRecord('@scope/tools', { build: commandMetadata('build') });
    await mkdir(storeRoot, { recursive: true });
    await writeJson(paths.installsPath, installsFile({ installs: { '@scope/tools': install } }));

    const snapshot = await readInstalledRuntimeSnapshot({
      paths,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
    });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.commands.generation).toBe(snapshot.value.installs.generation);
    expect(snapshot.value.commands.commands['@scope/tools/build']).toEqual(
      commandIndexEntry('@scope/tools', 'build'),
    );
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toContain('@scope/tools/build');
  });

  it('fails when commands.json exists without trusted installs as source of truth', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(paths.commandsPath, commandsFile());

    const snapshot = await readInstalledRuntimeSnapshot({ paths });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-runtime-files-incomplete',
          path: paths.installsPath,
        }),
      ]);
    }
  });

  it('recovers stale command indexes with matching install fingerprints', async () => {
    await writeTrustedPair({
      installs: installsFile({
        generation: 'gen-2',
        installs: {
          '@scope/tools': installRecord('@scope/tools', { build: commandMetadata('build') }),
        },
      }),
      commands: commandsFile({ generation: 'gen-1' }),
    });

    const snapshot = await readInstalledRuntimeSnapshot({
      paths,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
    });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.commands.generation).toBe('gen-2');
    expect(snapshot.value.commands.commands['@scope/tools/build']).toEqual(
      commandIndexEntry('@scope/tools', 'build'),
    );
  });

  it('recovers malformed command indexes only after validating install fingerprints', async () => {
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

    const snapshot = await readInstalledRuntimeSnapshot({
      paths,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
    });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.commands.commands['@scope/tools/build']).toEqual(
      commandIndexEntry('@scope/tools', 'build'),
    );
  });

  it('leaves malformed command indexes unrecovered when install fingerprints mismatch', async () => {
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

    const snapshot = await readInstalledRuntimeSnapshot({
      paths,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'changed-lock' }),
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          code: 'installed-lock-fingerprint-mismatch',
          field: 'installs.@scope/tools.lockFingerprint',
        }),
      ]);
    }
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe('{ nope');
  });

  it('does not recover command indexes when a package fingerprint changed', async () => {
    await writeTrustedPair({
      installs: installsFile({
        generation: 'gen-2',
        installs: {
          '@scope/tools': installRecord('@scope/tools', { build: commandMetadata('build') }),
        },
      }),
      commands: commandsFile({ generation: 'gen-1' }),
    });

    const snapshot = await readInstalledRuntimeSnapshot({
      paths,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'changed-lock' }),
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          code: 'installed-lock-fingerprint-mismatch',
          field: 'installs.@scope/tools.lockFingerprint',
        }),
      ]);
    }
  });

  it('fails malformed installs with source-of-truth recovery guidance', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeFile(paths.installsPath, '{ nope');
    await writeJson(paths.commandsPath, commandsFile());

    const snapshot = await readInstalledRuntimeSnapshot({
      paths,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-json-invalid',
          path: paths.installsPath,
        }),
        expect.objectContaining({
          code: 'trusted-installs-unrecoverable',
          path: paths.installsPath,
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
          message: expect.stringContaining('uninstall'),
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
