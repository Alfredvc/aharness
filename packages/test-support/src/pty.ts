/**
 * Thin wrapper around `node-pty`'s `spawn`. Allocates a real pty so child
 * processes that require a TTY (e.g. `codex --remote` whose ratatui front
 * end calls `Term::is_terminal`) receive one on inherited stdin/stdout.
 *
 * Used by `phase9.realtui.e2e.test.ts` to drive the codex TUI from test
 * code; otherwise `codex` bails with `Error: stdin is not a terminal`.
 */

import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import * as nodePty from 'node-pty';

// pnpm's hardlink-from-store install loses the executable bit on
// node-pty's `spawn-helper` binary on darwin/linux. Without the bit set,
// `nodePty.spawn` fails with `Error: posix_spawnp failed.` Restore it
// once per process; this is a no-op when the bit is already set or when
// the prebuild for the current platform doesn't exist.
let spawnHelperPermsChecked = false;
function ensureSpawnHelperExecutable(): void {
  if (spawnHelperPermsChecked) return;
  spawnHelperPermsChecked = true;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('node-pty/package.json');
    const pkgDir = dirname(pkgPath);
    const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
    for (const p of platforms) {
      const helper = join(pkgDir, 'prebuilds', p, 'spawn-helper');
      try {
        const st = statSync(helper);
        if (!(st.mode & 0o111)) chmodSync(helper, 0o755);
      } catch {
        // prebuild missing for this platform — skip
      }
    }
  } catch {
    // require.resolve failed — let nodePty.spawn surface the real error
  }
}

export interface PtyHandle {
  readonly onData: (cb: (chunk: string) => void) => () => void;
  write(text: string): void;
  kill(signal?: string): void;
  readonly exit: Promise<{ code: number; signal: number | null }>;
}

export interface SpawnPtyOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols?: number;
  readonly rows?: number;
}

export function spawnPty(opts: SpawnPtyOptions): PtyHandle {
  ensureSpawnHelperExecutable();
  const pty = nodePty.spawn(opts.command, [...opts.args], {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 40,
    cwd: opts.cwd,
    env: opts.env,
  });

  const exit = new Promise<{ code: number; signal: number | null }>((resolve) => {
    pty.onExit(({ exitCode, signal }) => {
      resolve({ code: exitCode, signal: signal ?? null });
    });
  });

  return {
    onData: (cb) => {
      const sub = pty.onData((chunk) => cb(chunk));
      return () => sub.dispose();
    },
    write: (text) => pty.write(text),
    kill: (signal) => pty.kill(signal),
    exit,
  };
}
