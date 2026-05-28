import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSONSchema7 } from 'json-schema';

import { runCli, type RunCliOpts } from '../cli/runCli.js';
import { runVerifyCli, type RunVerifyCliOpts } from '../cli/verifyCli.js';
import { loadFsm, type LoadFsmOptions, type LoadFsmResult } from '../loader/index.js';
import { camelToKebab } from '../loader/inputFlags.js';
import type { ArgFlagMeta } from '../loader/inputSchema.js';
import {
  discoverValidatedPackageCommands,
  loadValidatedPackageConfig,
  type ValidatedPackageCommands,
} from './context.js';
import type { DiscoveredPackageCommand, FsmPackageConfig, FsmPackageDiagnostic } from './types.js';

export interface RunPackagedFsmCliOptions {
  readonly packageRootUrl: URL;
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export interface RunPackagedFsmCliDependencies {
  readonly runCli?: (opts: RunCliOpts) => Promise<{ readonly exitCode: number }>;
  readonly runVerifyCli?: (opts: RunVerifyCliOpts) => Promise<{ readonly exitCode: number }>;
  readonly loadFsm?: (opts: LoadFsmOptions) => Promise<LoadFsmResult>;
}

interface LoadedPackageContext {
  readonly config: FsmPackageConfig;
  readonly discovery: ValidatedPackageCommands;
}

const PACKAGE_COMMANDS = ['help', 'list', 'verify', 'version'] as const;

export async function runPackagedFsmCliForTest(
  options: RunPackagedFsmCliOptions,
  deps: RunPackagedFsmCliDependencies = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();

  let packageRoot: string;
  try {
    packageRoot = path.resolve(fileURLToPath(options.packageRootUrl));
  } catch (err) {
    stderr.write(`package runner: invalid packageRootUrl: ${errorMessage(err)}\n`);
    return 2;
  }

  const context = await loadPackageContext(packageRoot, stderr);
  if (!context) return 2;

  const [commandName, ...rest] = options.argv;
  if (!commandName) {
    writePackageUsage(stderr, context.config.binName);
    return 2;
  }

  if (commandName === 'list') {
    if (rest.length !== 0) {
      writePackageUsage(stderr, context.config.binName);
      return 2;
    }
    writeCommandList(stdout, context.discovery.commands);
    return 0;
  }

  if (commandName === 'version') {
    if (rest.length !== 0) {
      writePackageUsage(stderr, context.config.binName);
      return 2;
    }
    writePackageVersion(stdout, context.config);
    return 0;
  }

  if (commandName === 'help') {
    if (rest.length > 1) {
      writePackageUsage(stderr, context.config.binName);
      return 2;
    }
    if (rest.length === 0) {
      writePackageUsage(stdout, context.config.binName);
      return 0;
    }
    return writeCommandHelp({
      context,
      commandName: rest[0]!,
      cwd,
      stdout,
      stderr,
      loadFsmImpl: deps.loadFsm ?? loadFsm,
    });
  }

  if (commandName === 'verify') {
    if (rest.length > 1) {
      writePackageUsage(stderr, context.config.binName);
      return 2;
    }
    return verifyPackageCommands({
      context,
      commandName: rest[0],
      cwd,
      stderr,
      runVerifyCliImpl: deps.runVerifyCli ?? runVerifyCli,
    });
  }

  const command = findCommand(context.discovery.commands, commandName);
  if (!command) {
    writeUnknownCommand(stderr, context, commandName);
    return 2;
  }

  try {
    const result = await (deps.runCli ?? runCli)({
      fsmPath: commandFsmPath(command),
      cwd,
      stdout,
      stderr,
      inputArgs: rest,
    });
    return result.exitCode;
  } catch (err) {
    stderr.write(
      `${context.config.binName}: failed to run FSM command '${commandName}': ${errorMessage(err)}\n`,
    );
    return 2;
  }
}

async function loadPackageContext(
  packageRoot: string,
  stderr: NodeJS.WritableStream,
): Promise<LoadedPackageContext | null> {
  const config = await loadValidatedPackageConfig({ packageRoot });
  if (!config.ok) {
    writeDiagnostics(stderr, 'package runner failed', config.diagnostics);
    return null;
  }

  const discovery = await discoverValidatedPackageCommands({ config: config.value });
  if (!discovery.ok) {
    writeDiagnostics(stderr, 'package runner failed', discovery.diagnostics);
    return null;
  }

  return { config: config.value, discovery: discovery.value };
}

function writeCommandList(
  stdout: NodeJS.WritableStream,
  commands: readonly DiscoveredPackageCommand[],
): void {
  const rows = [...commands]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => {
      if (command.kind === 'alias') {
        return {
          name: command.name,
          detail: `${command.description ?? `Alias for ${command.target}`} -> ${command.target}`,
        };
      }
      return {
        name: command.name,
        detail: command.description ?? '',
      };
    });
  const width = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
  for (const row of rows) {
    if (row.detail.length > 0) {
      stdout.write(`${row.name.padEnd(width + 2)}${row.detail}\n`);
    } else {
      stdout.write(`${row.name}\n`);
    }
  }
}

