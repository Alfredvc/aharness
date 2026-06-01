import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { runCli, type RunCliOpts, type RunCliResult, type RunPermissionMode } from './runCli.js';
import { runInstalledCli, type RunInstalledCliOptions } from './runInstalledCli.js';

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

export async function runTargetCli(
  opts: RunTargetCliOptions,
): Promise<{ readonly exitCode: number }> {
  const inputArgs = opts.inputArgs ?? [];
  if (await isExistingRegularFile(opts.cwd, opts.target, opts.statImpl ?? fs.stat)) {
    const runCliImpl = opts.runCliImpl ?? runCli;
    return runCliImpl({
      fsmPath: opts.target,
      cwd: opts.cwd,
      stdout: opts.stdout,
      stderr: opts.stderr,
      inputArgs,
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    });
  }

  const runInstalledCliImpl = opts.runInstalledCliImpl ?? runInstalledCli;
  return runInstalledCliImpl({
    command: opts.target,
    cwd: opts.cwd,
    stdout: opts.stdout,
    stderr: opts.stderr,
    inputArgs,
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
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
