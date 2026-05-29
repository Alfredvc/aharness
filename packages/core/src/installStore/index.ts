export { resolveInstallStorePaths, type InstallStorePaths } from './paths.js';
export {
  INSTALL_STORE_SCHEMA_VERSION,
  type InstallStoreDiagnostic,
  type InstallStoreResult,
  type TrustedCommandIndexEntry,
  type TrustedCommandMetadata,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from './types.js';
export { validateTrustedCommandsFile, validateTrustedInstallsFile } from './schema.js';
export { readTrustedJson, writeTrustedJson, type TrustedJsonValidator } from './trustedJson.js';
export {
  compareCommandIndexGeneration,
  deriveCommandIndexFromInstalls,
  type CommandIndexGenerationComparison,
} from './records.js';
export {
  regenerateCommandIndexFromInstalls,
  type RegenerateCommandIndexFromInstallsOptions,
} from './recovery.js';
export {
  parseCommandIdentity,
  resolveCommandFromIndex,
  type ParsedCommandIdentity,
  type ResolvedCommandIndexEntry,
} from './commands.js';
export {
  checkInstalledLockFingerprint,
  readInstalledRuntimeSnapshot,
  resolveInstalledCommand,
  resolveInstalledPackage,
  type CheckInstalledLockFingerprintDeps,
  type InstalledRuntimeSnapshot,
  type ReadInstalledRuntimeSnapshotOptions,
  type ResolvedInstalledCommand,
  type ResolvedInstalledPackage,
} from './runtime.js';
export { ensureManagedProject, readManagedProjectDependencies } from './managedProject.js';
export {
  runNpmInstall,
  type InstallNpmRunner,
  type NpmInstallSuccess,
  type NpmSpawn,
  type NpmSpawnInvocation,
  type NpmSpawnResult,
  type RunNpmInstallOptions,
  runNpmUninstall,
  type NpmUninstallSuccess,
  type RunNpmUninstallOptions,
  type UninstallNpmRunner,
} from './npmRunner.js';
export {
  computeSourceIntentKey,
  deriveDependencyKeyFromSource,
  identifyDirectDependencyKey,
  resolveLocalDirectorySource,
} from './sourceIntent.js';
export { computeLockFingerprint, type ComputeLockFingerprintOptions } from './lockfile.js';
export {
  installPackageFromSource,
  type InstallPackageFromSourceOptions,
  type InstallPackageMutationResult,
  type InstallPackageSuccess,
} from './install.js';
export {
  uninstallPackage,
  type UninstallPackageMutationResult,
  type UninstallPackageOptions,
  type UninstallPackageSuccess,
} from './uninstall.js';
