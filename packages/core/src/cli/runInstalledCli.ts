import * as path from 'node:path';

import {
  checkInstalledLockFingerprint,
  readInstalledRuntimeSnapshot,
  resolveInstalledCommand,
  type InstalledRuntimeSnapshot,
  type InstallStorePaths,
  type InstallStoreResult,
  type TrustedInstallRecord,
} from '../installStore/index.js';
import { loadInstalledFsm } from '../loader/index.js';

import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';
import { runCliForTest, type RunCliForTestOpts, type RunPermissionMode } from './runCli.js';

export interface RunInstalledCliOptions {
  readonly command: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly inputArgs?: ReadonlyArray<string>;
  readonly permissionMode?: RunPermissionMode;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly readSnapshotImpl?: () => Promise<InstallStoreResult<InstalledRuntimeSnapshot>>;
  readonly checkLockFingerprintImpl?: (
    record: TrustedInstallRecord,
    paths: InstallStorePaths,
  ) => Promise<InstallStoreResult<string>>;
  readonly loadInstalledFsmImpl?: typeof loadInstalledFsm;
  readonly runCliImpl?: (opts: RunCliForTestOpts) => Promise<{ readonly exitCode: number }>;
}

export async function runInstalledCli(
  opts: RunInstalledCliOptions,
): Promise<{ readonly exitCode: number }> {
  const snapshot = await (opts.readSnapshotImpl
    ? opts.readSnapshotImpl()
    : readInstalledRuntimeSnapshot({
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      }));
  if (!snapshot.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness run failed', snapshot.diagnostics);
    return { exitCode: 1 };
  }

  const resolved = resolveInstalledCommand(opts.command, snapshot.value);
  if (!resolved.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness run failed', resolved.diagnostics);
    return { exitCode: 1 };
  }

  const fingerprint = await (opts.checkLockFingerprintImpl ?? checkInstalledLockFingerprint)(
    resolved.value.install,
    snapshot.value.paths,
  );
  if (!fingerprint.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness run failed', fingerprint.diagnostics);
    return { exitCode: 1 };
  }

  const loadInstalledFsmImpl = opts.loadInstalledFsmImpl ?? loadInstalledFsm;
  const runCliImpl = opts.runCliImpl ?? runCliForTest;
  const entryFile = path.join(resolved.value.install.packageRoot, resolved.value.command.entry);
  const loadFsmImpl: RunCliForTestOpts['loadFsmImpl'] = async () =>
    loadInstalledFsmImpl({
      entryFile,
      packageName: resolved.value.install.packageName,
      commandName: resolved.value.command.commandName,
      packageRoot: resolved.value.install.packageRoot,
      managedProjectRoot: snapshot.value.paths.managedProjectRoot,
      storeRoot: snapshot.value.paths.storeRoot,
      lockFingerprint: resolved.value.install.lockFingerprint,
    });

  return runCliImpl({
    fsmPath: entryFile,
    cwd: opts.cwd,
    stdout: opts.stdout,
    stderr: opts.stderr,
    inputArgs: opts.inputArgs ?? [],
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    verify: () => Promise.resolve({ exitCode: 0 }),
    loadFsmImpl,
  });
}