function writePackageVersion(stdout: NodeJS.WritableStream, config: FsmPackageConfig): void {
  const rawVersion = config.packageJson['version'];
  const version = typeof rawVersion === 'string' && rawVersion.length > 0 ? rawVersion : '0.0.0';
  stdout.write(`${config.packageName} ${version}\n`);
}

async function writeCommandHelp(opts: {
  readonly context: LoadedPackageContext;
  readonly commandName: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly loadFsmImpl: (opts: LoadFsmOptions) => Promise<LoadFsmResult>;
}): Promise<number> {
  const command = findCommand(opts.context.discovery.commands, opts.commandName);
  if (!command) {
    writeUnknownCommand(opts.stderr, opts.context, opts.commandName);
    return 2;
  }

  let loaded: LoadFsmResult;
  try {
    loaded = await opts.loadFsmImpl({
      filePath: commandFsmPath(command),
      repoRoot: opts.cwd,
    });
  } catch (err) {
    opts.stderr.write(
      `${opts.context.config.binName}: failed to load FSM command '${opts.commandName}': ${errorMessage(err)}\n`,
    );
    return 2;
  }

  opts.stdout.write(
    `usage:\n  ${opts.context.config.binName} ${opts.commandName} [--<flag> <value>]...\n`,
  );
  writeInputFlagHelp(opts.stdout, loaded.inputSchema, loaded.inputFlags ?? {});
  return 0;
}

function writeInputFlagHelp(
  stdout: NodeJS.WritableStream,
  schema: JSONSchema7 | undefined,
  flags: Record<string, ArgFlagMeta>,
): void {
  const fields = Object.keys(flags).sort((a, b) => camelToKebab(a).localeCompare(camelToKebab(b)));
  stdout.write('\ninput flags:\n');
  if (fields.length === 0) {
    stdout.write('  (none)\n');
    return;
  }

  const rows = fields.map((field) => {
    const meta = flags[field];
    const usage = formatExampleFlag(field, schema);
    return {
      usage,
      detail: formatFlagDetails(meta),
    };
  });
  const width = rows.reduce((max, row) => Math.max(max, row.usage.length), 0);
  for (const row of rows) {
    if (row.detail.length > 0) {
      stdout.write(`  ${row.usage.padEnd(width + 2)}${row.detail}\n`);
    } else {
      stdout.write(`  ${row.usage}\n`);
    }
  }
}

function formatFlagDetails(meta: ArgFlagMeta | undefined): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.description) parts.push(meta.description);
  if (meta.default !== undefined) parts.push(`default: ${formatDefault(meta.default)}`);
  return parts.join('; ');
}

