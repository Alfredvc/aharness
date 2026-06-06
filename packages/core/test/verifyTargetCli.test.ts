import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runVerifyTargetCli } from '../src/cli/verifyTargetCli.js';
import type { RunVerifyCliOpts } from '../src/cli/verifyCli.js';
import type { RunVerifyInstalledCliOptions } from '../src/cli/verifyInstalledCli.js';
import type {
  InstalledRuntimeSnapshot,
  TrustedCommandIndexEntry,
  TrustedCommandsFile,
  TrustedInstallRecord,
  TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('aharness verify target dispatch', () => {
  it('verifies local FSM targets through the normal verifier without checking existence', async () => {
    const runVerifyCliImpl = vi.fn(async () => ({ exitCode: 0 as const }));
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();

    const result = await runVerifyTargetCli({
      target: './missing.fsm.ts',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl,
      checkLockFingerprintImpl,
      runVerifyCliImpl,
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runVerifyCliImpl).toHaveBeenCalledWith({
      fsmPath: './missing.fsm.ts',
      repoRoot: '/workspace',
      log: expect.any(Function),
    } satisfies RunVerifyCliOpts);
    expect(runVerifyInstalledCliImpl).not.toHaveBeenCalled();
    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('verifies unique bare installed commands through command-only installed verification', async () => {
    const resolverSeams = installedResolverSeams('@scope/tools', ['build']);
    const runVerifyCliImpl = vi.fn(async () => ({ exitCode: 0 as const }));
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runVerifyTargetCli({
      target: 'build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      ...resolverSeams,
      runVerifyCliImpl,
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runVerifyInstalledCliImpl).toHaveBeenCalledWith({
      target: 'build',
      cwd: '/workspace',
      stdout: expect.any(Writable),
      stderr: expect.any(Writable),
    } satisfies RunVerifyInstalledCliOptions);
    expect(runVerifyCliImpl).not.toHaveBeenCalled();
    expect(resolverSeams.readSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(resolverSeams.checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
  });

  it('verifies fully qualified installed commands through command-only installed verification', async () => {
    const resolverSeams = installedResolverSeams('@scope/tools', ['build']);
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runVerifyTargetCli({
      target: '@scope/tools/build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      ...resolverSeams,
      runVerifyCliImpl: vi.fn(async () => ({ exitCode: 0 as const })),
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runVerifyInstalledCliImpl).toHaveBeenCalledWith({
      target: '@scope/tools/build',
      cwd: '/workspace',
      stdout: expect.any(Writable),
      stderr: expect.any(Writable),
    } satisfies RunVerifyInstalledCliOptions);
  });

  it('verifies an installed bare command even when a same-named local file exists', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-verify-target-shadow-'));
    try {
      await writeFile(path.join(cwd, 'build'), '');
      const resolverSeams = installedResolverSeams('@scope/tools', ['build']);
      const runVerifyCliImpl = vi.fn(async () => ({ exitCode: 0 as const }));
      const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runVerifyTargetCli({
        target: 'build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        ...resolverSeams,
        runVerifyCliImpl,
        runVerifyInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runVerifyInstalledCliImpl).toHaveBeenCalledWith({
        target: 'build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
      } satisfies RunVerifyInstalledCliOptions);
      expect(runVerifyCliImpl).not.toHaveBeenCalled();
      expect(resolverSeams.readSnapshotImpl).toHaveBeenCalledTimes(1);
      expect(resolverSeams.checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('verifies a local FSM target when an installed command has the same identity', async () => {
    const runVerifyCliImpl = vi.fn(async () => ({ exitCode: 0 as const }));
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();

    const result = await runVerifyTargetCli({
      target: 'build.fsm.ts',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl,
      checkLockFingerprintImpl,
      runVerifyCliImpl,
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runVerifyCliImpl).toHaveBeenCalledWith({
      fsmPath: 'build.fsm.ts',
      repoRoot: '/workspace',
      log: expect.any(Function),
    } satisfies RunVerifyCliOpts);
    expect(runVerifyInstalledCliImpl).not.toHaveBeenCalled();
    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('fails explicit local non-FSM targets before local or installed verification', async () => {
    const runVerifyCliImpl = vi.fn(async () => ({ exitCode: 0 as const }));
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();
    const stderr = captureStream();

    const result = await runVerifyTargetCli({
      target: './workflow',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl,
      checkLockFingerprintImpl,
      runVerifyCliImpl,
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('aharness verify failed:');
    expect(stderr.text()).toContain('[fsm-target-invalid-local]');
    expect(stderr.text()).toContain("local FSM target './workflow' must end in .fsm.ts");
    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
    expect(runVerifyCliImpl).not.toHaveBeenCalled();
    expect(runVerifyInstalledCliImpl).not.toHaveBeenCalled();
  });

  it('adds removal guidance when package-only verify targets are rejected', async () => {
    const resolverSeams = installedResolverSeams('@scope/tools', ['build']);
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const stderr = captureStream();

    const result = await runVerifyTargetCli({
      target: '@scope/tools',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      ...resolverSeams,
      runVerifyCliImpl: vi.fn(async () => ({ exitCode: 0 as const })),
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('command-identity-package-only');
    expect(stderr.text()).toContain('package-only verification was removed');
    expect(stderr.text()).toContain('specify <package>/<command>');
    expect(stderr.text()).toContain('or a unique bare command name');
    expect(runVerifyInstalledCliImpl).not.toHaveBeenCalled();
  });

  it('stops before installed verification when lock fingerprint validation fails', async () => {
    const snapshot = runtimeSnapshot([installRecord('@scope/tools', ['build'])]);
    const runVerifyInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const stderr = captureStream();

    const result = await runVerifyTargetCli({
      target: '@scope/tools/build',
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: false as const,
        diagnostics: [
          {
            code: 'installed-lock-fingerprint-mismatch',
            field: 'lockFingerprint',
            message: 'package changed; reinstall it',
          },
        ],
      })),
      runVerifyCliImpl: vi.fn(async () => ({ exitCode: 0 as const })),
      runVerifyInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('installed-lock-fingerprint-mismatch');
    expect(runVerifyInstalledCliImpl).not.toHaveBeenCalled();
  });
});

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

function installedResolverSeams(packageName: string, commands: readonly string[]) {
  const snapshot = runtimeSnapshot([installRecord(packageName, commands)]);
  return {
    readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    checkLockFingerprintImpl: vi.fn(async () => ({
      ok: true as const,
      value: 'computed-lock',
    })),
  };
}

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
    installs: installsFile({ installs }),
    commands: commandsFile({ commands }),
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

function installRecord(packageName: string, commandNames: readonly string[]): TrustedInstallRecord {
  return {
    packageName,
    dependencyKey: packageName,
    requestedSpec: `${packageName}@latest`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    sourceIntentKey: `registry:${packageName}`,
    lockFingerprint: 'verified-lock',
    commands: Object.fromEntries(
      commandNames.map((commandName) => [
        commandName,
        {
          commandName,
          entry: `fsms/${commandName}.fsm.ts`,
        },
      ]),
    ),
  };
}
