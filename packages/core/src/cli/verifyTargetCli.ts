import { resolveFsmTarget, type ResolveFsmTargetOptions } from './fsmTarget.js';
import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';
import { runVerifyCli, type RunVerifyCliOpts, type RunVerifyCliResult } from './verifyCli.js';
import { runVerifyInstalledCli, type RunVerifyInstalledCliOptions } from './verifyInstalledCli.js';

export interface RunVerifyTargetCliOptions {
  readonly target: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: ResolveFsmTargetOptions['env'];
  readonly homeDir?: ResolveFsmTargetOptions['homeDir'];
  readonly readSnapshotImpl?: ResolveFsmTargetOptions['readSnapshotImpl'];
  readonly checkLockFingerprintImpl?: ResolveFsmTargetOptions['checkLockFingerprintImpl'];
  readonly runVerifyCliImpl?: (opts: RunVerifyCliOpts) => Promise<RunVerifyCliResult>;
  readonly runVerifyInstalledCliImpl?: (
    opts: RunVerifyInstalledCliOptions,
  ) => Promise<{ readonly exitCode: number }>;
}

export async function runVerifyTargetCli(
  opts: RunVerifyTargetCliOptions,
): Promise<{ readonly exitCode: number }> {
  const resolved = await resolveFsmTarget(opts.target, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.readSnapshotImpl !== undefined ? { readSnapshotImpl: opts.readSnapshotImpl } : {}),
    ...(opts.checkLockFingerprintImpl !== undefined
      ? { checkLockFingerprintImpl: opts.checkLockFingerprintImpl }
      : {}),
  });

  if (resolved.kind === 'invalid') {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', resolved.diagnostics);
    const isPackageOnlyTarget = resolved.diagnostics.some(
      (diagnostic) => diagnostic.code === 'command-identity-package-only',
    );
    if (isPackageOnlyTarget) {
      opts.stderr.write(
        '  package-only verification was removed; specify <package>/<command> or a unique bare command name.\n',
      );
    }
    return { exitCode: 1 };
  }

  if (resolved.kind === 'local') {
    const runVerifyCliImpl = opts.runVerifyCliImpl ?? runVerifyCli;
    return runVerifyCliImpl({
      fsmPath: resolved.target,
      repoRoot: opts.cwd,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      log: (line) => opts.stderr.write(`${line}\n`),
    });
  }

  const runVerifyInstalledCliImpl = opts.runVerifyInstalledCliImpl ?? runVerifyInstalledCli;
  return runVerifyInstalledCliImpl({
    target: opts.target,
    cwd: opts.cwd,
    stdout: opts.stdout,
    stderr: opts.stderr,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  });
}
