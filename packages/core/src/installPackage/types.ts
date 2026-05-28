export interface InstallPackageDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly path?: string;
  readonly commandName?: string;
  readonly resolvedFile?: string;
}

export type InstallPackageResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly InstallPackageDiagnostic[];
    };

export type PackageJsonObject = Record<string, unknown>;

export interface InstallPackageCommand {
  readonly commandName: string;
  readonly entry: string;
  readonly entryPath: string;
  readonly description?: string;
}

export interface InstallPackageManifest {
  readonly packageRoot: string;
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly coreDependencyRange: string;
  readonly commands: readonly InstallPackageCommand[];
}
