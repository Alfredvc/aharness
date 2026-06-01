#!/usr/bin/env node
/**
 * `aharness` CLI dispatcher.
 *
 * Subcommands:
 *
 *   - `aharness verify <file.fsm.ts>` — runs the FSM verifier (Task 37).
 *   - `aharness doctor` — environment diagnostics (Task 38).
 *   - `aharness completion install [--shell bash|zsh|fish]` — one-time
 *     shell-completion setup via `@pnpm/tabtab`.
 *   - `aharness completion uninstall` — removes the tabtab-installed
 *     completion script(s).
 *   - `aharness completion-server` — per-Tab bridge invoked by the
 *     shell-side delegate script that tabtab installs. Bounded by a 500 ms
 *     watchdog so a stuck import never hangs the user's shell. Bare
 *     `aharness completion` remains a compatibility alias for the bridge.
 *   - `aharness install <source>` — npm-backed installed package mutation.
 *   - `aharness run [--ask|--yolo] <file.fsm.ts|command>` — target execution.
 *   - `aharness list` — installed package command listing.
 *   - `aharness uninstall <package-name>` — npm-backed package removal.
 *   - `aharness visualize <file.fsm.ts>` — browser-only FSM inspection.
 *   - `aharness <file.fsm.ts>` — foreground boot (Phase 1: single-process).
 *
 * The `dispatch` function takes the argv slice and a `Dispatcher` of
 * function-shaped subcommand handlers; tests pass stubs and assert that
 * argv parsing routes to the right handler. The bottom of this file
 * wires the production handlers when the module is invoked directly.
 *
 * Phase 1b retirement: the `daemon-internal` and `mcp-internal`
 * subcommands and their `Dispatcher` fields were retired in commit
 * `T14a` — the headless Phase 1 boot runs the daemon in-process and
 * the MCP child has been replaced by codex's `dynamic_tools` channel.
 */
import { isAbsolute } from 'node:path';

import { runVerifyCli } from './verifyCli.js';
import { runDoctorCli } from './doctorCli.js';
import { runCli, type RunPermissionMode } from './runCli.js';
import { runVisualizeCli } from './visualizeCli.js';
import { runCompletionInstall, runCompletionUninstall } from './completion.js';
import { runCompletionBridge } from './completionBridge.js';
import { runInitCli } from './initCli.js';
import { runInstallCli } from './installCli.js';
import { runTargetCli } from './runTargetCli.js';
import { runListInstalledCli } from './listInstalledCli.js';
import { runVerifyInstalledCli } from './verifyInstalledCli.js';
import { runUninstallCli } from './uninstallCli.js';

export interface DispatchResult {
  readonly exitCode: number;
}

export interface Dispatcher {
  readonly runVerify: (o: { fsmPath: string }) => Promise<{ exitCode: number }>;
  readonly runDoctor: () => Promise<{ exitCode: number }>;
  readonly runDefault: (o: {
    fsmPath: string;
    inputArgs: ReadonlyArray<string>;
    permissionMode?: RunPermissionMode;
  }) => Promise<{ exitCode: number }>;
  readonly runVisualize: (o: {
    fsmPath: string;
    inputArgs: ReadonlyArray<string>;
  }) => Promise<{ exitCode: number }>;
  readonly runCompletionInstall: (o: {
    name?: string;
    completer?: string;
    shell?: 'bash' | 'zsh' | 'fish';
  }) => Promise<{ exitCode: number }>;
  readonly runCompletionUninstall: (o: { name?: string }) => Promise<{ exitCode: number }>;
  readonly runCompletionBridge: (o: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdout: NodeJS.WritableStream;
  }) => Promise<{ exitCode: number }>;
  readonly runInit: (o: {
    dir: string;
    force: boolean;
    git: boolean;
    install: boolean;
    pm?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  }) => Promise<{ exitCode: number }>;
  readonly runInstall: (o: { source: string }) => Promise<{ exitCode: number }>;
  readonly runTarget: (o: {
    target: string;
    inputArgs: ReadonlyArray<string>;
    permissionMode?: RunPermissionMode;
  }) => Promise<{ exitCode: number }>;
  readonly runListInstalled: (o: Record<string, never>) => Promise<{ exitCode: number }>;
  readonly runVerifyInstalled: (o: { target: string }) => Promise<{ exitCode: number }>;
  readonly runUninstall: (o: { packageName: string }) => Promise<{ exitCode: number }>;
  /** Sink for usage/error text. Tests inject a buffer; production uses stderr. */
  readonly stderr?: NodeJS.WritableStream;
}

