import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { RunCliOpts, RunCliResult, RunPermissionMode } from './runCli.js';
import { runLocalFsmInputHelp } from './inputHelpCli.js';
import type { RunInstalledCliOptions } from './runInstalledCli.js';

export interface RunTargetCliOptions {
  readonly target: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly inputArgs?: ReadonlyArray<string>;
  readonly permissionMode?: RunPermissionMode;
  readonly runCliImpl?: (opts: RunCliOpts) => Promise<RunCliResult>;
  readonly runInstalledCliImpl?: (
    opts: RunInstalledCliOptions,
  ) => Promise<{ readonly exitCode: number }>;
  readonly statImpl?: typeof fs.stat;
}

export interface RunTargetHelpCliOptions {
  readonly target: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly runLocalFsmInputHelpImpl?: typeof runLocalFsmInputHelp;
}

export async function runTargetCli(
  opts: RunTargetCliOptions,
): Promise<{ readonly exitCode: number }> {
  const inputArgs = opts.inputArgs ?? [];
  if (await isExistingRegularFile(opts.cwd, opts.target, opts.statImpl ?? fs.stat)) {
    const runCliImpl = opts.runCliImpl ?? (await import('./runCli.js')).runCli;
    return runCliImpl({
      fsmPath: opts.target,
      cwd: opts.cwd,
      stdout: opts.stdout,
      stderr: opts.stderr,
      inputArgs,
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    });
  }

  const runInstalledCliImpl =
    opts.runInstalledCliImpl ?? (await import('./runInstalledCli.js')).runInstalledCli;
  return runInstalledCliImpl({
    command: opts.target,
    cwd: opts.cwd,
    stdout: opts.stdout,
    stderr: opts.stderr,
    inputArgs,
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
  });
}

export async function runTargetHelpCli(
  opts: RunTargetHelpCliOptions,
): Promise<{ readonly exitCode: number }> {
  if (!isLocalFsmHelpTarget(opts.target)) {
    return { exitCode: runTargetHelpUsage(opts.stderr) };
  }

  const runLocalFsmInputHelpImpl = opts.runLocalFsmInputHelpImpl ?? runLocalFsmInputHelp;
  return runLocalFsmInputHelpImpl({
    cwd: opts.cwd,
    target: opts.target,
    usage: `aharness run ${opts.target} --help`,
    stdout: opts.stdout,
    stderr: opts.stderr,
  });
}

async function isExistingRegularFile(
  cwd: string,
  target: string,
  statImpl: typeof fs.stat,
): Promise<boolean> {
  try {
    const stats = await statImpl(path.resolve(cwd, target));
    return stats.isFile();
  } catch {
    return false;
  }
}

function isLocalFsmHelpTarget(target: string): boolean {
  return target.endsWith('.fsm.ts') && !target.startsWith('-');
}

function runTargetHelpUsage(stderr: NodeJS.WritableStream): number {
  stderr.write(
    'usage:\n' + '  aharness run [--ask|--yolo] <file.fsm.ts|command> [--<flag> <value>]...\n',
  );
  return 2;
}
