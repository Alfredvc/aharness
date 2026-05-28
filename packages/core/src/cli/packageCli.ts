import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFsmPackage } from '../fsmPackage/build.js';
import { initFsmPackage } from '../fsmPackage/init.js';
import type { FsmPackageDiagnostic } from '../fsmPackage/types.js';
import { verifyFsmPackage } from '../fsmPackage/verify.js';

export interface PackageCliOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly harnessCoreVersion?: string;
}

interface PackageInitArgs {
  readonly packageName?: string;
  readonly binName?: string;
  readonly fsmsDir?: string;
  readonly force: boolean;
}

export async function runPackageCli(opts: PackageCliOptions): Promise<{ exitCode: number }> {
  const [subcommand, ...rest] = opts.argv;
  if (subcommand === 'init') {
    const parsed = parsePackageInitArgs(rest);
    if (!parsed) {
      return { exitCode: packageUsage(opts.stderr) };
    }

    const harnessCoreVersion = resolveHarnessCoreVersion(opts);
    const result = await initFsmPackage({
      packageRoot: opts.cwd,
      force: parsed.force,
      harnessCoreVersion: harnessCoreVersion.version,
      ...(parsed.packageName ? { packageName: parsed.packageName } : {}),
      ...(parsed.binName ? { binName: parsed.binName } : {}),
      ...(parsed.fsmsDir ? { fsmsDir: parsed.fsmsDir } : {}),
    });

    if (harnessCoreVersion.warned) {
      opts.stderr.write(
        `aharness package init: warning - running an unpublished @aharness/core (version 0.0.0). ` +
          `package.json pins "@aharness/core": "latest"; edit package.json to pin a real version before publishing.\n`,
      );
    }

    if (!result.ok) {
      writeDiagnostics(opts.stderr, 'aharness package init failed', result.diagnostics);
      return { exitCode: 2 };
    }

    opts.stdout.write(`aharness package init: updated ${result.value.packageJsonPath}\n`);
    return { exitCode: 0 };
  }

  if (subcommand === 'verify') {
    if (rest.length !== 0) {
      return { exitCode: packageUsage(opts.stderr) };
    }

    const result = await verifyFsmPackage({
      packageRoot: opts.cwd,
      log: (line) => opts.stderr.write(`${line}\n`),
    });
    if (!result.ok) {
      writeUsageForMissingPackageJson(opts.stderr, result.diagnostics);
      writeDiagnostics(opts.stderr, 'aharness package verify failed', result.diagnostics);
      return { exitCode: result.exitCode };
    }

    opts.stdout.write(
      `aharness package verify: ok (${formatFsmCount(result.value.verifiedFsmCount)})\n`,
    );
    return { exitCode: 0 };
  }

  if (subcommand === 'build') {
    if (rest.length !== 0) {
      return { exitCode: packageUsage(opts.stderr) };
    }

    const result = await buildFsmPackage({
      packageRoot: opts.cwd,
      log: (line) => opts.stderr.write(`${line}\n`),
    });
    if (!result.ok) {
      writeUsageForMissingPackageJson(opts.stderr, result.diagnostics);
      writeDiagnostics(opts.stderr, 'aharness package build failed', result.diagnostics);
      return { exitCode: result.exitCode };
    }

    opts.stdout.write(`aharness package build: wrote ${result.value.binPath}\n`);
    return { exitCode: 0 };
  }

  return { exitCode: packageUsage(opts.stderr) };
}

function parsePackageInitArgs(args: ReadonlyArray<string>): PackageInitArgs | null {
  let packageName: string | undefined;
  let binName: string | undefined;
  let fsmsDir: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '--name') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return null;
      packageName = value;
      continue;
    }

    if (arg === '--bin') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return null;
      binName = value;
      continue;
    }

    if (arg === '--fsms-dir') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return null;
      fsmsDir = value;
      continue;
    }

    return null;
  }

  return {
    force,
    ...(packageName ? { packageName } : {}),
    ...(binName ? { binName } : {}),
    ...(fsmsDir ? { fsmsDir } : {}),
  };
}

function resolveHarnessCoreVersion(opts: PackageCliOptions): { version: string; warned: boolean } {
  const ownVersion = opts.harnessCoreVersion ?? readOwnVersion();
  if (ownVersion === '0.0.0') {
    return { version: 'latest', warned: true };
  }
  return { version: ownVersion, warned: false };
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

function writeUsageForMissingPackageJson(
  stderr: NodeJS.WritableStream,
  diagnostics: readonly FsmPackageDiagnostic[],
): void {
  if (diagnostics.some((diagnostic) => diagnostic.code === 'package-json-read-failed')) {
    packageUsage(stderr);
  }
}

function formatFsmCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'FSM' : 'FSMs'}`;
}

export function packageUsage(stderr: NodeJS.WritableStream): number {
  stderr.write(
    'usage:\n' +
      '  aharness package init [--name <package-name>] [--bin <command>] [--fsms-dir <dir>] [--force]\n' +
      '  aharness package build\n' +
      '  aharness package verify\n',
  );
  return 2;
}
