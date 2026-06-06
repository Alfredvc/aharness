/**
 * Shell completion install/uninstall for the one-time
 * `aharness completion install` / `aharness completion uninstall`
 * subcommands. Install delegates to `@pnpm/tabtab`; uninstall performs
 * aharness-owned cleanup directly so partially-installed shells remain
 * idempotent.
 *
 * This file intentionally has zero dependencies on the project's
 * internal `loader/` modules: the Task 19 HOME-redirect integration test
 * spawns a Node subprocess that loads this file via native TS-stripping,
 * which does NOT rewrite `.js` import specifiers. Static internal imports
 * from this file would crash that subprocess at module-resolve time.
 *
 * New installs point at the lightweight `aharness-completion` binary so the
 * per-Tab bridge avoids the full `aharness` dispatcher module graph.
 *
 * Silent-error policy: install/uninstall return exit 1 on failure so
 * users get a diagnostic for their one-time setup. The bridge file
 * follows a different policy (exit 0 always).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tabtab from '@pnpm/tabtab';

type CompletionShell = 'bash' | 'zsh' | 'fish';

const COMPLETION_SHELLS: readonly CompletionShell[] = ['bash', 'zsh', 'fish'];
const SHELL_EXTENSIONS: Record<CompletionShell, string> = {
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
};

export interface CompletionInstallOpts {
  readonly name?: string;
  readonly completer?: string;
  readonly shell?: CompletionShell;
}

export async function runCompletionInstall(
  opts: CompletionInstallOpts,
): Promise<{ exitCode: number }> {
  const name = opts.name ?? 'aharness';
  const completer = opts.completer ?? 'aharness-completion';
  try {
    const args: { name: string; completer: string; shell?: 'bash' | 'zsh' | 'fish' } = {
      name,
      completer,
    };
    if (opts.shell) args.shell = opts.shell;
    await tabtab.install(args);
    return { exitCode: 0 };
  } catch (err) {
    process.stderr.write(
      `completion install failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 1 };
  }
}

export async function runCompletionUninstall(opts: {
  name?: string;
}): Promise<{ exitCode: number }> {
  const name = opts.name ?? 'aharness';
  try {
    const homeDir = process.env['HOME'] || os.homedir();
    await Promise.all(
      COMPLETION_SHELLS.map((shell) => uninstallCompletionForShell(homeDir, name, shell)),
    );
    return { exitCode: 0 };
  } catch (err) {
    process.stderr.write(
      `completion uninstall failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 1 };
  }
}

async function uninstallCompletionForShell(
  homeDir: string,
  name: string,
  shell: CompletionShell,
): Promise<void> {
  const ext = SHELL_EXTENSIONS[shell];
  const tabtabDir = path.join(homeDir, '.config', 'tabtab', shell);
  const completionScript = path.join(tabtabDir, `${name}.${ext}`);
  const tabtabScript = path.join(tabtabDir, `__tabtab.${ext}`);

  await fs.rm(completionScript, { force: true });

  const tabtabContent = await readTextIfExists(tabtabScript);
  if (tabtabContent === null) return;

  const withoutPackage = removeTabtabBlock(tabtabContent, `# tabtab source for ${name} package`);
  if (withoutPackage.changed) {
    await fs.writeFile(tabtabScript, withoutPackage.content, 'utf8');
  }

  if (withoutPackage.content.trim() !== '') return;

  const shellConfig = shellConfigPath(homeDir, shell);
  const shellConfigContent = await readTextIfExists(shellConfig);
  if (shellConfigContent === null) return;

  const withoutSharedSource = removeTabtabBlock(
    shellConfigContent,
    '# tabtab source for packages',
    `__tabtab.${ext}`,
  );
  if (withoutSharedSource.changed) {
    await fs.writeFile(shellConfig, withoutSharedSource.content, 'utf8');
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

function shellConfigPath(homeDir: string, shell: CompletionShell): string {
  if (shell === 'fish') return path.join(homeDir, '.config', 'fish', 'config.fish');
  return path.join(homeDir, shell === 'bash' ? '.bashrc' : '.zshrc');
}

function removeTabtabBlock(
  content: string,
  marker: string,
  sourceNeedle?: string,
): { readonly content: string; readonly changed: boolean } {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const nextLines: string[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const block = lines.slice(i, i + 3);
    const markerMatches = lines[i]?.trim() === marker;
    const sourceMatches = !sourceNeedle || block.some((line) => line.includes(sourceNeedle));
    if (markerMatches && sourceMatches) {
      changed = true;
      i += 2;
      continue;
    }
    nextLines.push(lines[i] ?? '');
  }

  let nextContent = nextLines.join(newline);
  if (hadFinalNewline && nextContent.length > 0) nextContent += newline;
  return { content: nextContent, changed };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
