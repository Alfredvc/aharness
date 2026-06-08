import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildInstalledFsmLoadOptions,
  classifyFsmTargetSyntax,
  resolveFsmTarget,
  type InstalledFsmTarget,
} from '../src/runtime/runTarget.js';
import * as cliFsmTarget from '../src/cli/fsmTarget.js';
import type {
  InstalledRuntimeSnapshot,
  InstallStoreDiagnostic,
  InstallStorePaths,
  InstallStoreResult,
  ReadInstalledRuntimeSnapshotOptions,
  TrustedCommandIndexEntry,
  TrustedCommandMetadata,
  TrustedCommandsFile,
  TrustedInstallRecord,
  TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('FSM target syntax classification', () => {
  it('keeps the CLI target module as a compatibility re-export', () => {
    expect(cliFsmTarget.buildInstalledFsmLoadOptions).toBe(buildInstalledFsmLoadOptions);
    expect(cliFsmTarget.classifyFsmTargetSyntax).toBe(classifyFsmTargetSyntax);
    expect(cliFsmTarget.resolveFsmTarget).toBe(resolveFsmTarget);
  });

  it('classifies local FSM syntax without filesystem checks', () => {
    const absoluteFsm = path.join(path.parse(process.cwd()).root, 'workflow.fsm.ts');

    expect(classifyFsmTargetSyntax('workflow.fsm.ts')).toBe('local');
    expect(classifyFsmTargetSyntax('./workflow.fsm.ts')).toBe('local');
    expect(classifyFsmTargetSyntax('../workflow.fsm.ts')).toBe('local');
    expect(classifyFsmTargetSyntax(absoluteFsm)).toBe('local');
  });

  it('classifies explicit local non-FSM syntax as invalid local', () => {
    const absoluteNonFsm = path.join(path.parse(process.cwd()).root, 'workflow');

    expect(classifyFsmTargetSyntax('./workflow')).toBe('invalid-local');
    expect(classifyFsmTargetSyntax('../workflow')).toBe('invalid-local');
    expect(classifyFsmTargetSyntax(absoluteNonFsm)).toBe('invalid-local');
  });

  it('classifies remaining tokens as installed candidates', () => {
    expect(classifyFsmTargetSyntax('build')).toBe('installed-candidate');
    expect(classifyFsmTargetSyntax('pkg/build')).toBe('installed-candidate');
    expect(classifyFsmTargetSyntax('@scope/tools/build')).toBe('installed-candidate');
  });
});

describe('FSM target resolution contracts', () => {
  it('resolves local FSM syntax as local targets', async () => {
    const absoluteFsm = path.join(path.parse(process.cwd()).root, 'workflow.fsm.ts');

    for (const token of [
      'workflow.fsm.ts',
      './workflow.fsm.ts',
      '../workflow.fsm.ts',
      absoluteFsm,
    ]) {
      await expect(resolveFsmTarget(token)).resolves.toEqual({
        kind: 'local',
        target: token,
      });
    }
  });

  it('rejects explicit local non-FSM syntax before installed-store dependencies', async () => {
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();
    const absoluteNonFsm = path.join(path.parse(process.cwd()).root, 'workflow');

    for (const token of ['./workflow', '../workflow', absoluteNonFsm]) {
      await expect(
        resolveFsmTarget(token, { readSnapshotImpl, checkLockFingerprintImpl }),
      ).resolves.toEqual({
        kind: 'invalid',
        diagnostics: [
          {
            code: 'fsm-target-invalid-local',
            commandName: token,
            message: `local FSM target '${token}' must end in .fsm.ts`,
          },
        ],
      });
    }

    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('rejects empty and flag-like targets before installed-store dependencies', async () => {
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();

    await expect(
      resolveFsmTarget('', { readSnapshotImpl, checkLockFingerprintImpl }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'fsm-target-invalid-token',
          commandName: '',
          message: 'FSM target must not be empty',
        },
      ],
    });
    await expect(
      resolveFsmTarget('--help', { readSnapshotImpl, checkLockFingerprintImpl }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'fsm-target-invalid-token',
          commandName: '--help',
          message: "FSM target '--help' must not be a flag",
        },
      ],
    });
    expect(classifyFsmTargetSyntax('build')).toBe('installed-candidate');

    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('resolves local FSM syntax before installed-store dependencies', async () => {
    const readSnapshotImpl = vi.fn();
    const checkLockFingerprintImpl = vi.fn();

    await expect(
      resolveFsmTarget('build.fsm.ts', { readSnapshotImpl, checkLockFingerprintImpl }),
    ).resolves.toEqual({
      kind: 'local',
      target: 'build.fsm.ts',
    });

    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('resolves local FSM syntax before installed commands with the same name', async () => {
    const install = installRecord('@scope/tools', {
      'build.fsm.ts': commandMetadata('build.fsm.ts', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    const readSnapshotImpl = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const checkLockFingerprintImpl = vi.fn(async () => ({
      ok: true as const,
      value: 'computed-lock',
    }));

    await expect(
      resolveFsmTarget('build.fsm.ts', { readSnapshotImpl, checkLockFingerprintImpl }),
    ).resolves.toEqual({
      kind: 'local',
      target: 'build.fsm.ts',
    });

    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('resolves regular non-FSM syntax through installed command resolution', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    const readSnapshotImpl = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const checkLockFingerprintImpl = vi.fn(async () => ({
      ok: true as const,
      value: 'computed-lock',
    }));

    await expect(
      resolveFsmTarget('build', { readSnapshotImpl, checkLockFingerprintImpl }),
    ).resolves.toMatchObject({
      kind: 'installed',
      identity: '@scope/tools/build',
      install,
      command: install.commands['build'],
      paths: snapshot.paths,
      entryFile: path.join(install.packageRoot, 'dist/build.fsm.js'),
      lockFingerprint: 'verified-lock',
    });

    expect(readSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves fully qualified installed candidates with fingerprint-checked entry files', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    const fingerprintChecks: Array<{ record: TrustedInstallRecord; paths: InstallStorePaths }> = [];

    const result = await resolveFsmTarget('@scope/tools/build', {
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async (record, paths) => {
        fingerprintChecks.push({ record, paths });
        return { ok: true, value: record.lockFingerprint };
      },
    });

    expect(result).toEqual({
      kind: 'installed',
      identity: '@scope/tools/build',
      install,
      command: install.commands['build'],
      paths: snapshot.paths,
      entryFile: path.join(install.packageRoot, 'dist/build.fsm.js'),
      lockFingerprint: 'verified-lock',
    });
    expect(fingerprintChecks).toEqual([{ record: install, paths: snapshot.paths }]);
  });

  it('resolves unique bare installed candidates with fingerprint-checked entry files', async () => {
    const install = installRecord('@scope/tools', {
      deploy: commandMetadata('deploy', 'fsms/deploy.fsm.ts'),
    });
    const snapshot = runtimeSnapshot([install]);

    await expect(
      resolveFsmTarget('deploy', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
        checkLockFingerprintImpl: async () => ({ ok: true, value: 'computed-lock' }),
      }),
    ).resolves.toEqual({
      kind: 'installed',
      identity: '@scope/tools/deploy',
      install,
      command: install.commands['deploy'],
      paths: snapshot.paths,
      entryFile: path.join(install.packageRoot, 'fsms/deploy.fsm.ts'),
      lockFingerprint: 'verified-lock',
    });
  });

  it('exposes trusted snapshot paths from the same snapshot used for fingerprint validation', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    const readSnapshotImpl = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    let checkedPaths: InstallStorePaths | undefined;

    const result = await resolveFsmTarget('@scope/tools/build', {
      readSnapshotImpl,
      checkLockFingerprintImpl: async (_record, paths) => {
        checkedPaths = paths;
        return { ok: true, value: 'computed-lock' };
      },
    });

    expect(result).toMatchObject({
      kind: 'installed',
      paths: snapshot.paths,
    });
    expect(result.kind === 'installed' ? result.paths : undefined).toBe(snapshot.paths);
    expect(checkedPaths).toBe(snapshot.paths);
    expect(readSnapshotImpl).toHaveBeenCalledTimes(1);
  });

  it('passes CLI environment seams to the snapshot reader', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    let snapshotOpts: ReadInstalledRuntimeSnapshotOptions | undefined;

    await resolveFsmTarget('@scope/tools/build', {
      env: { AHARNESS_HOME: '/custom/store' },
      homeDir: '/home/tester',
      readSnapshotImpl: async (opts) => {
        snapshotOpts = opts;
        return { ok: true, value: snapshot };
      },
      checkLockFingerprintImpl: async () => ({ ok: true, value: 'computed-lock' }),
    });

    expect(snapshotOpts).toEqual({
      env: { AHARNESS_HOME: '/custom/store' },
      homeDir: '/home/tester',
    });
  });

  it('returns snapshot-read diagnostics for installed candidates without throwing', async () => {
    const diagnostics = [diagnostic('trusted-json-read-failed')];

    await expect(
      resolveFsmTarget('build', {
        readSnapshotImpl: async () => ({ ok: false, diagnostics }),
      }),
    ).resolves.toEqual({ kind: 'invalid', diagnostics });
  });

  it('preserves package-only installed command diagnostics', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);

    await expect(
      resolveFsmTarget('@scope/tools', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'command-identity-package-only',
          commandName: '@scope/tools',
          message: "'@scope/tools' identifies a package, not a command",
        },
      ],
    });
  });

  it('preserves ambiguous bare command diagnostics with sorted qualified alternatives', async () => {
    const firstInstall = installRecord('@beta/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const secondInstall = installRecord('@alpha/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([firstInstall, secondInstall]);

    await expect(
      resolveFsmTarget('build', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'command-ambiguous',
          commandName: 'build',
          alternatives: ['@alpha/tools/build', '@beta/tools/build'],
          message:
            "command 'build' is ambiguous; use one of: @alpha/tools/build, @beta/tools/build",
        },
      ],
    });
  });

  it('preserves missing installed command diagnostics', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);

    await expect(
      resolveFsmTarget('deploy', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'command-not-found',
          commandName: 'deploy',
          message: "command 'deploy' is not installed",
        },
      ],
    });
  });

  it('returns malformed or incomplete snapshot diagnostics from the injected reader', async () => {
    const diagnostics = [
      {
        code: 'trusted-json-invalid',
        path: '/store/installs.json',
        message: 'trusted installs JSON is malformed',
      },
      {
        code: 'trusted-installs-unrecoverable',
        path: '/store/installs.json',
        message: 'trusted installs are the source of truth and cannot be recovered',
      },
    ];
    const checkLockFingerprintImpl = vi.fn();

    await expect(
      resolveFsmTarget('build', {
        readSnapshotImpl: async () => ({ ok: false, diagnostics }),
        checkLockFingerprintImpl,
      }),
    ).resolves.toEqual({ kind: 'invalid', diagnostics });

    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('returns command-resolution diagnostics for installed candidates without throwing', async () => {
    const snapshot = runtimeSnapshot([]);

    await expect(
      resolveFsmTarget('missing', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        expect.objectContaining({
          code: 'command-not-found',
          commandName: 'missing',
        }),
      ],
    });
  });

  it('preserves install-record mismatch diagnostics from command resolution', async () => {
    const snapshot: InstalledRuntimeSnapshot = {
      paths: {
        storeRoot: '/store',
        managedProjectRoot: '/store/packages',
        installsPath: '/store/installs.json',
        commandsPath: '/store/commands.json',
      },
      installs: installsFile(),
      commands: commandsFile({
        commands: {
          '@scope/tools/build': commandIndexEntry('@scope/tools', 'build', 'dist/build.fsm.js'),
        },
      }),
    };
    const checkLockFingerprintImpl = vi.fn();

    await expect(
      resolveFsmTarget('@scope/tools/build', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
        checkLockFingerprintImpl,
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'installed-command-install-record-missing',
          commandName: 'build',
          field: 'installs.@scope/tools',
          message:
            "command '@scope/tools/build' is indexed, but package " +
            "'@scope/tools' has no trusted install record",
        },
      ],
    });

    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('preserves command snapshot mismatch diagnostics from command resolution', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot: InstalledRuntimeSnapshot = {
      paths: {
        storeRoot: '/store',
        managedProjectRoot: '/store/packages',
        installsPath: '/store/installs.json',
        commandsPath: '/store/commands.json',
      },
      installs: installsFile({ installs: { '@scope/tools': install } }),
      commands: commandsFile({
        commands: {
          '@scope/tools/build': commandIndexEntry('@scope/tools', 'build', 'dist/other.fsm.js'),
        },
      }),
    };
    const checkLockFingerprintImpl = vi.fn();

    await expect(
      resolveFsmTarget('@scope/tools/build', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
        checkLockFingerprintImpl,
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      diagnostics: [
        {
          code: 'installed-command-install-snapshot-missing',
          commandName: 'build',
          field: 'installs.@scope/tools.commands.build',
          message:
            "command '@scope/tools/build' is indexed, but the trusted install record " +
            'does not contain a matching command snapshot',
        },
      ],
    });

    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('returns lock-fingerprint diagnostics for installed candidates without throwing', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    const diagnostics = [diagnostic('installed-lock-fingerprint-mismatch')];

    await expect(
      resolveFsmTarget('@scope/tools/build', {
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
        checkLockFingerprintImpl: async (): Promise<InstallStoreResult<string>> => ({
          ok: false,
          diagnostics,
        }),
      }),
    ).resolves.toEqual({ kind: 'invalid', diagnostics });
  });

  it('does not return load-ready installed target data when lock fingerprint checks fail', async () => {
    const install = installRecord('@scope/tools', {
      build: commandMetadata('build', 'dist/build.fsm.js'),
    });
    const snapshot = runtimeSnapshot([install]);
    const diagnostics = [
      {
        code: 'installed-lock-fingerprint-mismatch',
        field: 'lockFingerprint',
        message: 'installed package lock fingerprint changed',
      },
    ];

    const result = await resolveFsmTarget('@scope/tools/build', {
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      checkLockFingerprintImpl: async (): Promise<InstallStoreResult<string>> => ({
        ok: false,
        diagnostics,
      }),
    });

    expect(result).toEqual({ kind: 'invalid', diagnostics });
    expect(result.kind).not.toBe('installed');
  });

  it('defines the installed target result shape used by later resolvers', () => {
    const install: TrustedInstallRecord = {
      packageName: '@scope/tools',
      dependencyKey: '@scope/tools',
      requestedSpec: '^1.0.0',
      packageRoot: '/store/tools',
      packageVersion: '1.0.0',
      sourceIntentKey: 'npm:@scope/tools',
      lockFingerprint: 'lock-1',
      commands: {},
    };
    const command: TrustedCommandMetadata = {
      commandName: 'build',
      entry: 'dist/build.fsm.js',
    };
    const target: InstalledFsmTarget = {
      kind: 'installed',
      identity: '@scope/tools/build',
      install,
      command,
      paths: {
        storeRoot: '/store',
        managedProjectRoot: '/store/packages',
        installsPath: '/store/installs.json',
        commandsPath: '/store/commands.json',
      },
      entryFile: '/store/tools/dist/build.fsm.js',
      lockFingerprint: 'lock-1',
    };

    expect(target).toMatchObject({
      kind: 'installed',
      identity: '@scope/tools/build',
      install,
      command,
      paths: {
        storeRoot: '/store',
        managedProjectRoot: '/store/packages',
        installsPath: '/store/installs.json',
        commandsPath: '/store/commands.json',
      },
      entryFile: '/store/tools/dist/build.fsm.js',
      lockFingerprint: 'lock-1',
    });
  });

  it('builds installed loader options from resolved target metadata', () => {
    const install: TrustedInstallRecord = {
      packageName: '@scope/tools',
      dependencyKey: '@scope/tools',
      requestedSpec: '^1.0.0',
      packageRoot: '/store/tools',
      packageVersion: '1.0.0',
      sourceIntentKey: 'npm:@scope/tools',
      lockFingerprint: 'lock-1',
      commands: {},
    };
    const command: TrustedCommandMetadata = {
      commandName: 'build',
      entry: 'dist/build.fsm.js',
    };
    const target: InstalledFsmTarget = {
      kind: 'installed',
      identity: '@scope/tools/build',
      install,
      command,
      paths: {
        storeRoot: '/store',
        managedProjectRoot: '/store/packages',
        installsPath: '/store/installs.json',
        commandsPath: '/store/commands.json',
      },
      entryFile: '/store/tools/dist/build.fsm.js',
      lockFingerprint: 'lock-1',
    };

    expect(buildInstalledFsmLoadOptions(target)).toEqual({
      entryFile: '/store/tools/dist/build.fsm.js',
      packageName: '@scope/tools',
      commandName: 'build',
      packageRoot: '/store/tools',
      managedProjectRoot: '/store/packages',
      storeRoot: '/store',
      lockFingerprint: 'lock-1',
    });
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

function commandMetadata(
  commandName: string,
  entry = `fsms/${commandName}.fsm.ts`,
): TrustedInstallRecord['commands'][string] {
  return {
    commandName,
    entry,
  };
}

function commandIndexEntry(
  packageName: string,
  commandName: string,
  entry = `fsms/${commandName}.fsm.ts`,
): TrustedCommandIndexEntry {
  return {
    packageName,
    commandName,
    entry,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    lockFingerprint: 'verified-lock',
  };
}

function diagnostic(code: string): InstallStoreDiagnostic {
  return {
    code,
    message: `${code} message`,
  };
}
