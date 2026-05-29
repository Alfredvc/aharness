import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runListInstalledCli } from '../src/cli/listInstalledCli.js';
import type {
  InstalledRuntimeSnapshot,
  TrustedCommandIndexEntry,
  TrustedInstallRecord,
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

  it('formats stale or malformed trusted snapshot diagnostics as list failures', async () => {
    const stderr = captureStream();

    const result = await runListInstalledCli({
      cwd: '/workspace',
      stdout: captureStream().stream,
      stderr: stderr.stream,
      readSnapshotImpl: async () => ({
        ok: false,
        diagnostics: [
          {
            code: 'command-index-generation-mismatch',
            field: 'generation',
            message: 'commands.json is stale',
          },
        ],
      }),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('aharness list failed:');
    expect(stderr.text()).toContain('command-index-generation-mismatch');
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
