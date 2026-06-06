/**
 * Shell completion install/uninstall — wraps `@pnpm/tabtab` for the
 * one-time `aharness completion install` / `aharness completion uninstall`
 * subcommands.
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
import * as tabtab from '@pnpm/tabtab';

export interface CompletionInstallOpts {
  readonly name?: string;
  readonly completer?: string;
  readonly shell?: 'bash' | 'zsh' | 'fish';
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
    await tabtab.uninstall({ name });
    return { exitCode: 0 };
  } catch (err) {
    process.stderr.write(
      `completion uninstall failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 1 };
  }
}
