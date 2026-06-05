/**
 * Spawns the Codex `app-server` as a child process and waits until its
 * WebSocket endpoint is ready for JSON-RPC traffic.
 *
 * The codex CLI surface verified at the pinned commit:
 *   - `codex app-server --listen <URL>` — accepts `ws://IP:PORT`,
 *     `unix://`, `unix://PATH`, `stdio://` (default), or `off`.
 *     Source: codex-rs/cli/src/main.rs:418-423 (the `AppServerCommand`
 *     `--listen` arg) and codex-rs/app-server/src/main.rs:23-28 (the
 *     `AppServerArgs` `--listen` arg). We pass either
 *     `ws://127.0.0.1:<port>` (TCP path) or `unix://<sockPath>` (Unix
 *     path, spec §4.2). The aharness connects over the same WebSocket
 *     transport `wsTransport.ts` already speaks; the Unix path uses
 *     ws library's `socketPath` option (see transport/wsClient.ts).
 *
 * Readiness is probed with a real WebSocket handshake (R9, TCP path)
 * or a bare Unix `connect()` probe (Unix path): codex's app-server binds
 * the TCP listener before the WS upgrade handler is wired, so a
 * TCP-accept-based probe can race ahead of the handshake and the first
 * JSON-RPC frame would be lost. The Unix path is race-free because
 * codex only listens once the WS upgrade handler is wired (spec §4.1).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { pickEphemeralPort } from './port.js';

export interface AppServerHandle {
  readonly wsUrl: string;
  /**
   * Ephemeral TCP port the app-server listens on. `null` when spawned
   * with the Unix transport (`sockPath` set); callers reading `port`
   * unconditionally remain on the TCP path during Phase 1a.
   */
  readonly port: number | null;
  readonly child: ChildProcess;
  close(): Promise<void>;
}

export interface SpawnAppServerOptions {
  /**
   * TCP host to bind. Mutually exclusive with `sockPath`. Defaults to
   * `'127.0.0.1'` only when neither `host` nor `sockPath` is supplied;
   * if both are supplied the spawn throws synchronously before exec.
   */
  readonly host?: string;
  /**
   * Absolute path to a Unix-domain socket. When provided, codex is
   * spawned with `--listen unix://<sockPath>` and the returned
   * `wsUrl` is `ws+unix://<sockPath>` (informational only —
   * `transport/wsClient.ts` decodes the prefix and uses the ws library's
   * `socketPath` option). Spec §4.2. Mutually exclusive with `host`.
   */
  readonly sockPath?: string;
  readonly readinessTimeoutMs?: number;
  readonly extraEnv?: Record<string, string>;
  readonly stderrSink?: (chunk: string) => void;
  /**
   * Per-run codex CLI overrides, rendered as repeated `-c key=value` args
   * in declaration order. Values are TOML-literal strings (e.g.
   * `'"mock"'`, `'42'`, `'[{...}]'`); the caller is responsible for any
   * required TOML escaping (see `escapeTomlBasicString`).
   */
  readonly cliOverrides?: ReadonlyArray<readonly [string, string]>;
  /**
   * Per-run codex feature flags, rendered as repeated `--enable feature`
   * args in declaration order. Each entry is the bare feature name as
   * registered by codex's `FeaturesToml` map.
   */
  readonly enabledFeatures?: ReadonlyArray<string>;
}

/**
 * Test-only seam for `spawnAppServer`. Allows tests to inject a stub
 * `spawn` (capturing argv without booting a real binary) and a stub
 * `waitForReady` (skipping the WS/Unix probe). Production callers use
 * `spawnAppServer`, which threads through to the real implementations.
 */
export interface SpawnAppServerForTestOpts extends SpawnAppServerOptions {
  readonly spawn?: typeof spawn;
  readonly waitForReady?: (handle: { wsUrl: string }) => Promise<void>;
}

