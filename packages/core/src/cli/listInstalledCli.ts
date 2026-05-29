import {
  readInstalledRuntimeSnapshot,
  type InstalledRuntimeSnapshot,
  type InstallStoreResult,
  type TrustedCommandIndexEntry,
} from '../installStore/index.js';

import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';

export interface RunListInstalledCliOptions {
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly readSnapshotImpl?: () => Promise<InstallStoreResult<InstalledRuntimeSnapshot>>;
}

export async function runListInstalledCli(
  opts: RunListInstalledCliOptions,
): Promise<{ readonly exitCode: number }> {
  void opts.cwd;
  const snapshot = await (opts.readSnapshotImpl
    ? opts.readSnapshotImpl()
    : readInstalledRuntimeSnapshot({
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      }));
  if (!snapshot.ok) {
    writeInstallStoreDiagnostics(opts.stderr, 'aharness list failed', snapshot.diagnostics);
    return { exitCode: 1 };
  }

  const packages = Object.values(snapshot.value.installs.installs).sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
  if (packages.length === 0) {
    opts.stdout.write('aharness list: no installed packages\n');
    return { exitCode: 0 };
  }

  opts.stdout.write('aharness list:\n');
  for (const install of packages) {
    opts.stdout.write(
      `${install.packageName}${install.packageVersion ? ` ${install.packageVersion}` : ''}\n`,
    );
    const commands = Object.values(install.commands).sort((a, b) =>
      a.commandName.localeCompare(b.commandName),
    );
    for (const command of commands) {
      opts.stdout.write(
        `  ${command.commandName}${command.description ? `  ${command.description}` : ''}\n`,
      );
    }
  }

  const collisions = findBareCommandCollisions(snapshot.value.commands.commands);
  if (collisions.length > 0) {
    opts.stdout.write('bare command collisions:\n');
    for (const collision of collisions) {
      opts.stdout.write(`  ${collision.commandName}:\n`);
      for (const identity of collision.identities) {
        opts.stdout.write(`    ${identity}\n`);
      }
    }
  }

  return { exitCode: 0 };
}

function findBareCommandCollisions(
  commands: Readonly<Record<string, TrustedCommandIndexEntry>>,
): readonly { readonly commandName: string; readonly identities: readonly string[] }[] {
  const byName = new Map<string, string[]>();
  for (const [identity, entry] of Object.entries(commands)) {
    const identities = byName.get(entry.commandName) ?? [];
    identities.push(identity);
    byName.set(entry.commandName, identities);
  }

  return Array.from(byName.entries())
    .filter(([, identities]) => identities.length > 1)
    .map(([commandName, identities]) => ({
      commandName,
      identities: identities.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.commandName.localeCompare(b.commandName));
}
