import { readPackageJson, validatePackageConfig } from './config.js';
import { discoverPackageCommands } from './discovery.js';
import type {
  DiscoveredFsmCommand,
  DiscoveredPackageCommand,
  FsmPackageConfig,
  FsmPackageResult,
} from './types.js';

export function loadValidatedPackageConfig(opts: {
  readonly packageRoot: string;
}): Promise<FsmPackageResult<FsmPackageConfig>> {
  return loadConfig(opts.packageRoot);
}

export interface ValidatedPackageCommands {
  readonly commands: readonly DiscoveredPackageCommand[];
  readonly fsmCommands: readonly DiscoveredFsmCommand[];
}

export async function discoverValidatedPackageCommands(opts: {
  readonly config: FsmPackageConfig;
}): Promise<FsmPackageResult<ValidatedPackageCommands>> {
  const discovery = await discoverPackageCommands({
    packageRoot: opts.config.packageRoot,
    fsmsDir: opts.config.fsmsDir,
    commandMetadata: opts.config.commandMetadata,
  });
  if (!discovery.ok) return discovery;

  const fsmCommands = discovery.value.commands.filter(
    (command): command is DiscoveredFsmCommand => command.kind === 'fsm',
  );
  if (fsmCommands.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'commands-missing',
          field: 'harness.package.fsmsDir',
          path: opts.config.fsmsDir,
          message: 'FSM packages must contain at least one direct child .fsm.ts command',
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      commands: discovery.value.commands,
      fsmCommands,
    },
  };
}

async function loadConfig(packageRoot: string): Promise<FsmPackageResult<FsmPackageConfig>> {
  const packageJson = await readPackageJson(packageRoot);
  if (!packageJson.ok) return packageJson;

  return validatePackageConfig({
    packageRoot,
    packageJson: packageJson.value.packageJson,
  });
}
