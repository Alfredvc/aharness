import {
  uninstallPackage,
  type UninstallNpmRunner,
  type UninstallPackageMutationResult,
} from '../installStore/index.js';

import { writeInstallStoreDiagnostics } from './installStoreDiagnostics.js';

export interface UninstallCliOptions {
  readonly packageName: string;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly npmUninstall?: UninstallNpmRunner;
}

export async function runUninstallCli(
  opts: UninstallCliOptions,
): Promise<{ readonly exitCode: number }> {
  const result = await uninstallPackage({
    packageName: opts.packageName,
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.npmUninstall !== undefined ? { npmUninstall: opts.npmUninstall } : {}),
  });

  if (!result.ok) {
    writeUninstallFailure(opts.stderr, result);
    return { exitCode: 1 };
  }

  opts.stdout.write(
    `aharness uninstall: uninstalled ${result.value.packageName} ` +
      `(${formatRemovedCommandCount(result.value.removedCommandCount)} removed)\n`,
  );
  return { exitCode: 0 };
}

export function uninstallUsage(stderr: NodeJS.WritableStream): number {
  stderr.write('usage:\n  aharness uninstall <package-name>\n');
  return 2;
}

function writeUninstallFailure(
  stderr: NodeJS.WritableStream,
  result: Extract<UninstallPackageMutationResult, { readonly ok: false }>,
): void {
  writeInstallStoreDiagnostics(stderr, 'aharness uninstall failed', result.diagnostics);
}

function formatRemovedCommandCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'command' : 'commands'}`;
}
