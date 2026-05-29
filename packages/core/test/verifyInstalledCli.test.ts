import * as path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runVerifyInstalledCli } from '../src/cli/verifyInstalledCli.js';
import type {
  InstalledRuntimeSnapshot,
  TrustedCommandIndexEntry,
  TrustedInstallRecord,
} from '../src/installStore/index.js';
import type { LoadFsmResult } from '../src/loader/index.js';
import type { VerifyResult } from '../src/verify/index.js';

describe('aharness verify installed packages and commands', () => {
  it('verifies every command in an installed package sorted by command name', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', {
        zeta: commandMetadata('zeta'),
        alpha: commandMetadata('alpha'),
      }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
    const verifyImpl = vi.fn(() => okVerifyResult());
    const stdout = captureStream();

    const result = await runVerifyInstalledCli({
      target: '@scope/tools',
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl,
      verifyImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(loadInstalledFsmImpl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entryFile: path.join('/store/packages/node_modules/@scope/tools', 'fsms/alpha.fsm.ts'),
        commandName: 'alpha',
      }),
    );
    expect(loadInstalledFsmImpl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entryFile: path.join('/store/packages/node_modules/@scope/tools', 'fsms/zeta.fsm.ts'),
        commandName: 'zeta',
      }),
    );
    expect(verifyImpl).toHaveBeenCalledTimes(2);
    expect(stdout.text().split('\n').filter(Boolean)).toEqual([
      'verify: ok (@scope/tools/alpha, 0 warnings)',
      'verify: ok (@scope/tools/zeta, 0 warnings)',
    ]);
  });

  it('verifies scoped and unscoped qualified installed commands', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
      installRecord('tools', { deploy: commandMetadata('deploy') }),
    ]);
    const verifyImpl = vi.fn(() => okVerifyResult());

    const scoped = await runVerifyInstalledCli({
      target: '@scope/tools/build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      verifyImpl,
    });
    const unscoped = await runVerifyInstalledCli({
      target: 'tools/deploy',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      verifyImpl,
    });

    expect(scoped).toEqual({ exitCode: 0 });
    expect(unscoped).toEqual({ exitCode: 0 });
  });

  it('treats unscoped single-token targets as package names, not bare commands', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const stderr = captureStream();

    const result = await runVerifyInstalledCli({
      target: 'build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      verifyImpl: vi.fn(() => okVerifyResult()),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain("package 'build' is not installed");
  });

  it('fails before loading when the package lock fingerprint changed', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
    const verifyImpl = vi.fn(() => okVerifyResult());
    const stderr = captureStream();

    const result = await runVerifyInstalledCli({
      target: '@scope/tools/build',
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
      verifyImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(loadInstalledFsmImpl).not.toHaveBeenCalled();
    expect(verifyImpl).not.toHaveBeenCalled();
    expect(stderr.text()).toContain('installed-lock-fingerprint-mismatch');
  });

  it('formats verifier errors and exits nonzero', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const stderr = captureStream();

    const result = await runVerifyInstalledCli({
      target: '@scope/tools/build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      verifyImpl: vi.fn(() => ({
        ok: false,
        errors: [
          {
            severity: 'error',
            check: 'terminal-reachability',
            stateId: 'start',
            message: 'cannot reach a terminal state',
          },
        ],
        warnings: [],
        issues: [
          {
            severity: 'error',
            check: 'terminal-reachability',
            stateId: 'start',
            message: 'cannot reach a terminal state',
          },
        ],
      })),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('[error] terminal-reachability (start): cannot reach');
  });
});

function runtimeSnapshot(records: readonly TrustedInstallRecord[]): InstalledRuntimeSnapshot {
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
      storeRoot: '/store',
      managedProjectRoot: '/store/packages',
      installsPath: '/store/installs.json',
      commandsPath: '/store/commands.json',
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

function okVerifyResult(): VerifyResult {
  return {
    ok: true,
    errors: [],
    warnings: [],
    issues: [],
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
