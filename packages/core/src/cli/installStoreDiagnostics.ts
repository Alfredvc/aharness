import type { InstallStoreDiagnostic } from '../installStore/index.js';

export function writeInstallStoreDiagnostics(
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
