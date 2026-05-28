export interface FsmPackageDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly path?: string;
  readonly commandName?: string;
  readonly target?: string;
  readonly sourceFile?: string;
  readonly importSpecifier?: string;
  readonly resolvedFile?: string;
  readonly line?: number;
}

export type FsmPackageResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly FsmPackageDiagnostic[];
    };

export type PackageJsonObject = Record<string, unknown>;

export interface PackageJsonFile {
  readonly path: string;
  readonly packageJson: PackageJsonObject;
}

export interface CommandMetadata {
  readonly target?: string;
  readonly description?: string;
}

export interface FsmPackageConfig {
  readonly packageRoot: string;
  readonly packageJson: PackageJsonObject;
  readonly packageName: string;
  readonly binName: string;
  readonly binPath: string;
  readonly binRelativePath: string;
  readonly fsmsDir: string;
  readonly fsmsDirPath: string;
  readonly commandMetadata: Readonly<Record<string, CommandMetadata>>;
}

export interface PackagePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface DiscoveredFsmCommand {
  readonly kind: 'fsm';
  readonly name: string;
  readonly filePath: string;
  readonly description?: string;
}

export interface DiscoveredAliasCommand {
  readonly kind: 'alias';
  readonly name: string;
  readonly target: string;
  readonly targetFilePath: string;
  readonly description?: string;
}

export type DiscoveredPackageCommand = DiscoveredFsmCommand | DiscoveredAliasCommand;

export interface PackageCommandDiscovery {
  readonly commands: readonly DiscoveredPackageCommand[];
}
