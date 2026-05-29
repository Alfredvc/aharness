import { computeLockFingerprint, type ComputeLockFingerprintOptions } from './lockfile.js';
import { deriveCommandIndexFromInstalls } from './records.js';
import { writeTrustedJson } from './trustedJson.js';
import type {
  InstallStoreDiagnostic,
  InstallStoreResult,
  TrustedCommandsFile,
  TrustedInstallsFile,
} from './types.js';
import type { InstallStorePaths } from './paths.js';

export interface RegenerateCommandIndexFromInstallsOptions {
  readonly installs: TrustedInstallsFile;
  readonly paths: InstallStorePaths;
  readonly computeLockFingerprintImpl?: (
    opts: ComputeLockFingerprintOptions,
  ) => Promise<InstallStoreResult<string>>;
  readonly writeTrustedJsonImpl?: typeof writeTrustedJson;
}

export async function regenerateCommandIndexFromInstalls(
  opts: RegenerateCommandIndexFromInstallsOptions,
): Promise<InstallStoreResult<TrustedCommandsFile>> {
  const fingerprintCheck = await validateInstallFingerprints(opts);
  if (!fingerprintCheck.ok) return fingerprintCheck;

  const commandIndex = deriveCommandIndexFromInstalls(opts.installs);
  if (!commandIndex.ok) return commandIndex;

  const writeTrustedJsonImpl = opts.writeTrustedJsonImpl ?? writeTrustedJson;
  const written = await writeTrustedJsonImpl(opts.paths.commandsPath, commandIndex.value);
  if (!written.ok) return written;

  return commandIndex;
}

async function validateInstallFingerprints(
  opts: RegenerateCommandIndexFromInstallsOptions,
): Promise<InstallStoreResult<void>> {
  const computeLockFingerprintImpl = opts.computeLockFingerprintImpl ?? computeLockFingerprint;
  const diagnostics: InstallStoreDiagnostic[] = [];

  const installs = Object.values(opts.installs.installs).sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
  for (const install of installs) {
    const fingerprint = await computeLockFingerprintImpl({
      managedProjectRoot: opts.paths.managedProjectRoot,
      dependencyKey: install.dependencyKey,
      packageName: install.packageName,
      ...(install.packageVersion !== undefined ? { packageVersion: install.packageVersion } : {}),
    });
    if (!fingerprint.ok) {
      diagnostics.push(...fingerprint.diagnostics);
      continue;
    }
    if (fingerprint.value !== install.lockFingerprint) {
      diagnostics.push({
        code: 'installed-lock-fingerprint-mismatch',
        field: `installs.${install.packageName}.lockFingerprint`,
        message:
          `installed package '${install.packageName}' no longer matches the verified install ` +
          'record; reinstall the package before regenerating the command index',
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: undefined };
}
