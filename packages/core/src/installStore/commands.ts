import type { InstallStoreResult, TrustedCommandIndexEntry, TrustedCommandsFile } from './types.js';

export type ParsedCommandIdentity =
  | {
      readonly kind: 'bare';
      readonly commandName: string;
    }
  | {
      readonly kind: 'package';
      readonly packageName: string;
    }
  | {
      readonly kind: 'qualified';
      readonly packageName: string;
      readonly commandName: string;
      readonly identity: string;
    };

export interface ResolvedCommandIndexEntry {
  readonly identity: string;
  readonly entry: TrustedCommandIndexEntry;
}

type CommandIndexInput = TrustedCommandsFile | Readonly<Record<string, TrustedCommandIndexEntry>>;

export function parseCommandIdentity(input: string): InstallStoreResult<ParsedCommandIdentity> {
  const parts = input.split('/');
  if (input.length === 0 || parts.some((part) => part.length === 0)) {
    return invalidIdentity(input);
  }

  if (input.startsWith('@')) {
    if (parts.length === 2) {
      const [scope, name] = parts as [string, string];
      if (scope.length <= 1 || name.length === 0) return invalidIdentity(input);
      return { ok: true, value: { kind: 'package', packageName: `${scope}/${name}` } };
    }
    if (parts.length === 3) {
      const [scope, name, commandName] = parts as [string, string, string];
      if (scope.length <= 1 || name.length === 0 || commandName.length === 0) {
        return invalidIdentity(input);
      }
      const packageName = `${scope}/${name}`;
      return {
        ok: true,
        value: {
          kind: 'qualified',
          packageName,
          commandName,
          identity: `${packageName}/${commandName}`,
        },
      };
    }
    return invalidIdentity(input);
  }

  if (parts.length === 1) {
    return { ok: true, value: { kind: 'bare', commandName: input } };
  }
  if (parts.length === 2) {
    const [packageName, commandName] = parts as [string, string];
    return {
      ok: true,
      value: {
        kind: 'qualified',
        packageName,
        commandName,
        identity: `${packageName}/${commandName}`,
      },
    };
  }

  return invalidIdentity(input);
}

export function resolveCommandFromIndex(
  index: CommandIndexInput,
  input: string,
): InstallStoreResult<ResolvedCommandIndexEntry> {
  const parsed = parseCommandIdentity(input);
  if (!parsed.ok) return parsed;

  const commands = commandEntries(index);
  switch (parsed.value.kind) {
    case 'qualified': {
      const entry = commands[parsed.value.identity];
      if (entry) {
        return {
          ok: true,
          value: {
            identity: parsed.value.identity,
            entry,
          },
        };
      }
      return commandNotFound(input);
    }
    case 'package':
      return {
        ok: false,
        diagnostics: [
          {
            code: 'command-identity-package-only',
            commandName: input,
            message: `'${input}' identifies a package, not a command`,
          },
        ],
      };
    case 'bare': {
      const commandName = parsed.value.commandName;
      const matches = Object.entries(commands)
        .filter(([, entry]) => entry.commandName === commandName)
        .sort(([a], [b]) => a.localeCompare(b));

      if (matches.length === 0) return commandNotFound(commandName);
      if (matches.length > 1) {
        const alternatives = matches.map(([identity]) => identity);
        return {
          ok: false,
          diagnostics: [
            {
              code: 'command-ambiguous',
              commandName,
              alternatives,
              message: `command '${commandName}' is ambiguous; use one of: ${alternatives.join(', ')}`,
            },
          ],
        };
      }

      const [identity, entry] = matches[0] as [string, TrustedCommandIndexEntry];
      return {
        ok: true,
        value: {
          identity,
          entry,
        },
      };
    }
  }
}

function invalidIdentity(input: string): InstallStoreResult<never> {
  return {
    ok: false,
    diagnostics: [
      {
        code: 'command-identity-invalid',
        commandName: input,
        message: `'${input}' is not a valid command identity`,
      },
    ],
  };
}

function commandNotFound(input: string): InstallStoreResult<never> {
  return {
    ok: false,
    diagnostics: [
      {
        code: 'command-not-found',
        commandName: input,
        message: `command '${input}' is not installed`,
      },
    ],
  };
}

function commandEntries(
  index: CommandIndexInput,
): Readonly<Record<string, TrustedCommandIndexEntry>> {
  if (isTrustedCommandsFile(index)) {
    return index.commands;
  }
  return index;
}

function isTrustedCommandsFile(index: CommandIndexInput): index is TrustedCommandsFile {
  return (
    typeof (index as Partial<TrustedCommandsFile>).schemaVersion === 'number' &&
    typeof (index as Partial<TrustedCommandsFile>).generation === 'string' &&
    typeof (index as Partial<TrustedCommandsFile>).commands === 'object' &&
    (index as Partial<TrustedCommandsFile>).commands !== null
  );
}
