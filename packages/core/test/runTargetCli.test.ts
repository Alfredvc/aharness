import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runTargetCli, runTargetHelpCli } from '../src/cli/runTargetCli.js';
import type { RunCliOpts } from '../src/cli/runCli.js';
import type { RunInstalledCliOptions } from '../src/cli/runInstalledCli.js';
import type {
  InstalledRuntimeSnapshot,
  TrustedCommandIndexEntry,
  TrustedCommandsFile,
  TrustedInstallRecord,
  TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('aharness run target dispatch', () => {
  it('runs an existing local FSM file through the normal runtime', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-local-'));
    try {
      await writeFile(path.join(cwd, 'workflow.fsm.ts'), '');
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetCli({
        target: './workflow.fsm.ts',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'ask',
        noOpen: true,
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runCliImpl).toHaveBeenCalledWith({
        fsmPath: './workflow.fsm.ts',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--topic', 'auth'],
        inputUsageCommand: 'aharness run ./workflow.fsm.ts',
        permissionMode: 'ask',
        noOpen: true,
      } satisfies RunCliOpts);
      expect(runInstalledCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs a missing qualified command through installed command execution', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-installed-'));
    try {
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const resolverSeams = installedResolverSeams('@scope/tools', ['build']);

      const result = await runTargetCli({
        target: '@scope/tools/build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'yolo',
        noOpen: true,
        ...resolverSeams,
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runInstalledCliImpl).toHaveBeenCalledWith({
        command: '@scope/tools/build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'yolo',
        noOpen: true,
      } satisfies RunInstalledCliOptions);
      expect(runCliImpl).not.toHaveBeenCalled();
      expect(resolverSeams.readSnapshotImpl).toHaveBeenCalledTimes(1);
      expect(resolverSeams.checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs a missing local FSM target through the normal runtime', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-missing-local-'));
    try {
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetCli({
        target: './missing.fsm.ts',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'auth'],
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runCliImpl).toHaveBeenCalledWith({
        fsmPath: './missing.fsm.ts',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--topic', 'auth'],
        inputUsageCommand: 'aharness run ./missing.fsm.ts',
      } satisfies RunCliOpts);
      expect(runInstalledCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs an installed bare command even when a same-named local file exists', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-shadow-'));
    try {
      await writeFile(path.join(cwd, 'build'), '');
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const resolverSeams = installedResolverSeams('@scope/tools', ['build']);

      const result = await runTargetCli({
        target: 'build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        ...resolverSeams,
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runInstalledCliImpl).toHaveBeenCalledWith({
        command: 'build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: [],
      } satisfies RunInstalledCliOptions);
      expect(runCliImpl).not.toHaveBeenCalled();
      expect(resolverSeams.readSnapshotImpl).toHaveBeenCalledTimes(1);
      expect(resolverSeams.checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs a local FSM target when an installed command has the same identity', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-local-wins-'));
    try {
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const readSnapshotImpl = vi.fn();
      const checkLockFingerprintImpl = vi.fn();

      const result = await runTargetCli({
        target: 'build.fsm.ts',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        readSnapshotImpl,
        checkLockFingerprintImpl,
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runCliImpl).toHaveBeenCalledWith({
        fsmPath: 'build.fsm.ts',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: [],
        inputUsageCommand: 'aharness run build.fsm.ts',
      } satisfies RunCliOpts);
      expect(runInstalledCliImpl).not.toHaveBeenCalled();
      expect(readSnapshotImpl).not.toHaveBeenCalled();
      expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not scan input flag values for local FSM files', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-input-scan-'));
    try {
      await writeFile(path.join(cwd, 'other.fsm.ts'), '');
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const resolverSeams = installedResolverSeams('@scope/tools', ['build']);

      const result = await runTargetCli({
        target: 'build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--spec', './other.fsm.ts'],
        ...resolverSeams,
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runInstalledCliImpl).toHaveBeenCalledWith({
        command: 'build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--spec', './other.fsm.ts'],
      } satisfies RunInstalledCliOptions);
      expect(runCliImpl).not.toHaveBeenCalled();
      expect(resolverSeams.readSnapshotImpl).toHaveBeenCalledTimes(1);
      expect(resolverSeams.checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails explicit relative non-FSM targets before local or installed execution', async () => {
    const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();
    const stderr = captureStream();

    const result = await runTargetCli({
      target: './workflow',
      cwd: process.cwd(),
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl,
      checkLockFingerprintImpl,
      runCliImpl,
      runInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('aharness run failed:');
    expect(stderr.text()).toContain('[fsm-target-invalid-local]');
    expect(stderr.text()).toContain("local FSM target './workflow' must end in .fsm.ts");
    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
    expect(runCliImpl).not.toHaveBeenCalled();
    expect(runInstalledCliImpl).not.toHaveBeenCalled();
  });

  it('fails absolute non-FSM targets before local or installed execution', async () => {
    const target = path.join(path.parse(process.cwd()).root, 'workflow');
    const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();
    const stderr = captureStream();

    const result = await runTargetCli({
      target,
      cwd: process.cwd(),
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl,
      checkLockFingerprintImpl,
      runCliImpl,
      runInstalledCliImpl,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('aharness run failed:');
    expect(stderr.text()).toContain('[fsm-target-invalid-local]');
    expect(stderr.text()).toContain(`local FSM target '${target}' must end in .fsm.ts`);
    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
    expect(runCliImpl).not.toHaveBeenCalled();
    expect(runInstalledCliImpl).not.toHaveBeenCalled();
  });
});

describe('aharness run target help dispatch', () => {
  it('routes .fsm.ts targets through local input help without checking file existence', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-help-local-'));
    try {
      const stdout = captureStream();
      const stderr = captureStream();
      const runLocalFsmInputHelpImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetHelpCli({
        target: './missing.fsm.ts',
        cwd,
        stdout: stdout.stream,
        stderr: stderr.stream,
        runLocalFsmInputHelpImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runLocalFsmInputHelpImpl).toHaveBeenCalledWith({
        cwd,
        target: './missing.fsm.ts',
        usage: 'aharness run ./missing.fsm.ts --help',
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(stderr.text()).toBe('');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns generic usage for installed-command-shaped help targets', async () => {
    const cases = ['build', '@scope/tools/build'];

    for (const target of cases) {
      const stdout = captureStream();
      const stderr = captureStream();
      const runLocalFsmInputHelpImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetHelpCli({
        target,
        cwd: process.cwd(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        runLocalFsmInputHelpImpl,
      });

      expect(result).toEqual({ exitCode: 2 });
      expect(runLocalFsmInputHelpImpl).not.toHaveBeenCalled();
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toContain('usage:');
    }
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
