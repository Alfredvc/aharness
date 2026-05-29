import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runUninstallCli } from '../src/cli/uninstallCli.js';
import {
  resolveInstallStorePaths,
  uninstallPackage,
  writeTrustedJson,
  type InstallStorePaths,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
  type UninstallNpmRunner,
} from '../src/installStore/index.js';

describe('aharness uninstall trusted mutation', () => {
  let storeRoot: string;
  let paths: InstallStorePaths;

  beforeEach(async () => {
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-uninstall-cli-'));
    paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
  });

  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('uninstalls by exact package name using the trusted dependency key', async () => {
    const scoped = installRecord('@scope/tools', {
      build: commandMetadata('build'),
      deploy: commandMetadata('deploy'),
    });
    const other = installRecord('other', {
      plan: commandMetadata('plan'),
    });
    await writeTrustedPair({
      installs: installsFile({
        generation: 'gen-1',
        installs: {
          '@scope/tools': { ...scoped, dependencyKey: 'tools-alias' },
          other,
        },
      }),
      commands: commandsFile({
        generation: 'gen-1',
        commands: {
          '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
          '@scope/tools/deploy': commandIndexEntry('@scope/tools', 'deploy'),
          'other/plan': commandIndexEntry('other', 'plan'),
        },
      }),
    });
    const calls: Parameters<UninstallNpmRunner>[0][] = [];

    const result = await uninstallPackage({
      packageName: '@scope/tools',
      cwd: '/workspace',
      paths,
      generationId: () => 'gen-2',
      npmUninstall: async (opts) => {
        calls.push(opts);
        return { ok: true, value: { stdout: '', stderr: '' } };
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        packageName: '@scope/tools',
        removedCommandCount: 2,
        generation: 'gen-2',
      },
    });
    expect(calls).toEqual([
      {
        managedProjectRoot: paths.managedProjectRoot,
        dependencyKey: 'tools-alias',
      },
    ]);
    const installs = await readTrustedInstalls();
    const commands = await readTrustedCommands();
    expect(installs).toEqual(
      installsFile({
        generation: 'gen-2',
        installs: {
          other,
        },
      }),
    );
    expect(commands).toEqual(
      commandsFile({
        generation: 'gen-2',
        commands: {
          'other/plan': commandIndexEntry('other', 'plan'),
        },
      }),
    );
  });

  it('fails unknown packages without spawning npm or writing trusted files', async () => {
    await writeTrustedPair({
      installs: installsFile(),
      commands: commandsFile(),
    });
    const beforeInstalls = await readFile(paths.installsPath, 'utf8');
    const beforeCommands = await readFile(paths.commandsPath, 'utf8');
    const npmUninstall = vi.fn<UninstallNpmRunner>();

    const result = await uninstallPackage({
      packageName: 'missing',
      cwd: '/workspace',
      paths,
      npmUninstall,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'installed-package-not-found',
          field: 'installs.missing',
        }),
      ]);
    }
    expect(npmUninstall).not.toHaveBeenCalled();
    await expect(readFile(paths.installsPath, 'utf8')).resolves.toBe(beforeInstalls);
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe(beforeCommands);
  });

  it('preserves trusted files when npm uninstall fails', async () => {
    await writeTrustedPairForSinglePackage();
    const beforeInstalls = await readFile(paths.installsPath, 'utf8');
    const beforeCommands = await readFile(paths.commandsPath, 'utf8');

    const result = await uninstallPackage({
      packageName: 'tools',
      cwd: '/workspace',
      paths,
      npmUninstall: async () => ({
        ok: false,
        diagnostics: [
          {
            code: 'npm-uninstall-failed',
            message: 'npm uninstall exited with status 1',
          },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'npm-uninstall-failed' }),
      ]);
    }
    await expect(readFile(paths.installsPath, 'utf8')).resolves.toBe(beforeInstalls);
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe(beforeCommands);
  });

  it('writes valid empty trusted files when uninstall removes the last package', async () => {
    await writeTrustedPairForSinglePackage();

    const result = await uninstallPackage({
      packageName: 'tools',
      cwd: '/workspace',
      paths,
      generationId: () => 'gen-empty',
      npmUninstall: async () => ({ ok: true, value: { stdout: '', stderr: '' } }),
    });

    expect(result.ok).toBe(true);
    await expect(readTrustedInstalls()).resolves.toEqual(installsFile({ generation: 'gen-empty' }));
    await expect(readTrustedCommands()).resolves.toEqual(commandsFile({ generation: 'gen-empty' }));
  });

  it('ignores stale or malformed commands.json because installs.json is the source of truth', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(
      paths.installsPath,
      installsFile({
        installs: {
          tools: installRecord('tools', { build: commandMetadata('build') }),
        },
      }),
    );
    await writeFile(paths.commandsPath, '{ nope');

    const result = await uninstallPackage({
      packageName: 'tools',
      cwd: '/workspace',
      paths,
      generationId: () => 'gen-recovered',
      npmUninstall: async () => ({ ok: true, value: { stdout: '', stderr: '' } }),
    });

    expect(result.ok).toBe(true);
    await expect(readTrustedInstalls()).resolves.toEqual(
      installsFile({ generation: 'gen-recovered' }),
    );
    await expect(readTrustedCommands()).resolves.toEqual(
      commandsFile({ generation: 'gen-recovered' }),
    );
  });

  it('fails malformed installs.json without attempting npm mutation', async () => {
    await mkdir(storeRoot, { recursive: true });
    await writeFile(paths.installsPath, '{ nope');
    const npmUninstall = vi.fn<UninstallNpmRunner>();

    const result = await uninstallPackage({
      packageName: 'tools',
      cwd: '/workspace',
      paths,
      npmUninstall,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-json-invalid',
          path: paths.installsPath,
        }),
      ]);
    }
    expect(npmUninstall).not.toHaveBeenCalled();
  });

  it('reports that recovery can repair a commands write failure after installs were written', async () => {
    await writeTrustedPairForSinglePackage();

    const result = await uninstallPackage({
      packageName: 'tools',
      cwd: '/workspace',
      paths,
      generationId: () => 'gen-after-install-write',
      npmUninstall: async () => ({ ok: true, value: { stdout: '', stderr: '' } }),
      writeTrustedJsonImpl: async (filePath, value) => {
        if (filePath === paths.commandsPath) {
          return {
            ok: false,
            diagnostics: [
              {
                code: 'trusted-json-write-failed',
                path: filePath,
                message: 'write failed',
              },
            ],
          };
        }
        return writeTrustedJson(filePath, value);
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'trusted-json-write-failed' }),
        expect.objectContaining({ code: 'command-index-write-after-installs-failed' }),
      ]);
    }
    await expect(readTrustedInstalls()).resolves.toEqual(
      installsFile({ generation: 'gen-after-install-write' }),
    );
  });

  it('formats successful and failed uninstalls for the public CLI', async () => {
    await writeTrustedPairForSinglePackage();
    const stdout = captureStream();
    const stderr = captureStream();

    const success = await runUninstallCli({
      packageName: 'tools',
      cwd: '/workspace',
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { AHARNESS_HOME: storeRoot },
      npmUninstall: async () => ({ ok: true, value: { stdout: '', stderr: '' } }),
    });

    expect(success).toEqual({ exitCode: 0 });
    expect(stdout.text()).toContain('aharness uninstall: uninstalled tools (1 command removed)');
    expect(stderr.text()).toBe('');

    const failedStdout = captureStream();
    const failedStderr = captureStream();
    const failure = await runUninstallCli({
      packageName: 'tools',
      cwd: '/workspace',
      stdout: failedStdout.stream,
      stderr: failedStderr.stream,
      env: { AHARNESS_HOME: storeRoot },
      npmUninstall: async () => ({ ok: true, value: { stdout: '', stderr: '' } }),
    });

    expect(failure).toEqual({ exitCode: 1 });
    expect(failedStdout.text()).toBe('');
    expect(failedStderr.text()).toContain('aharness uninstall failed:');
    expect(failedStderr.text()).toContain('[installed-package-not-found]');
  });

  async function writeTrustedPair(opts: {
    readonly installs: TrustedInstallsFile;
    readonly commands: TrustedCommandsFile;
  }): Promise<void> {
    await mkdir(storeRoot, { recursive: true });
    await writeJson(paths.installsPath, opts.installs);
    await writeJson(paths.commandsPath, opts.commands);
  }

  async function writeTrustedPairForSinglePackage(): Promise<void> {
    await writeTrustedPair({
      installs: installsFile({
        installs: {
          tools: installRecord('tools', { build: commandMetadata('build') }),
        },
      }),
      commands: commandsFile({
        commands: {
          'tools/build': commandIndexEntry('tools', 'build'),
        },
      }),
    });
  }

  async function readTrustedInstalls(): Promise<TrustedInstallsFile> {
    return (await readJson(paths.installsPath)) as TrustedInstallsFile;
  }

  async function readTrustedCommands(): Promise<TrustedCommandsFile> {
    return (await readJson(paths.commandsPath)) as TrustedCommandsFile;
  }
});

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
    readonly commands?: TrustedCommandsFile['commands'];
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

function commandIndexEntry(
  packageName: string,
  commandName: string,
): TrustedCommandsFile['commands'][string] {
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

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
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
