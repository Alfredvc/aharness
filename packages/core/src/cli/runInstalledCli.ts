import { loadInstalledFsm } from '../loader/index.js';
import {
  buildInstalledFsmLoadOptions,
  resolveInstalledFsmTarget,
  type ResolveFsmTargetOptions,
} from '../runtime/runTarget.js';

import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';
import {
  runCli,
  type RunCliResult,
  type RunCliRuntimeOpts,
  type RunPermissionMode,
} from './runCli.js';

export interface RunInstalledCliOptions {
  readonly command: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly inputArgs?: ReadonlyArray<string>;
  readonly permissionMode?: RunPermissionMode;
  readonly noOpen?: boolean;
  readonly env?: ResolveFsmTargetOptions['env'];
  readonly homeDir?: ResolveFsmTargetOptions['homeDir'];
  readonly readSnapshotImpl?: ResolveFsmTargetOptions['readSnapshotImpl'];
  readonly checkLockFingerprintImpl?: ResolveFsmTargetOptions['checkLockFingerprintImpl'];
  readonly loadInstalledFsmImpl?: typeof loadInstalledFsm;
  readonly runCliImpl?: (opts: RunCliRuntimeOpts) => Promise<RunCliResult>;
}

export async function runInstalledCli(
  opts: RunInstalledCliOptions,
): Promise<{ readonly exitCode: number }> {
  const resolved = await resolveInstalledFsmTarget(opts.command, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.readSnapshotImpl !== undefined ? { readSnapshotImpl: opts.readSnapshotImpl } : {}),
    ...(opts.checkLockFingerprintImpl !== undefined
      ? { checkLockFingerprintImpl: opts.checkLockFingerprintImpl }
      : {}),
  });
  if (resolved.kind === 'invalid') {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness run failed', resolved.diagnostics);
    return { exitCode: 1 };
  }

  const loadInstalledFsmImpl = opts.loadInstalledFsmImpl ?? loadInstalledFsm;
  const runCliImpl = opts.runCliImpl ?? runCli;
  const loadFsmImpl: RunCliRuntimeOpts['loadFsmImpl'] = async () =>
    loadInstalledFsmImpl(buildInstalledFsmLoadOptions(resolved));

  return runCliImpl({
    fsmPath: resolved.entryFile,
    runTargetLabel: opts.command,
    cwd: opts.cwd,
    stdout: opts.stdout,
    stderr: opts.stderr,
    inputArgs: opts.inputArgs ?? [],
    inputUsageCommand: `aharness run ${opts.command}`,
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.noOpen ? { noOpen: true } : {}),
    verify: () => Promise.resolve({ exitCode: 0 }),
    loadFsmImpl,
  });
}
