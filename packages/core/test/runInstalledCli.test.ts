import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runInstalledCli } from '../src/cli/runInstalledCli.js';
import type { RunCliForTestOpts } from '../src/cli/runCli.js';
import {
  computeLockFingerprint,
  resolveInstallStorePaths,
  type InstalledRuntimeSnapshot,
  type InstallStorePaths,
  type TrustedCommandIndexEntry,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';
import type { LoadFsmResult } from '../src/loader/index.js';

describe('aharness run installed commands', () => {
  it('passes the installed command as the run target label to runCliImpl', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', {
        build: commandMetadata('build'),
      }),
    ]);
    const loaded = makeLoadedFsm();
    const loadInstalledFsmImpl = vi.fn(async () => loaded);
    const runtimeCalls: RunCliForTestOpts[] = [];
    const runCliImpl = vi.fn(async (opts: RunCliForTestOpts) => {
      runtimeCalls.push(opts);
      await opts.verify?.({ fsmPath: opts.fsmPath, repoRoot: opts.cwd });
      await opts.loadFsmImpl?.({ filePath: opts.fsmPath, repoRoot: opts.cwd });
      return { exitCode: 0 };
    });

    const stdout = captureStream();
    const stderr = captureStream();
    const result = await runInstalledCli({
      command: '@scope/tools/build',
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: stderr.stream,
      inputArgs: ['--topic', 'auth'],
      permissionMode: 'ask',
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl,
      runCliImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(stderr.text()).toBe('');
    expect(runtimeCalls).toHaveLength(1);
    expect(runtimeCalls[0]).toMatchObject({
      fsmPath: path.join('/store/packages/node_modules/@scope/tools', 'fsms/build.fsm.ts'),
      runTargetLabel: '@scope/tools/build',
      cwd: '/workspace',
      inputArgs: ['--topic', 'auth'],
      permissionMode: 'ask',
    });
    expect(loadInstalledFsmImpl).toHaveBeenCalledWith({
      entryFile: path.join('/store/packages/node_modules/@scope/tools', 'fsms/build.fsm.ts'),
      packageName: '@scope/tools',
      commandName: 'build',
      packageRoot: '/store/packages/node_modules/@scope/tools',
      managedProjectRoot: '/store/packages',
      storeRoot: '/store',
      lockFingerprint: 'verified-lock',
    });
    expect(stdout.text()).toBe('');
  });

  it('forwards yolo permission mode into the runtime', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', {
        build: commandMetadata('build'),
      }),
    ]);
    const runtimeCalls: RunCliForTestOpts[] = [];
    const runCliImpl = vi.fn(async (opts: RunCliForTestOpts) => {
      runtimeCalls.push(opts);
      return { exitCode: 0 };
    });

    const result = await runInstalledCli({
      command: '@scope/tools/build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      permissionMode: 'yolo',
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      runCliImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runtimeCalls).toHaveLength(1);
    expect(runtimeCalls[0]).toMatchObject({
      permissionMode: 'yolo',
    });
  });

  it('resolves unique bare commands and runs package commands named list and verify', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('tools', {
        list: commandMetadata('list'),
        verify: commandMetadata('verify'),
      }),
    ]);
    const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));

    const listResult = await runInstalledCli({
      command: 'list',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      runCliImpl,
    });
    const verifyResult = await runInstalledCli({
      command: 'verify',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      runCliImpl,
    });

    expect(listResult).toEqual({ exitCode: 0 });
    expect(verifyResult).toEqual({ exitCode: 0 });
    expect(runCliImpl).toHaveBeenCalledTimes(2);
    expect(runCliImpl.mock.calls[0]?.[0]).not.toHaveProperty('permissionMode');
    expect(runCliImpl.mock.calls[1]?.[0]).not.toHaveProperty('permissionMode');
  });

  it('fails ambiguous bare commands with fully qualified alternatives', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
      installRecord('other', { build: commandMetadata('build') }),
    ]);
    const stderr = captureStream();
    const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runInstalledCli({
      command: 'build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      runCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('aharness run failed:');
    expect(stderr.text()).toContain('@scope/tools/build, other/build');
    expect(runCliImpl).not.toHaveBeenCalled();
  });

  it('fails before workflow startup when the lock fingerprint changed', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const stderr = captureStream();
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
    const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runInstalledCli({
      command: '@scope/tools/build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({
        ok: false,
        diagnostics: [
          {
            code: 'installed-lock-fingerprint-mismatch',
            field: 'lockFingerprint',
            message: 'package changed; reinstall it',
          },
        ],
      }),
      loadInstalledFsmImpl,
      runCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('installed-lock-fingerprint-mismatch');
    expect(loadInstalledFsmImpl).not.toHaveBeenCalled();
    expect(runCliImpl).not.toHaveBeenCalled();
  });

  it('does not keep trusted store reads open while the workflow runtime runs', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-no-read-lock-'));
    try {
      await mkdir(storeRoot, { recursive: true });
      const snapshot = runtimeSnapshot(
        [
          installRecord('@scope/tools', {
            build: commandMetadata('build'),
          }),
        ],
        storeRoot,
      );
      const runCliImpl = vi.fn(async () => {
        await writeFile(snapshot.paths.commandsPath, '{"rewritten":true}\n');
        return { exitCode: 0 };
      });

      const result = await runInstalledCli({
        command: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
        checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
        loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
        runCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runCliImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('runs through a recovered malformed command index from real trusted files', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-recovered-index-'));
    try {
      const paths = await writeRealTrustedStore(storeRoot, { commands: 'malformed' });
      const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
      const runCliImpl = vi.fn(async (opts: RunCliForTestOpts) => {
        await opts.loadFsmImpl?.({ filePath: opts.fsmPath, repoRoot: opts.cwd });
        return { exitCode: 0 };
      });

      const result = await runInstalledCli({
        command: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        env: { AHARNESS_HOME: storeRoot },
        loadInstalledFsmImpl,
        runCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(1);
      await expect(readFile(paths.commandsPath, 'utf8')).resolves.toContain('@scope/tools/build');
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('surfaces malformed installs as a hard trusted-store failure from real files', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-bad-installs-'));
    try {
      const paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
      await mkdir(storeRoot, { recursive: true });
      await writeFile(paths.installsPath, '{ nope');
      await writeJson(paths.commandsPath, commandsFile({ generation: 'gen-real' }));
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const stderr = captureStream();
      const result = await runInstalledCli({
        command: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: stderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
        runCliImpl,
      });

      expect(result).toEqual({ exitCode: 1 });
      expect(stderr.text()).toContain('trusted-installs-unrecoverable');
      expect(runCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('tells users to reinstall or uninstall when the current lock fingerprint changed', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-lock-mismatch-'));
    try {
      await writeRealTrustedStore(storeRoot, {
        commands: 'valid',
        trustedLockFingerprint: 'stale-lock',
      });
      const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const stderr = captureStream();

      const result = await runInstalledCli({
        command: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: stderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        loadInstalledFsmImpl,
        runCliImpl,
      });

      expect(result).toEqual({ exitCode: 1 });
      expect(stderr.text()).toContain('installed-lock-fingerprint-mismatch');
      expect(stderr.text()).toContain('reinstall or uninstall');
      expect(loadInstalledFsmImpl).not.toHaveBeenCalled();
      expect(runCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('rejects package-only identities as not runnable commands', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const stderr = captureStream();

    const result = await runInstalledCli({
      command: '@scope/tools',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      runCliImpl: vi.fn(async () => ({ exitCode: 0 })),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('identifies a package, not a command');
  });
});

function runtimeSnapshot(
  records: readonly TrustedInstallRecord[],
  storeRoot = '/store',
): InstalledRuntimeSnapshot {
  const installs: Record<string, TrustedInstallRecord> = {};
  const commands: Record<string, TrustedCommandIndexEntry> = {};
  for (const record of records) {
    installs[record.packageName] = record;
    for (const command of Object.values(record.commands)) {
      commands[`${record.packageName}/${command.commandName}`] = {
        packageName: record.packageName,
        commandName: command.commandName,
        entry: command.entry,
        packageRoot: record.packageRoot,
        ...(record.packageVersion !== undefined ? { packageVersion: record.packageVersion } : {}),
        lockFingerprint: record.lockFingerprint,
        ...(command.description !== undefined ? { description: command.description } : {}),
      };
    }
  }
  return {
    paths: {
      storeRoot,
      managedProjectRoot: path.join(storeRoot, 'packages'),
      installsPath: path.join(storeRoot, 'installs.json'),
      commandsPath: path.join(storeRoot, 'commands.json'),
    },
    installs: { schemaVersion: 1, generation: 'gen-1', installs },
    commands: { schemaVersion: 1, generation: 'gen-1', commands },
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

async function writeRealTrustedStore(
  storeRoot: string,
  opts: {
    readonly commands: 'valid' | 'malformed';
    readonly trustedLockFingerprint?: string;
  },
): Promise<InstallStorePaths> {
  const paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
  await mkdir(paths.managedProjectRoot, { recursive: true });
  await writePackageLock(paths.managedProjectRoot);
  const fingerprint = await computeLockFingerprint({
    managedProjectRoot: paths.managedProjectRoot,
    dependencyKey: '@scope/tools',
    packageName: '@scope/tools',
    packageVersion: '1.2.3',
  });
  if (!fingerprint.ok) {
    throw new Error(`test lock fingerprint failed: ${JSON.stringify(fingerprint.diagnostics)}`);
  }

  const record: TrustedInstallRecord = {
    packageName: '@scope/tools',
    dependencyKey: '@scope/tools',
    requestedSpec: '@scope/tools@latest',
    packageRoot: path.join(paths.managedProjectRoot, 'node_modules', '@scope', 'tools'),
    packageVersion: '1.2.3',
    sourceIntentKey: 'registry:https://registry.npmjs.org/:@scope/tools',
    lockFingerprint: opts.trustedLockFingerprint ?? fingerprint.value,
    commands: {
      build: commandMetadata('build'),
    },
  };
  await writeJson(
    paths.installsPath,
    installsFile({
      generation: 'gen-real',
      installs: {
        '@scope/tools': record,
      },
    }),
  );
  if (opts.commands === 'malformed') {
    await writeFile(paths.commandsPath, '{ nope');
  } else {
    await writeJson(
      paths.commandsPath,
      commandsFile({
        generation: 'gen-real',
        commands: {
          '@scope/tools/build': commandIndexEntryFromRecord(record, 'build'),
        },
      }),
    );
  }
  return paths;
}

async function writePackageLock(managedProjectRoot: string): Promise<void> {
  await writeFile(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        lockfileVersion: 3,
        packages: {
          '': {
            dependencies: {
              '@scope/tools': '1.2.3',
            },
          },
          'node_modules/@scope/tools': {
            version: '1.2.3',
            resolved: 'https://registry.npmjs.org/@scope/tools/-/tools-1.2.3.tgz',
            integrity: 'sha512-tools',
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
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

function commandIndexEntryFromRecord(
  record: TrustedInstallRecord,
  commandName: string,
): TrustedCommandIndexEntry {
  return {
    packageName: record.packageName,
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
    packageRoot: record.packageRoot,
    ...(record.packageVersion !== undefined ? { packageVersion: record.packageVersion } : {}),
    lockFingerprint: record.lockFingerprint,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeLoadedFsm(): LoadFsmResult {
  return {
    machine: {} as LoadFsmResult['machine'],
    sidecar: {},
    modulePath: '/tmp/fsm.mjs',
    issues: [],
    cacheHit: false,
    hash: 'hash',
  };
}

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}
