import { spawn } from 'node:child_process';

import type { InstallStoreDiagnostic, InstallStoreResult } from './types.js';
import { resolveLocalDirectorySource } from './sourceIntent.js';

export interface NpmSpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd: string;
    readonly shell: false;
  };
}

export interface NpmSpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type NpmSpawn = (invocation: NpmSpawnInvocation) => Promise<NpmSpawnResult>;

export interface RunNpmInstallOptions {
  readonly managedProjectRoot: string;
  readonly cwd: string;
  readonly source: string;
  readonly spawn?: NpmSpawn;
}

export interface RunNpmUninstallOptions {
  readonly managedProjectRoot: string;
  readonly dependencyKey: string;
  readonly spawn?: NpmSpawn;
}

export interface NpmInstallSuccess {
  readonly stdout: string;
  readonly stderr: string;
}

export interface NpmUninstallSuccess {
  readonly stdout: string;
  readonly stderr: string;
}

export type InstallNpmRunner = (
  opts: Omit<RunNpmInstallOptions, 'spawn'>,
) => Promise<InstallStoreResult<NpmInstallSuccess>>;

export type UninstallNpmRunner = (
  opts: Omit<RunNpmUninstallOptions, 'spawn'>,
) => Promise<InstallStoreResult<NpmUninstallSuccess>>;

export async function runNpmInstall(
  opts: RunNpmInstallOptions,
): Promise<InstallStoreResult<NpmInstallSuccess>> {
  const localDirectory = await resolveLocalDirectorySource({ source: opts.source, cwd: opts.cwd });
  const installSource = localDirectory ?? opts.source;
  const args = [
    'install',
    '--save-prod',
    ...(localDirectory ? ['--install-links'] : []),
    '--',
    installSource,
  ];
  const spawnImpl = opts.spawn ?? spawnProcess;
  let result: NpmSpawnResult;
  try {
    result = await spawnImpl({
      command: 'npm',
      args,
      options: {
        cwd: opts.managedProjectRoot,
        shell: false,
      },
    });
  } catch (err) {
    return failure({
      code: 'npm-install-spawn-failed',
      message: `could not start npm install: ${errorMessage(err)}`,
    });
  }

  if (result.status !== 0) {
    return failure({
      code: 'npm-install-failed',
      message:
        `npm install exited with status ${String(result.status)} for '${opts.source}'` +
        (result.stderr ? `: ${result.stderr.trim()}` : ''),
    });
  }

  return {
    ok: true,
    value: {
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

export async function runNpmUninstall(
  opts: RunNpmUninstallOptions,
): Promise<InstallStoreResult<NpmUninstallSuccess>> {
  const spawnImpl = opts.spawn ?? spawnProcess;
  let result: NpmSpawnResult;
  try {
    result = await spawnImpl({
      command: 'npm',
      args: ['uninstall', '--save', opts.dependencyKey],
      options: {
        cwd: opts.managedProjectRoot,
        shell: false,
      },
    });
  } catch (err) {
    return failure({
      code: 'npm-uninstall-spawn-failed',
      message: `could not start npm uninstall: ${errorMessage(err)}`,
    });
  }

  if (result.status !== 0) {
    return failure({
      code: 'npm-uninstall-failed',
      message:
        `npm uninstall exited with status ${String(result.status)} for '${opts.dependencyKey}'` +
        (result.stderr ? `: ${result.stderr.trim()}` : ''),
    });
  }

  return {
    ok: true,
    value: {
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

function spawnProcess(invocation: NpmSpawnInvocation): Promise<NpmSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.options.cwd,
      shell: invocation.options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function failure(diagnostic: InstallStoreDiagnostic): InstallStoreResult<never> {
  return { ok: false, diagnostics: [diagnostic] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
