import * as path from 'node:path';

import {
  checkInstalledLockFingerprint,
  readInstalledRuntimeSnapshot,
  resolveInstalledCommand,
  type InstalledRuntimeSnapshot,
  type InstallStorePaths,
  type InstallStoreResult,
  type TrustedCommandMetadata,
  type TrustedInstallRecord,
} from '../installStore/index.js';
import { loadInstalledFsm } from '../loader/index.js';
import { verify } from '../verify/index.js';

import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';
import { formatVerifyIssue } from './verifyIssueFormat.js';

export interface RunVerifyInstalledCliOptions {
  readonly target: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly readSnapshotImpl?: () => Promise<InstallStoreResult<InstalledRuntimeSnapshot>>;
  readonly checkLockFingerprintImpl?: (
    record: TrustedInstallRecord,
    paths: InstallStorePaths,
  ) => Promise<InstallStoreResult<string>>;
  readonly loadInstalledFsmImpl?: typeof loadInstalledFsm;
  readonly verifyImpl?: typeof verify;
}

export async function runVerifyInstalledCli(
  opts: RunVerifyInstalledCliOptions,
): Promise<{ readonly exitCode: number }> {
  void opts.cwd;
  const snapshot = await (opts.readSnapshotImpl
    ? opts.readSnapshotImpl()
    : readInstalledRuntimeSnapshot({
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      }));
  if (!snapshot.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', snapshot.diagnostics);
    return { exitCode: 1 };
  }

  return verifyCommand(opts.target, snapshot.value, opts);
}

async function verifyCommand(
  target: string,
  snapshot: InstalledRuntimeSnapshot,
  opts: RunVerifyInstalledCliOptions,
): Promise<{ readonly exitCode: number }> {
  const command = resolveInstalledCommand(target, snapshot);
  if (!command.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', command.diagnostics);
    return { exitCode: 1 };
  }
  const fingerprint = await (opts.checkLockFingerprintImpl ?? checkInstalledLockFingerprint)(
    command.value.install,
    snapshot.paths,
  );
  if (!fingerprint.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', fingerprint.diagnostics);
    return { exitCode: 1 };
  }
  return verifyOneCommand({
    identity: command.value.identity,
    install: command.value.install,
    command: command.value.command,
    snapshot,
    opts,
  });
}

async function verifyOneCommand(args: {
  readonly identity: string;
  readonly install: TrustedInstallRecord;
  readonly command: TrustedCommandMetadata;
  readonly snapshot: InstalledRuntimeSnapshot;
  readonly opts: RunVerifyInstalledCliOptions;
}): Promise<{ readonly exitCode: number }> {
  const entryFile = path.join(args.install.packageRoot, args.command.entry);
  const loadInstalledFsmImpl = args.opts.loadInstalledFsmImpl ?? loadInstalledFsm;
  const verifyImpl = args.opts.verifyImpl ?? verify;
  let loaded: Awaited<ReturnType<typeof loadInstalledFsm>>;
  try {
    loaded = await loadInstalledFsmImpl({
      entryFile,
      packageName: args.install.packageName,
      commandName: args.command.commandName,
      packageRoot: args.install.packageRoot,
      managedProjectRoot: args.snapshot.paths.managedProjectRoot,
      storeRoot: args.snapshot.paths.storeRoot,
      lockFingerprint: args.install.lockFingerprint,
    });
  } catch (err) {
    args.opts.stderr.write(`aharness verify failed:\n`);
    args.opts.stderr.write(
      `  - ${args.identity}: [installed-command-load-failed] ${errorMessage(err)}\n`,
    );
    return { exitCode: 1 };
  }

  const result = verifyImpl(loaded.machine, loaded.sidecar, loaded.issues, {
    skillEnv: {
      fsmFileDir: path.dirname(entryFile),
      repoRoot: args.install.packageRoot,
    },
    skillOriginManifest: loaded.skillOriginManifest,
    sourceLocations: loaded.sourceLocations,
  });
  if (result.ok) {
    for (const issue of result.warnings) {
      args.opts.stderr.write(
        `${formatVerifyIssue(issue, { sourceLocations: loaded.sourceLocations })}\n`,
      );
    }
    args.opts.stdout.write(
      `verify: ok (${args.identity}, ${String(result.warnings.length)} warnings)\n`,
    );
    return { exitCode: 0 };
  }

  for (const issue of result.issues) {
    args.opts.stderr.write(
      `${formatVerifyIssue(issue, { sourceLocations: loaded.sourceLocations })}\n`,
    );
  }
  return { exitCode: 1 };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