/**
 * Spawns `codex app-server --listen <listenArg>` and resolves once the
 * server is ready to accept JSON-RPC traffic. The exact listen shape
 * depends on which mutually-exclusive option is supplied:
 *
 *   - `sockPath` → `unix://<sockPath>` (spec §4.2). Readiness is a Unix
 *     `connect()` probe — codex only binds the socket once the WS
 *     upgrade handler is wired.
 *   - `host` → `ws://<host>:<port>` with an ephemeral port. Readiness
 *     is a real WebSocket handshake (codex binds the TCP listener
 *     before wiring the WS upgrade handler).
 *   - neither → defaults to `host = '127.0.0.1'` (TCP path) so existing
 *     production callers stay on TCP through Phase 1a.
 *   - both → throws synchronously before exec.
 *
 * The returned handle owns the child; call `close()` to terminate it.
 * `close()` sends `SIGTERM` first and falls back to `SIGKILL` after a
 * 2-second grace period if the child has not exited.
 */
export async function spawnAppServer(opts: SpawnAppServerOptions): Promise<AppServerHandle> {
  return spawnAppServerImpl(opts, spawn, defaultWaitForReady);
}

/**
 * Test-only entry point: injects `spawn` and `waitForReady` so tests can
 * capture argv without booting a real binary. Behaves identically to
 * `spawnAppServer` otherwise.
 */
export async function spawnAppServerForTest(
  opts: SpawnAppServerForTestOpts,
): Promise<AppServerHandle> {
  const realSpawn: typeof spawn = opts.spawn ?? spawn;
  const waitForReady = opts.waitForReady ?? defaultWaitForReady;
  return spawnAppServerImpl(opts, realSpawn, waitForReady);
}

interface ListenPlan {
  readonly listenArg: string;
  readonly wsUrl: string;
  readonly port: number | null;
  readonly sockPath: string | null;
  readonly probe: (timeoutMs: number, exited: () => boolean) => Promise<void>;
}

/**
 * Returns the listen-plan parts that are knowable WITHOUT allocating a
 * port (i.e. validate the option pair, and short-circuit on the
 * Unix-socket branch). The TCP branch returns `null` to signal that the
 * caller must `pickEphemeralPort` itself; this keeps the port-pick
 * `await` co-located with the `child.once('exit', ...)` registration so
 * tests that race a `queueMicrotask` exit emit against the spawn don't
 * lose the event in an unrelated microtask hop.
 */
function planExceptPort(opts: SpawnAppServerOptions): ListenPlan | null {
  const hasSock = opts.sockPath !== undefined;
  const hasHost = opts.host !== undefined;
  if (hasSock && hasHost) {
    throw new Error('spawnAppServer: pass exactly one of `sockPath` or `host`, not both');
  }
  if (hasSock) {
    const sockPath = opts.sockPath;
    return {
      listenArg: `unix://${sockPath}`,
      // Informational only; the WS client decodes the `ws+unix://` prefix
      // and dials via the ws library's `socketPath` option.
      wsUrl: `ws+unix://${sockPath}`,
      port: null,
      sockPath,
      probe: (timeoutMs, exited) => waitForUnix(sockPath, timeoutMs, exited),
    };
  }
  return null;
}

