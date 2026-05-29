import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installPackageFromSource,
  type InstallNpmRunner,
  type InstallPackageMutationResult,
} from '../installStore/index.js';
import type { InstallStoreDiagnostic } from '../installStore/types.js';

export interface InstallCliOptions {
  readonly source: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly currentCoreVersion?: string;
  readonly npmInstall?: InstallNpmRunner;
}

export async function runInstallCli(
  opts: InstallCliOptions,
): Promise<{ readonly exitCode: number }> {
  const result = await installPackageFromSource({
    source: opts.source,
    cwd: opts.cwd,
    currentCoreVersion: opts.currentCoreVersion ?? readOwnVersion(),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.npmInstall !== undefined ? { npmInstall: opts.npmInstall } : {}),
  });

  if (!result.ok) {
    writeInstallFailure(opts.stderr, result);
    return { exitCode: 1 };
  }

  opts.stdout.write(
    `aharness install: installed ${result.value.packageName} ` +
      `(${formatCommandCount(result.value.verifiedCommandCount)} verified)\n`,
  );
  return { exitCode: 0 };
}

export function installUsage(stderr: NodeJS.WritableStream): number {
  stderr.write('usage:\n  aharness install <source>\n');
  return 2;
}

function writeInstallFailure(
  stderr: NodeJS.WritableStream,
  result: Extract<InstallPackageMutationResult, { readonly ok: false }>,
): void {
  writeDiagnostics(stderr, 'aharness install failed', result.diagnostics);
  if (result.npmMutated) {
    stderr.write(
      `  - npm may have changed files under ${result.managedProjectRoot ?? '<managed project>'}; ` +
        'unverified commands were not indexed.\n',
    );
  }
}

function writeDiagnostics(
  stderr: NodeJS.WritableStream,
  heading: string,
  diagnostics: readonly InstallStoreDiagnostic[],
): void {
  stderr.write(`${heading}:\n`);
  for (const diagnostic of diagnostics) {
    const where =
      diagnostic.field ??
      diagnostic.path ??
      diagnostic.commandName ??
      diagnostic.alternatives?.join(', ');
    stderr.write(`  - ${where ? `${where}: ` : ''}[${diagnostic.code}] ${diagnostic.message}\n`);
  }
}

function formatCommandCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'command' : 'commands'}`;
}

function readOwnVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      return pkg.version ?? '0.0.0';
    }
  }
  return '0.0.0';
}