export async function dispatch(
  argv: ReadonlyArray<string>,
  d: Dispatcher,
): Promise<DispatchResult> {
  const stderr = d.stderr ?? process.stderr;
  const [cmd, ...rest] = argv;
  if (cmd === 'verify') {
    if (rest.length !== 1 || !rest[0]) return { exitCode: usage(stderr) };
    const target = rest[0];
    if (isDirectVerifyTarget(target)) return d.runVerify({ fsmPath: target });
    return d.runVerifyInstalled({ target });
  }
  if (cmd === 'doctor') {
    return d.runDoctor();
  }
  if (cmd === 'completion-server') {
    return runCompletionBridgeWithWatchdog(d);
  }
  if (cmd === 'completion') {
    const sub = rest[0];
    if (sub === 'install') {
      const shellIdx = rest.indexOf('--shell');
      const shellVal = shellIdx >= 0 ? rest[shellIdx + 1] : undefined;
      const shell =
        shellVal === 'bash' || shellVal === 'zsh' || shellVal === 'fish' ? shellVal : undefined;
      return d.runCompletionInstall(shell ? { shell } : {});
    }
    if (sub === 'uninstall') return d.runCompletionUninstall({});
    if (sub === undefined) {
      return runCompletionBridgeWithWatchdog(d);
    }
    return { exitCode: usage(stderr) };
  }
  if (cmd === 'init') {
    const opts = parseInitArgs(rest);
    if (!opts) return { exitCode: usage(stderr) };
    return d.runInit(opts);
  }
  if (cmd === 'install') {
    const source = parseInstallSource(rest);
    if (!source) return { exitCode: usage(stderr) };
    return d.runInstall({ source });
  }
  if (cmd === 'run') {
    const parsed = parseRunTargetAndInputArgs(rest);
    if (!parsed) return { exitCode: usage(stderr) };
    return d.runTarget({
      target: parsed.target,
      inputArgs: parsed.inputArgs,
      ...(parsed.permissionMode !== undefined ? { permissionMode: parsed.permissionMode } : {}),
    });
  }
  if (cmd === 'list') {
    if (rest.length !== 0) return { exitCode: usage(stderr) };
    return d.runListInstalled({});
  }
  if (cmd === 'uninstall') {
    const packageName = parseUninstallPackageName(rest);
    if (!packageName) return { exitCode: usage(stderr) };
    return d.runUninstall({ packageName });
  }
  if (cmd === 'visualize') {
    const parsed = parseFsmPathAndInputArgs(rest);
    if (!parsed) return { exitCode: usage(stderr) };
    return d.runVisualize(parsed);
  }
  // Default form: `aharness <file.fsm.ts> [--<flag> <value>]…`.
  // Every `--<flag>` token and its non-flag value, if any, is collected
  // verbatim into `inputArgs` and forwarded to `runCli`, which calls
  // `parseInputFlags` against the loaded FSM's `inputFlags` after `loadFsm`.
  const parsedDefault = parseFsmPathAndInputArgs(argv, { consumeRuntimePermissionFlags: true });
  if (!parsedDefault) return { exitCode: usage(stderr) };

  return d.runDefault({
    fsmPath: parsedDefault.fsmPath,
    inputArgs: parsedDefault.inputArgs,
    ...(parsedDefault.permissionMode !== undefined
      ? { permissionMode: parsedDefault.permissionMode }
      : {}),
  });
}