async function spawnAppServerImpl(
  opts: SpawnAppServerOptions,
  spawnFn: typeof spawn,
  waitForReady: (handle: {
    wsUrl: string;
    port: number | null;
    sockPath: string | null;
    timeoutMs: number;
    exited: () => boolean;
    probe: (timeoutMs: number, exited: () => boolean) => Promise<void>;
  }) => Promise<void>,
): Promise<AppServerHandle> {
  // Validation + Unix-branch plan resolved synchronously. The TCP branch
  // performs the port-pick await inline so the only async hop between
  // `pickEphemeralPort` and the `child.once('exit')` listener is the
  // single `await` below (matching the pre-refactor structure).
  let plan = planExceptPort(opts);
  if (plan === null) {
    const host = opts.host ?? '127.0.0.1';
    const port = await pickEphemeralPort(host);
    const wsUrl = `ws://${host}:${port}`;
    plan = {
      listenArg: wsUrl,
      wsUrl,
      port,
      sockPath: null,
      probe: (timeoutMs, exited) => waitForWs(wsUrl, timeoutMs, exited),
    };
  }
  const env = {
    ...process.env,
    ...opts.extraEnv,
  };
  const args: string[] = ['app-server', '--listen', plan.listenArg];
  for (const f of opts.enabledFeatures ?? []) args.push('--enable', f);
  for (const [k, v] of opts.cliOverrides ?? []) args.push('-c', `${k}=${v}`);
  const child = spawnFn('codex', args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const childError = new Promise<Error>((resolve) => {
    child.once('error', resolve);
  });

  const stderrLines: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (s: string) => {
    stderrLines.push(s);
    opts.stderrSink?.(s);
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const timeoutMs = opts.readinessTimeoutMs ?? 5_000;
  try {
    const readyResult = await Promise.race([
      waitForReady({
        wsUrl: plan.wsUrl,
        port: plan.port,
        sockPath: plan.sockPath,
        timeoutMs,
        exited: () => exited,
        probe: plan.probe,
      }).then(() => null),
      childError,
    ]);
    if (readyResult !== null) {
      throw readyResult;
    }
  } catch (e) {
    child.kill('SIGTERM');
    throw new Error(
      `app-server failed to become ready at ${plan.wsUrl} for command: codex ${args.join(' ')}\n` +
        `reason: ${(e as Error).message}\nstderr:\n${stderrLines.join('')}`,
      { cause: e },
    );
  }

  return {
    wsUrl: plan.wsUrl,
    port: plan.port,
    child,
    async close() {
      if (exited) return;
      child.kill('SIGTERM');
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}

async function defaultWaitForReady(handle: {
  wsUrl: string;
  port: number | null;
  sockPath: string | null;
  timeoutMs: number;
  exited: () => boolean;
  probe: (timeoutMs: number, exited: () => boolean) => Promise<void>;
}): Promise<void> {
  await handle.probe(handle.timeoutMs, handle.exited);
}

/**
 * Polls a `ws://` URL with real WebSocket handshakes until one succeeds
 * or the deadline expires. A successful `open` event proves the server
 * has finished wiring the WS upgrade handler — bare TCP connect is not
 * sufficient because codex's app-server accepts the TCP socket before
 * the handshake handler is registered.
 */
export async function waitForWs(
  url: string,
  timeoutMs: number,
  exited: () => boolean,
): Promise<void> {
  const start = Date.now();
  let lastErr: Error | undefined;
  while (Date.now() - start < timeoutMs) {
    if (exited()) {
      throw new Error('app-server exited before WS handshake');
    }
    try {
      await probeOnce(url, 500);
      return;
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`timeout waiting for WS handshake: ${lastErr?.message ?? 'unknown'}`);
}

function probeOnce(url: string, perAttemptTimeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('handshake timeout'));
    }, perAttemptTimeoutMs);
    ws.once('open', () => {
      clearTimeout(t);
      ws.close();
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * Polls a Unix-domain socket with `connect()` attempts until one
 * succeeds or the deadline expires. Bare connect is sufficient for the
 * Unix path because codex only binds the socket once the WS upgrade
 * handler is wired (spec §4.1) — there is no equivalent race to the
 * TCP-listen-before-upgrade-handler one that motivated `waitForWs`.
 */
export async function waitForUnix(
  sockPath: string,
  timeoutMs: number,
  exited: () => boolean,
): Promise<void> {
  const start = Date.now();
  let lastErr: Error | undefined;
  while (Date.now() - start < timeoutMs) {
    if (exited()) {
      throw new Error('app-server exited before Unix socket was ready');
    }
    try {
      await probeOnceUnix(sockPath, 500);
      return;
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`timeout waiting for Unix socket: ${lastErr?.message ?? 'unknown'}`);
}

function probeOnceUnix(sockPath: string, perAttemptTimeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = createConnection({ path: sockPath });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('connect timeout'));
    }, perAttemptTimeoutMs);
    sock.once('connect', () => {
      clearTimeout(t);
      sock.destroy();
      resolve();
    });
    sock.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
