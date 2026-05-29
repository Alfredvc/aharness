import * as path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runInstalledCli } from '../src/cli/runInstalledCli.js';
import type { RunCliForTestOpts } from '../src/cli/runCli.js';
import type {
  InstalledRuntimeSnapshot,
  TrustedCommandIndexEntry,
  TrustedInstallRecord,
} from '../src/installStore/index.js';
import type { LoadFsmResult } from '../src/loader/index.js';

describe('aharness run installed commands', () => {
  it('runs a fully qualified installed command through the normal runtime', async () => {
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
      inputArgs: ['--topic', 'auth', '--dry-run'],
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
      cwd: '/workspace',
      inputArgs: ['--topic', 'auth', '--dry-run'],
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