function parseUninstallPackageName(args: ReadonlyArray<string>): string | null {
  if (args.length !== 1) return null;
  const packageName = args[0]!;
  if (packageName.length === 0 || packageName.startsWith('-')) return null;
  return packageName;
}

function parseInstallSource(args: ReadonlyArray<string>): string | null {
  if (args.length !== 1) return null;
  const source = args[0]!;
  if (source.length === 0 || source.startsWith('-')) return null;
  return source;
}

function isDirectVerifyTarget(target: string): boolean {
  return (
    target.endsWith('.fsm.ts') ||
    target.startsWith('./') ||
    target.startsWith('../') ||
    isAbsolute(target)
  );
}

async function runCompletionBridgeWithWatchdog(d: Dispatcher): Promise<{ exitCode: number }> {
  // Per-Tab bridge — wrap in a 500 ms watchdog at the dispatcher level.
  // process.exit lives at the binary's `.then` handler, NOT inside
  // runCompletionBridge — putting `process.exit` in the bridge would
  // kill the test runner when the bridge is unit-tested.
  const WATCHDOG_MS = 500;
  return Promise.race([
    d.runCompletionBridge({ env: process.env, cwd: process.cwd(), stdout: process.stdout }),
    new Promise<{ exitCode: number }>((resolve) =>
      setTimeout(() => resolve({ exitCode: 0 }), WATCHDOG_MS),
    ),
  ]);
}

function parseFsmPathAndInputArgs(
  argv: ReadonlyArray<string>,
  opts: { consumeRuntimePermissionFlags?: boolean } = {},
): {
  fsmPath: string;
  inputArgs: ReadonlyArray<string>;
  permissionMode?: RunPermissionMode;
} | null {
  const positional: string[] = [];
  const inputArgs: string[] = [];
  let permissionMode: RunPermissionMode | undefined;
  // The verbs (`verify`, `doctor`, `completion`, `init`, `visualize`) have already been
  // triaged by the early-returns above. The loop below scans the same `argv`
  // only because no verb matched; the remaining tokens are the FSM path and
  // any user-defined `--<flag>` pairs.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const runtimePermissionMode = runtimePermissionModeFromFlag(a);
    if (opts.consumeRuntimePermissionFlags && runtimePermissionMode) {
      if (permissionMode !== undefined && permissionMode !== runtimePermissionMode) return null;
      permissionMode = runtimePermissionMode;
      continue;
    }
    if (!opts.consumeRuntimePermissionFlags && runtimePermissionMode) return null;
    if (a.startsWith('--')) {
      inputArgs.push(a);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        inputArgs.push(next);
        i++;
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length !== 1) return null;
  return {
    fsmPath: positional[0]!,
    inputArgs,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}

function parseRunTargetAndInputArgs(
  argv: ReadonlyArray<string>,
): { target: string; inputArgs: ReadonlyArray<string>; permissionMode?: RunPermissionMode } | null {
  let index = 0;
  let permissionMode: RunPermissionMode | undefined;

  const leadingPermissionMode = runtimePermissionModeFromFlag(argv[index]);
  if (leadingPermissionMode) {
    permissionMode = leadingPermissionMode;
    index++;
  }

  const target = argv[index];
  if (!target || target.startsWith('-')) return null;
  index++;

  const inputArgs = argv.slice(index);
  for (let i = 0; i < inputArgs.length; i++) {
    const current = inputArgs[i]!;
    if (!current.startsWith('--')) return null;
    if (runtimePermissionModeFromFlag(current)) return null;
    const next = inputArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) i++;
  }

  return { target, inputArgs, ...(permissionMode !== undefined ? { permissionMode } : {}) };
}

function runtimePermissionModeFromFlag(flag: string | undefined): RunPermissionMode | null {
  if (flag === '--ask') return 'ask';
  if (flag === '--yolo') return 'yolo';
  return null;
}

