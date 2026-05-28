export const INSTALL_STORE_SCHEMA_VERSION = 1 as const;

export interface InstallStoreDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly field?: string;
  readonly commandName?: string;
  readonly alternatives?: readonly string[];
}

export type InstallStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly InstallStoreDiagnostic[] };

export interface TrustedCommandMetadata {
  readonly commandName: string;
  readonly entry: string;
  readonly description?: string;
}

export interface TrustedInstallRecord {
  readonly packageName: string;
  readonly dependencyKey: string;
  readonly requestedSpec: string;
  readonly packageRoot: string;
  readonly packageVersion?: string;
  readonly sourceIntentKey: string;
  readonly lockFingerprint: string;
  readonly commands: Record<string, TrustedCommandMetadata>;
}

export interface TrustedInstallsFile {
  readonly schemaVersion: typeof INSTALL_STORE_SCHEMA_VERSION;
  readonly generation: string;
  readonly installs: Record<string, TrustedInstallRecord>;
}

export interface TrustedCommandIndexEntry {
  readonly packageName: string;
  readonly commandName: string;
  readonly entry: string;
  readonly packageRoot: string;
  readonly packageVersion?: string;
  readonly lockFingerprint: string;
  readonly description?: string;
}

export interface TrustedCommandsFile {
  readonly schemaVersion: typeof INSTALL_STORE_SCHEMA_VERSION;
  readonly generation: string;
  readonly commands: Record<string, TrustedCommandIndexEntry>;
}
