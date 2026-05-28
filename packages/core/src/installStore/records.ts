import {
  INSTALL_STORE_SCHEMA_VERSION,
  type InstallStoreDiagnostic,
  type InstallStoreResult,
  type TrustedCommandIndexEntry,
  type TrustedCommandsFile,
  type TrustedInstallsFile,
} from './types.js';

export interface CommandIndexGenerationComparison {
  readonly current: boolean;
  readonly diagnostics: readonly InstallStoreDiagnostic[];
}

export function deriveCommandIndexFromInstalls(
  installsFile: TrustedInstallsFile,
): InstallStoreResult<TrustedCommandsFile> {
  const diagnostics: InstallStoreDiagnostic[] = [];
  const commands: Record<string, TrustedCommandIndexEntry> = {};

  const installEntries = Object.entries(installsFile.installs).sort((a, b) => {
    const byPackage = a[1].packageName.localeCompare(b[1].packageName);
    return byPackage === 0 ? a[0].localeCompare(b[0]) : byPackage;
  });

  for (const [, install] of installEntries) {
    const commandEntries = Object.entries(install.commands).sort((a, b) => {
      const byCommand = a[1].commandName.localeCompare(b[1].commandName);
      return byCommand === 0 ? a[0].localeCompare(b[0]) : byCommand;
    });

    for (const [, command] of commandEntries) {
      const identity = `${install.packageName}/${command.commandName}`;
      if (commands[identity]) {
        diagnostics.push({
          code: 'command-index-collision',
          field: `commands.${identity}`,
          commandName: command.commandName,
          message: `command identity '${identity}' is declared more than once`,
        });
        continue;
      }

      commands[identity] = {
        packageName: install.packageName,
        commandName: command.commandName,
        entry: command.entry,
        packageRoot: install.packageRoot,
        ...(install.packageVersion !== undefined ? { packageVersion: install.packageVersion } : {}),
        lockFingerprint: install.lockFingerprint,
        ...(command.description !== undefined ? { description: command.description } : {}),
      };
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
      generation: installsFile.generation,
      commands,
    },
  };
}

export function compareCommandIndexGeneration(
  installsFile: TrustedInstallsFile,
  commandsFile: TrustedCommandsFile,
): CommandIndexGenerationComparison {
  if (installsFile.generation === commandsFile.generation) {
    return { current: true, diagnostics: [] };
  }

  return {
    current: false,
    diagnostics: [
      {
        code: 'command-index-generation-mismatch',
        field: 'generation',
        message:
          `commands.json generation '${commandsFile.generation}' does not match ` +
          `installs.json generation '${installsFile.generation}'`,
      },
    ],
  };
}
