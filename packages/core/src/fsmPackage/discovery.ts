import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { isPathInsideOrEqual, validatePackagePath } from './paths.js';
import type {
  CommandMetadata,
  DiscoveredFsmCommand,
  DiscoveredPackageCommand,
  FsmPackageDiagnostic,
  FsmPackageResult,
  PackageCommandDiscovery,
} from './types.js';

const FSM_SUFFIX = '.fsm.ts';
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_COMMAND_NAMES = new Set(['list', 'verify', 'help', 'version']);

export interface DiscoverPackageCommandsOptions {
  readonly packageRoot: string;
  readonly fsmsDir: string;
  readonly commandMetadata?: Readonly<Record<string, CommandMetadata>>;
}

export async function discoverPackageCommands(
  opts: DiscoverPackageCommandsOptions,
): Promise<FsmPackageResult<PackageCommandDiscovery>> {
  const packageRoot = path.resolve(opts.packageRoot);
  const pathResult = validatePackagePath({
    packageRoot,
    relativePath: opts.fsmsDir,
    field: 'aharness.package.fsmsDir',
  });
  if (!pathResult.ok) return pathResult;

  const fsmsDirPath = pathResult.value.absolutePath;
  const diagnostics: FsmPackageDiagnostic[] = [];

  try {
    const stat = await fs.lstat(fsmsDirPath);
    if (stat.isSymbolicLink()) {
      diagnostics.push({
        code: 'fsms-dir-symlink-rejected',
        field: 'aharness.package.fsmsDir',
        path: fsmsDirPath,
        message: 'aharness.package.fsmsDir must not be a symlink',
      });
    } else if (!stat.isDirectory()) {
      diagnostics.push({
        code: 'fsms-dir-not-directory',
        field: 'aharness.package.fsmsDir',
        path: fsmsDirPath,
        message: 'aharness.package.fsmsDir must be a directory',
      });
    }
  } catch (err) {
    diagnostics.push({
      code: 'fsms-dir-read-failed',
      field: 'aharness.package.fsmsDir',
      path: fsmsDirPath,
      message: `could not read aharness.package.fsmsDir: ${errorMessage(err)}`,
    });
  }

  try {
    const realPackageRoot = await fs.realpath(packageRoot);
    const realFsmsDir = await fs.realpath(fsmsDirPath);
    if (!isPathInsideOrEqual(realPackageRoot, realFsmsDir)) {
      diagnostics.push({
        code: 'fsms-dir-realpath-escapes',
        field: 'aharness.package.fsmsDir',
        path: fsmsDirPath,
        message: 'aharness.package.fsmsDir resolves outside the package root',
      });
    }
  } catch {
    // The lstat/read diagnostic above is more useful for missing directories.
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(fsmsDirPath, { withFileTypes: true });
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'fsms-dir-read-failed',
          field: 'aharness.package.fsmsDir',
          path: fsmsDirPath,
          message: `could not read aharness.package.fsmsDir: ${errorMessage(err)}`,
        },
      ],
    };
  }

  const discovered = new Map<string, DiscoveredFsmCommand>();
  for (const entry of entries) {
    const entryPath = path.join(fsmsDirPath, entry.name);
    if (entry.isSymbolicLink()) {
      await rejectUnsafeSymlink(entryPath, entry.name, diagnostics);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(FSM_SUFFIX)) continue;

    const name = entry.name.slice(0, -FSM_SUFFIX.length);
    if (!validateCommandName(name, diagnostics)) continue;

    if (discovered.has(name)) {
      diagnostics.push({
        code: 'command-name-duplicate',
        commandName: name,
        path: entryPath,
        message: `duplicate FSM command '${name}'`,
      });
      continue;
    }

    discovered.set(name, {
      kind: 'fsm',
      name,
      filePath: entryPath,
    });
  }

  const commands = applyCommandMetadata(discovered, opts.commandMetadata ?? {}, diagnostics);

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  commands.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    value: {
      commands,
    },
  };
}

function applyCommandMetadata(
  discovered: Map<string, DiscoveredFsmCommand>,
  metadata: Readonly<Record<string, CommandMetadata>>,
  diagnostics: FsmPackageDiagnostic[],
): DiscoveredPackageCommand[] {
  const commands = new Map<string, DiscoveredPackageCommand>(discovered);

  for (const [name, entry] of Object.entries(metadata)) {
    const nameIsValid = validateCommandName(name, diagnostics);
    const discoveredCommand = discovered.get(name);

    if (entry.target === undefined) {
      if (!discoveredCommand) {
        diagnostics.push({
          code: 'command-metadata-unknown',
          commandName: name,
          message: `command metadata '${name}' does not name a discovered FSM command or alias`,
        });
        continue;
      }
      if (entry.description !== undefined) {
        commands.set(name, { ...discoveredCommand, description: entry.description });
      }
      continue;
    }

    if (discoveredCommand) {
      diagnostics.push({
        code: 'command-name-duplicate',
        commandName: name,
        target: entry.target,
        message: `alias '${name}' duplicates a discovered FSM command`,
      });
      continue;
    }

    const targetMetadata = metadata[entry.target];
    if (targetMetadata?.target !== undefined) {
      diagnostics.push({
        code: 'alias-chain-rejected',
        commandName: name,
        target: entry.target,
        message: `alias '${name}' targets another alias '${entry.target}'`,
      });
    }

    const target = discovered.get(entry.target);
    if (!target) {
      diagnostics.push({
        code: 'alias-target-missing',
        commandName: name,
        target: entry.target,
        message: `alias '${name}' must target a discovered FSM command`,
      });
      continue;
    }

    if (!nameIsValid) continue;

    commands.set(name, {
      kind: 'alias',
      name,
      target: entry.target,
      targetFilePath: target.filePath,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    });
  }

  return Array.from(commands.values());
}

function validateCommandName(name: string, diagnostics: FsmPackageDiagnostic[]): boolean {
  if (!isValidCommandName(name)) {
    diagnostics.push({
      code: 'command-name-invalid',
      commandName: name,
      message: `command name '${name}' must match ${COMMAND_NAME_RE.source}`,
    });
    return false;
  }
  if (RESERVED_COMMAND_NAMES.has(name)) {
    diagnostics.push({
      code: 'command-name-reserved',
      commandName: name,
      message: `command name '${name}' is reserved`,
    });
    return false;
  }
  return true;
}

function isValidCommandName(name: string): boolean {
  return COMMAND_NAME_RE.test(name);
}

async function rejectUnsafeSymlink(
  entryPath: string,
  entryName: string,
  diagnostics: FsmPackageDiagnostic[],
): Promise<void> {
  if (entryName.endsWith(FSM_SUFFIX)) {
    diagnostics.push({
      code: 'fsm-symlink-rejected',
      path: entryPath,
      message: 'symlinked FSM files are not supported in FSM packages',
    });
    return;
  }

  try {
    const stat = await fs.stat(entryPath);
    if (stat.isDirectory()) {
      diagnostics.push({
        code: 'directory-symlink-rejected',
        path: entryPath,
        message: 'symlinked directories are not followed during FSM package discovery',
      });
    }
  } catch {
    // Broken non-FSM symlinks are ignored like other non-FSM direct entries.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
