import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runListInstalledCli } from '../src/cli/listInstalledCli.js';
import {
  computeLockFingerprint,
  resolveInstallStorePaths,
  type InstalledRuntimeSnapshot,
  type InstallStorePaths,
  type TrustedCommandIndexEntry,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('aharness list installed packages', () => {
  it('prints the exact empty-store message for a valid empty snapshot', async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const result = await runListInstalledCli({
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({ ok: true, value: runtimeSnapshot([]) }),
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(stdout.text()).toBe('aharness list: no installed packages\n');
    expect(stderr.text()).toBe('');
  });

  it('prints packages and commands sorted with descriptions and collisions', async () => {
    const stdout = captureStream();
    const snapshot = runtimeSnapshot([
      installRecord('zeta', {
        build: commandMetadata('build', 'Build zeta'),
      }),
      installRecord('@scope/tools', {
        build: commandMetadata('build', 'Build scoped tools'),
        deploy: commandMetadata('deploy'),
      }),
    ]);

    const result = await runListInstalledCli({
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: captureStream().stream,
      readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
    });

    expect(result).toEqual({ exitCode: 0 });
    const lines = stdout.text().split('\n').filter(Boolean);
    expect(lines).toEqual([
      'aharness list:',
      '@scope/tools 1.2.3',
      '  build  Build scoped tools',
      '  deploy',
      'zeta 1.2.3',
      '  build  Build zeta',
      'bare command collisions:',
      '  build:',
      '    @scope/tools/build',
      '    zeta/build',
    ]);
  });

  it('does not load, verify, or check fingerprints while listing', async () => {
    const readSnapshotImpl = vi.fn(async () => ({
      ok: true as const,
      value: runtimeSnapshot([
        installRecord('@scope/tools', {
          build: commandMetadata('build'),
        }),
      ]),
    }));

    const result = await runListInstalledCli({
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      readSnapshotImpl,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(readSnapshotImpl).toHaveBeenCalledTimes(1);
  });

  it('does not keep trusted store reads open after listing a snapshot', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-list-no-read-lock-'));
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

      const result = await runListInstalledCli({
        cwd: '/workspace',
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        readSnapshotImpl: async () => ({ ok: true, value: snapshot }),
      });
      await writeFile(snapshot.paths.commandsPath, '{"rewritten":true}\n');

      expect(result).toEqual({ exitCode: 0 });
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('lists commands after recovering a malformed command index from real trusted files', async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-list-recovered-index-'));
    try {
      const paths = await writeRealTrustedStore(storeRoot);
      const stdout = captureStream();
      const stderr = captureStream();

      const result = await runListInstalledCli({
        cwd: '/workspace',
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { AHARNESS_HOME: storeRoot },
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(stderr.text()).toBe('');
      expect(stdout.text()).toContain('@scope/tools 1.2.3');
      expect(stdout.text()).toContain('  build');
      await expect(readFile(paths.commandsPath, 'utf8')).resolves.toContain('@scope/tools/build');
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('formats unrecoverable trusted snapshot diagnostics as list failures', async () => {
    const stderr = captureStream();

    const result = await runListInstalledCli({
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({
        ok: false,
        diagnostics: [
          {
            code: 'trusted-installs-unrecoverable',
            path: '/store/installs.json',
            message: 'installs.json is malformed',
          },
        ],
      }),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('aharness list failed:');
    expect(stderr.text()).toContain('trusted-installs-unrecoverable');
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

function commandMetadata(
  commandName: string,
  description?: string,
): TrustedInstallRecord['commands'][string] {
  return {
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
    ...(description !== undefined ? { description } : {}),
  };
}

async function writeRealTrustedStore(storeRoot: string): Promise<InstallStorePaths> {
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
    lockFingerprint: fingerprint.value,
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
  await writeFile(paths.commandsPath, '{ nope');
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
