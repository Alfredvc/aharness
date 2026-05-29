declare module 'npm-package-arg' {
  export type PackageSpecType =
    | 'alias'
    | 'directory'
    | 'file'
    | 'git'
    | 'range'
    | 'remote'
    | 'tag'
    | 'version';

  export interface HostedGitInfo {
    readonly type: string;
    readonly user?: string;
    readonly project?: string;
    https(): string;
    sshurl(): string;
  }

  export interface PackageSpecResult {
    readonly type: PackageSpecType;
    readonly registry?: boolean;
    readonly raw: string;
    readonly name?: string;
    readonly rawSpec?: string;
    readonly saveSpec?: string | null;
    readonly fetchSpec?: string | null;
    readonly gitRange?: string;
    readonly gitCommittish?: string;
    readonly gitSubdir?: string;
    readonly hosted?: HostedGitInfo;
    readonly subSpec?: PackageSpecResult;
  }

  export default function npa(source: string, where?: string): PackageSpecResult;
}
