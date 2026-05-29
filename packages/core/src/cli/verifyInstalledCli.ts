import * as path from 'node:path';

import {
  checkInstalledLockFingerprint,
  parseCommandIdentity,
  readInstalledRuntimeSnapshot,
  resolveInstalledCommand,
  resolveInstalledPackage,
  type InstalledRuntimeSnapshot,
  type InstallStorePaths,
  type InstallStoreResult,
  type TrustedCommandMetadata,
  type TrustedInstallRecord,
} from '../installStore/index.js';
import { loadInstalledFsm } from '../loader/index.js';
import { verify, type VerifyIssue } from '../verify/index.js';

import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';

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

  const packageResult = resolveInstalledPackage(opts.target, snapshot.value);
  if (packageResult.ok) {
    return verifyPackage(packageResult.value.install, snapshot.value, opts);
  }

  const parsed = parseCommandIdentity(opts.target);
  if (parsed.ok && parsed.value.kind === 'qualified') {
    const command = resolveInstalledCommand(opts.target, snapshot.value);
    if (!command.ok) {
      writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', command.diagnostics);
      return { exitCode: 1 };
    }
    const fingerprint = await (opts.checkLockFingerprintImpl ?? checkInstalledLockFingerprint)(
      command.value.install,
      snapshot.value.paths,
    );
    if (!fingerprint.ok) {
      writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', fingerprint.diagnostics);
      return { exitCode: 1 };
    }
    return verifyOneCommand({
      identity: command.value.identity,
      install: command.value.install,
      command: command.value.command,
      snapshot: snapshot.value,
      opts,
    });
  }

  writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', packageResult.diagnostics);
  return { exitCode: 1 };
}

async function verifyPackage(
  install: TrustedInstallRecord,
  snapshot: InstalledRuntimeSnapshot,
  opts: RunVerifyInstalledCliOptions,
): Promise<{ readonly exitCode: number }> {
  const fingerprint = await (opts.checkLockFingerprintImpl ?? checkInstalledLockFingerprint)(
    install,
    snapshot.paths,
  );
  if (!fingerprint.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness verify failed', fingerprint.diagnostics);
    return { exitCode: 1 };
  }

  let exitCode = 0;
  const commands = Object.values(install.commands).sort((a, b) =>
    a.commandName.localeCompare(b.commandName),
  );
  for (const command of commands) {
    const result = await verifyOneCommand({
      identity: `${install.packageName}/${command.commandName}`,
      install,
      command,
      snapshot,
      opts,
    });
    if (result.exitCode !== 0) exitCode = 1;
  }
  return { exitCode };
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
  });
  if (result.ok) {
    args.opts.stdout.write(
      `verify: ok (${args.identity}, ${String(result.warnings.length)} warnings)\n`,
    );
    return { exitCode: 0 };
  }

  for (const issue of result.issues) {
    args.opts.stderr.write(`${formatVerifyIssue(issue)}\n`);
  }
  return { exitCode: 1 };
}

function formatVerifyIssue(issue: VerifyIssue): string {
  return `[${issue.severity}] ${issue.check} (${issue.stateId}): ${issue.message}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