function parseInitArgs(args: ReadonlyArray<string>): {
  dir: string;
  force: boolean;
  git: boolean;
  install: boolean;
  pm?: 'npm' | 'pnpm' | 'yarn' | 'bun';
} | null {
  let dir: string | null = null;
  let force = false;
  let git = true;
  let install = true;
  let pm: 'npm' | 'pnpm' | 'yarn' | 'bun' | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--force') {
      force = true;
      continue;
    }
    if (a === '--no-git') {
      git = false;
      continue;
    }
    if (a === '--no-install') {
      install = false;
      continue;
    }
    if (a === '--dir') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return null;
      dir = v;
      continue;
    }
    if (a === '--pm') {
      const v = args[++i];
      if (v !== 'npm' && v !== 'pnpm' && v !== 'yarn' && v !== 'bun') return null;
      pm = v;
      continue;
    }
    return null; // unknown flag/positional
  }
  if (dir === null) return null;
  return pm ? { dir, force, git, install, pm } : { dir, force, git, install };
}

function usage(stderr: NodeJS.WritableStream): number {
  stderr.write(
    'usage:\n' +
      '  aharness [--ask|--yolo] <file.fsm.ts> [--<flag> <value>]...\n' +
      '  aharness visualize <file.fsm.ts> [--<flag> <value>]...\n' +
      '  aharness init --dir <path> [--force] [--no-git] [--no-install] [--pm <npm|pnpm|yarn|bun>]\n' +
      '  aharness install <source>\n' +
      '  aharness verify <file.fsm.ts>\n' +
      '  aharness verify <package-name>\n' +
      '  aharness verify <package-name>/<command-name>\n' +
      '  aharness run [--ask|--yolo] <file.fsm.ts|command> [--<flag> <value>]...\n' +
      '  aharness list\n' +
      '  aharness uninstall <package-name>\n' +
      '  aharness doctor\n' +
      '  aharness completion install [--shell bash|zsh|fish]   # one-time shell setup\n' +
      '  aharness completion uninstall\n',
  );
  return 2;
}

// Production wiring. Only runs when this module is the entrypoint.
if (process.argv[1]?.endsWith('main.js')) {
  void dispatch(process.argv.slice(2), {
    runVerify: ({ fsmPath }) =>
      runVerifyCli({ fsmPath, log: (s) => process.stderr.write(s + '\n') }),
    runDoctor: () =>
      runDoctorCli({
        log: (s) => process.stdout.write(s + '\n'),
        now: () => new Date(),
      }),
    runDefault: ({ fsmPath, inputArgs, permissionMode }) => {
      const opts = {
        fsmPath,
        cwd: process.cwd(),
        stderr: process.stderr,
        stdout: process.stdout,
        inputArgs,
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      };
      return runCli(opts);
    },
    runVisualize: ({ fsmPath, inputArgs }) =>
      runVisualizeCli({
        fsmPath,
        cwd: process.cwd(),
        stderr: process.stderr,
        stdout: process.stdout,
        inputArgs,
      }),
    runCompletionInstall: (o) => runCompletionInstall(o),
    runCompletionUninstall: (o) => runCompletionUninstall(o),
    runCompletionBridge: (o) => runCompletionBridge(o),
    runInit: ({ dir, force, git, install, pm }) =>
      runInitCli({
        dir,
        force,
        git,
        install,
        ...(pm ? { pm } : {}),
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    runInstall: ({ source }) =>
      runInstallCli({
        source,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    runTarget: ({ target, inputArgs, permissionMode }) => {
      const opts = {
        target,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
        inputArgs,
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      };
      return runTargetCli(opts);
    },
    runListInstalled: () =>
      runListInstalledCli({
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    runVerifyInstalled: ({ target }) =>
      runVerifyInstalledCli({
        target,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    runUninstall: ({ packageName }) =>
      runUninstallCli({
        packageName,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
  }).then((r) => {
    process.exit(r.exitCode);
  });
}
