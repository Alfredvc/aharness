import * as path from 'node:path';

import {
  checkInstalledLockFingerprint,
  readInstalledRuntimeSnapshot,
  resolveInstalledCommand,
  type InstalledRuntimeSnapshot,
  type InstallStoreDiagnostic,
  type InstallStorePaths,
  type InstallStoreResult,
  type ReadInstalledRuntimeSnapshotOptions,
  type TrustedCommandMetadata,
  type TrustedInstallRecord,
} from '../installStore/index.js';

export type FsmTargetSyntax = 'local' | 'invalid-local' | 'installed-candidate';

export interface LocalFsmTarget {
  readonly kind: 'local';
  readonly target: string;
}

export interface InstalledFsmTarget {
  readonly kind: 'installed';
  readonly identity: string;
  readonly install: TrustedInstallRecord;
  readonly command: TrustedCommandMetadata;
  readonly entryFile: string;
  readonly lockFingerprint: string;
}

export interface InvalidFsmTarget {
  readonly kind: 'invalid';
  readonly diagnostics: readonly InstallStoreDiagnostic[];
}

export type ResolvedFsmTarget = LocalFsmTarget | InstalledFsmTarget | InvalidFsmTarget;

export interface ResolveFsmTargetOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly readSnapshotImpl?: (
    opts?: ReadInstalledRuntimeSnapshotOptions,
  ) => Promise<InstallStoreResult<InstalledRuntimeSnapshot>>;
  readonly checkLockFingerprintImpl?: (
    record: TrustedInstallRecord,
    paths: InstallStorePaths,
  ) => Promise<InstallStoreResult<string>>;
}

export function classifyFsmTargetSyntax(token: string): FsmTargetSyntax {
  if (token.endsWith('.fsm.ts')) return 'local';
  if (isExplicitLocalSyntax(token)) return 'invalid-local';
  return 'installed-candidate';
}

export async function resolveFsmTarget(
  token: string,
  opts: ResolveFsmTargetOptions = {},
): Promise<ResolvedFsmTarget> {
  if (token.length === 0 || token.startsWith('-')) {
    return invalidTargetToken(token);
  }

  switch (classifyFsmTargetSyntax(token)) {
    case 'local':
      return { kind: 'local', target: token };
    case 'invalid-local':
      return invalidLocalTarget(token);
    case 'installed-candidate':
      return resolveInstalledFsmTarget(token, opts);
  }
}

async function resolveInstalledFsmTarget(
  token: string,
  opts: ResolveFsmTargetOptions,
): Promise<ResolvedFsmTarget> {
  const snapshot = await (opts.readSnapshotImpl ?? readInstalledRuntimeSnapshot)({
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  });
  if (!snapshot.ok) return { kind: 'invalid', diagnostics: snapshot.diagnostics };

  const resolved = resolveInstalledCommand(token, snapshot.value);
  if (!resolved.ok) return { kind: 'invalid', diagnostics: resolved.diagnostics };

  const fingerprint = await (opts.checkLockFingerprintImpl ?? checkInstalledLockFingerprint)(
    resolved.value.install,
    snapshot.value.paths,
  );
  if (!fingerprint.ok) return { kind: 'invalid', diagnostics: fingerprint.diagnostics };

  return {
    kind: 'installed',
    identity: resolved.value.identity,
    install: resolved.value.install,
    command: resolved.value.command,
    entryFile: path.join(resolved.value.install.packageRoot, resolved.value.command.entry),
    lockFingerprint: resolved.value.install.lockFingerprint,
  };
}

function isExplicitLocalSyntax(token: string): boolean {
  return token.startsWith('./') || token.startsWith('../') || path.isAbsolute(token);
}

function invalidTargetToken(token: string): InvalidFsmTarget {
  return {
    kind: 'invalid',
    diagnostics: [
      {
        code: 'fsm-target-invalid-token',
        commandName: token,
        message:
          token.length === 0
            ? 'FSM target must not be empty'
            : `FSM target '${token}' must not be a flag`,
      },
    ],
  };
}

function invalidLocalTarget(token: string): InvalidFsmTarget {
  return {
    kind: 'invalid',
    diagnostics: [
      {
        code: 'fsm-target-invalid-local',
        commandName: token,
        message: `local FSM target '${token}' must end in .fsm.ts`,
      },
    ],
  };
}
