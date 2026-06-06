import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runVerifyInstalledCli } from '../src/cli/verifyInstalledCli.js';
import {
  computeLockFingerprint,
  resolveInstallStorePaths,
  type InstalledRuntimeSnapshot,
  type InstallStorePaths,
  type TrustedCommandIndexEntry,
  type TrustedInstallRecord,
  type TrustedCommandsFile,
  type TrustedInstallsFile,
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
    expect(verifyImpl).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        skillOriginManifest: expect.objectContaining({
          rootSourceDir: '/store/packages/node_modules/@scope/tools/fsms',
        }),
      }),
    );
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

  it('verifies unique bare installed commands when no package has that name', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
    const verifyImpl = vi.fn(() => okVerifyResult());
    const stdout = captureStream();

    const result = await runVerifyInstalledCli({
      target: 'build',
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl,
      verifyImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(loadInstalledFsmImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        entryFile: path.join('/store/packages/node_modules/@scope/tools', 'fsms/build.fsm.ts'),
        commandName: 'build',
      }),
    );
    expect(verifyImpl).toHaveBeenCalledTimes(1);
    expect(stdout.text()).toContain('verify: ok (@scope/tools/build, 0 warnings)');
  });

  it('still treats an exact unscoped package match as a package target', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('build', {
        zeta: commandMetadata('zeta'),
        alpha: commandMetadata('alpha'),
      }),
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());

    const result = await runVerifyInstalledCli({
      target: 'build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl,
      verifyImpl: vi.fn(() => okVerifyResult()),
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(2);
    expect(loadInstalledFsmImpl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entryFile: path.join('/store/packages/node_modules/build', 'fsms/alpha.fsm.ts'),
        commandName: 'alpha',
      }),
    );
    expect(loadInstalledFsmImpl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entryFile: path.join('/store/packages/node_modules/build', 'fsms/zeta.fsm.ts'),
        commandName: 'zeta',
      }),
    );
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

  it('does not keep trusted store reads open while command verification loads FSMs', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-verify-no-read-lock-'));
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
      const loadInstalledFsmImpl = vi.fn(async () => {
        await writeFile(snapshot.paths.commandsPath, '{"rewritten":true}\n');
        return makeLoadedFsm();
      });

      const result = await runVerifyInstalledCli({
        target: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
        checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
        loadInstalledFsmImpl,
        verifyImpl: vi.fn(() => okVerifyResult()),
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('verifies through a recovered malformed command index from real trusted files', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-verify-recovered-index-'));
    try {
      const paths = await writeRealTrustedStore(storeRoot, { commands: 'malformed' });
      const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
      const verifyImpl = vi.fn(() => okVerifyResult());
      const stdout = captureStream();
      const stderr = captureStream();

      const result = await runVerifyInstalledCli({
        target: '@scope/tools/build',
        cwd: '/workspace',
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        loadInstalledFsmImpl,
        verifyImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(stderr.text()).toBe('');
      expect(stdout.text()).toContain('verify: ok (@scope/tools/build, 0 warnings)');
      expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(1);
      await expect(readFile(paths.commandsPath, 'utf8')).resolves.toContain('@scope/tools/build');
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('surfaces malformed installs as a hard trusted-store failure from real files', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-verify-bad-installs-'));
    try {
      const paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
      await mkdir(storeRoot, { recursive: true });
      await writeFile(paths.installsPath, '{ nope');
      await writeJson(paths.commandsPath, commandsFile({ generation: 'gen-real' }));
      const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
      const verifyImpl = vi.fn(() => okVerifyResult());
      const stderr = captureStream();

      const result = await runVerifyInstalledCli({
        target: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: stderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        loadInstalledFsmImpl,
        verifyImpl,
      });

      expect(result).toEqual({ exitCode: 1 });
      expect(stderr.text()).toContain('trusted-installs-unrecoverable');
      expect(loadInstalledFsmImpl).not.toHaveBeenCalled();
      expect(verifyImpl).not.toHaveBeenCalled();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('tells users to reinstall or uninstall when command verification sees a changed lock', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-verify-lock-mismatch-'));
    try {
      await writeRealTrustedStore(storeRoot, {
        commands: 'valid',
        trustedLockFingerprint: 'stale-lock',
      });
      const loadInstalledFsmImpl = vi.fn(async () => makeLoadedFsm());
      const verifyImpl = vi.fn(() => okVerifyResult());
      const stderr = captureStream();

      const result = await runVerifyInstalledCli({
        target: '@scope/tools/build',
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: stderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        loadInstalledFsmImpl,
        verifyImpl,
      });

      expect(result).toEqual({ exitCode: 1 });
      expect(stderr.text()).toContain('installed-lock-fingerprint-mismatch');
      expect(stderr.text()).toContain('reinstall or uninstall');
      expect(loadInstalledFsmImpl).not.toHaveBeenCalled();
      expect(verifyImpl).not.toHaveBeenCalled();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
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

  it('prints verifier warnings for installed commands that verify successfully', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const stdout = captureStream();
    const stderr = captureStream();
    const warning = {
      severity: 'warning',
      check: 'skill-must-resolve',
      stateId: 'build',
      message: 'optional skill is missing',
      location: {
        sourceFile: '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts',
        line: 12,
        column: 9,
      },
    } as VerifyResult['warnings'][number];

    const result = await runVerifyInstalledCli({
      target: '@scope/tools/build',
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'verified-lock' }),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadedFsm()),
      verifyImpl: vi.fn(() => ({
        ok: true,
        errors: [],
        warnings: [warning],
        issues: [warning],
      })),
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(stderr.text()).toContain(
      '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts:12:9: [warning] skill-must-resolve (build): optional skill is missing',
    );
    expect(stdout.text()).toContain('verify: ok (@scope/tools/build, 1 warnings)');
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
    skillOriginManifest: {
      rootSourceDir: '/store/packages/node_modules/@scope/tools/fsms',
      sourceDirPrefixes: [],
      availableSkills: [],
    },
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
