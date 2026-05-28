import * as os from 'node:os';
import * as path from 'node:path';

export interface InstallStorePaths {
  readonly storeRoot: string;
  readonly managedProjectRoot: string;
  readonly installsPath: string;
  readonly commandsPath: string;
}

export interface ResolveInstallStorePathsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

export function resolveInstallStorePaths(
  options: ResolveInstallStorePathsOptions = {},
): InstallStorePaths {
  const env = options.env ?? process.env;
  const aharnessHome = env['AHARNESS_HOME'];
  const storeRoot =
    aharnessHome !== undefined && aharnessHome.length > 0
      ? path.resolve(aharnessHome)
      : path.resolve(options.homeDir ?? os.homedir(), '.aharness');

  return {
    storeRoot,
    managedProjectRoot: path.join(storeRoot, 'packages'),
    installsPath: path.join(storeRoot, 'installs.json'),
    commandsPath: path.join(storeRoot, 'commands.json'),
  };
}
