#!/usr/bin/env node
/**
 * Completion-only binary entrypoint.
 *
 * New tabtab installs call `aharness-completion completion-server ...` so each
 * Tab press avoids the full `cli/main.ts` dispatcher module graph.
 */
import type { CompletionBridgeOpts } from './completionBridge.js';
import { ROOT_SUBCOMMANDS } from './completionCommands.js';

export interface CompletionMainOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly runCompletionBridge?: (
    opts: CompletionBridgeOpts,
  ) => Promise<{ readonly exitCode: number }>;
  readonly watchdogMs?: number;
}

export async function runCompletionMain(
  opts: CompletionMainOptions,
): Promise<{ readonly exitCode: number }> {
  const cmd = opts.argv[0];
  if (cmd !== undefined && cmd !== 'completion-server') {
    return { exitCode: 0 };
  }

  if (emitRootCompletion(opts.env, opts.stdout)) {
    return { exitCode: 0 };
  }

  const watchdogMs = opts.watchdogMs ?? 500;
  const bridgePromise = opts.runCompletionBridge
    ? opts.runCompletionBridge({ env: opts.env, cwd: opts.cwd, stdout: opts.stdout })
    : import('./completionBridge.js').then(({ runCompletionBridge }) =>
        runCompletionBridge({ env: opts.env, cwd: opts.cwd, stdout: opts.stdout }),
      );
  return Promise.race([
    bridgePromise,
    new Promise<{ readonly exitCode: number }>((resolve) =>
      setTimeout(() => resolve({ exitCode: 0 }), watchdogMs),
    ),
  ]);
}

function emitRootCompletion(env: NodeJS.ProcessEnv, stdout: NodeJS.WritableStream): boolean {
  const line = env['COMP_LINE'];
  if (typeof line !== 'string') return false;

  const rawPoint = env['COMP_POINT'];
  const parsedPoint = rawPoint === undefined ? line.length : Number.parseInt(rawPoint, 10);
  const point = Number.isFinite(parsedPoint)
    ? Math.max(0, Math.min(parsedPoint, line.length))
    : line.length;
  const upToCursor = line.slice(0, point);
  const tokens = upToCursor.trimStart().split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'aharness') return false;

  const trailingWhitespace = /\s$/.test(upToCursor);
  let partial: string;
  if (tokens.length === 1) {
    partial = '';
  } else if (tokens.length === 2 && !trailingWhitespace) {
    partial = tokens[1]!;
  } else if (tokens.length === 2 && trailingWhitespace) {
    return false;
  } else {
    return false;
  }

  for (const command of ROOT_SUBCOMMANDS) {
    if (command.startsWith(partial)) stdout.write(`${command}\n`);
  }
  return true;
}

if (process.argv[1]?.endsWith('completionMain.js')) {
  void runCompletionMain({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
  }).then((result) => {
    process.exit(result.exitCode);
  });
}