function formatDefault(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

async function verifyPackageCommands(opts: {
  readonly context: LoadedPackageContext;
  readonly commandName: string | undefined;
  readonly cwd: string;
  readonly stderr: NodeJS.WritableStream;
  readonly runVerifyCliImpl: (opts: RunVerifyCliOpts) => Promise<{ readonly exitCode: number }>;
}): Promise<number> {
  let commands: readonly DiscoveredPackageCommand[];
  if (opts.commandName) {
    const command = findCommand(opts.context.discovery.commands, opts.commandName);
    if (!command) {
      writeUnknownCommand(opts.stderr, opts.context, opts.commandName);
      return 2;
    }
    commands = [command];
  } else {
    commands = opts.context.discovery.fsmCommands;
  }

  const loaderDiagnostics: FsmPackageDiagnostic[] = [];
  let verifierExitCode = 0;
  for (const command of commands) {
    try {
      const result = await opts.runVerifyCliImpl({
        fsmPath: commandFsmPath(command),
        repoRoot: opts.cwd,
        log: (line) => opts.stderr.write(`[${command.name}] ${line}\n`),
      });
      if (result.exitCode !== 0 && verifierExitCode === 0) {
        verifierExitCode = result.exitCode;
      }
    } catch (err) {
      loaderDiagnostics.push({
        code: 'fsm-load-failed',
        commandName: command.name,
        path: commandFsmPath(command),
        message: `could not load FSM command '${command.name}': ${errorMessage(err)}`,
      });
    }
  }

  if (loaderDiagnostics.length > 0) {
    writeDiagnostics(
      opts.stderr,
      `${opts.context.config.binName} verify failed`,
      loaderDiagnostics,
    );
    return 2;
  }
  return verifierExitCode;
}

function findCommand(
  commands: readonly DiscoveredPackageCommand[],
  commandName: string,
): DiscoveredPackageCommand | undefined {
  return commands.find((command) => command.name === commandName);
}

function commandFsmPath(command: DiscoveredPackageCommand): string {
  return path.resolve(command.kind === 'fsm' ? command.filePath : command.targetFilePath);
}

function writeUnknownCommand(
  stderr: NodeJS.WritableStream,
  context: LoadedPackageContext,
  commandName: string,
): void {
  stderr.write(`${context.config.binName}: unknown command '${commandName}'\n`);
  const suggestion = nearestCommandName(commandName, context.discovery.commands);
  if (suggestion) {
    stderr.write(`${context.config.binName}: did you mean '${suggestion}'?\n`);
  }
  writePackageUsage(stderr, context.config.binName);
}

function nearestCommandName(
  input: string,
  commands: readonly DiscoveredPackageCommand[],
): string | null {
  const candidates = [
    ...new Set([...PACKAGE_COMMANDS, ...commands.map((command) => command.name)]),
  ];
  let best: { readonly name: string; readonly distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && candidate < best.name)
    ) {
      best = { name: candidate, distance };
    }
  }
  if (!best || best.distance === 0) return null;
  const maxLength = Math.max(input.length, best.name.length);
  if (best.distance <= 2 || (maxLength >= 8 && best.distance / maxLength <= 0.34)) {
    return best.name;
  }
  return null;
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

function writePackageUsage(stream: NodeJS.WritableStream, binName: string): void {
  stream.write(
    'usage:\n' +
      `  ${binName} <command> [--<flag> <value>]...\n` +
      `  ${binName} list\n` +
      `  ${binName} verify [command]\n` +
      `  ${binName} help [command]\n` +
      `  ${binName} version\n`,
  );
}

function formatExampleFlag(field: string, schema: JSONSchema7 | undefined): string {
  const name = `--${camelToKebab(field)}`;
  const type = inputFlagTypeName(schema, field);
  return type === 'boolean' ? name : `${name} <${type}>`;
}

function inputFlagTypeName(schema: JSONSchema7 | undefined, field: string): string {
  const fieldSchema = (schema?.properties?.[field] ?? {}) as JSONSchema7;
  if (fieldSchema.type === 'string') return 'string';
  if (fieldSchema.type === 'number') return 'number';
  if (fieldSchema.type === 'integer') return 'integer';
  if (fieldSchema.type === 'boolean') return 'boolean';
  return 'value';
}

function writeDiagnostics(
  stderr: NodeJS.WritableStream,
  heading: string,
  diagnostics: readonly FsmPackageDiagnostic[],
): void {
  stderr.write(`${heading}:\n`);
  for (const diagnostic of diagnostics) {
    const where =
      diagnostic.field ?? diagnostic.path ?? diagnostic.sourceFile ?? diagnostic.commandName;
    stderr.write(`  - ${where ? `${where}: ` : ''}[${diagnostic.code}] ${diagnostic.message}\n`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
