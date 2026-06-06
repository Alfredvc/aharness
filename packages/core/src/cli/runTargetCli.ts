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
  readonly noOpen?: boolean;
  readonly runCliImpl?: (opts: RunCliOpts) => Promise<RunCliResult>;
  readonly runInstalledCliImpl?: (
    opts: RunInstalledCliOptions,
  ) => Promise<{ readonly exitCode: number }>;
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
  if (isLocalRunTarget(opts.target)) {
    const runCliImpl = opts.runCliImpl ?? (await import('./runCli.js')).runCli;
    return runCliImpl({
      fsmPath: opts.target,
      cwd: opts.cwd,
      stdout: opts.stdout,
      stderr: opts.stderr,
      inputArgs,
      inputUsageCommand: `aharness run ${opts.target}`,
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.noOpen ? { noOpen: true } : {}),
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
    ...(opts.noOpen ? { noOpen: true } : {}),
  });
}

export async function runTargetHelpCli(
  opts: RunTargetHelpCliOptions,
): Promise<{ readonly exitCode: number }> {
  if (!isLocalRunTarget(opts.target)) {
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

function isLocalRunTarget(target: string): boolean {
  return target.endsWith('.fsm.ts') && !target.startsWith('-');
}

function runTargetHelpUsage(stderr: NodeJS.WritableStream): number {
  stderr.write(
    'usage:\n' +
      '  aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...\n',
  );
  return 2;
}
