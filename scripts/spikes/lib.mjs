// scripts/spikes/lib.mjs
//
// Shared helpers for the headless-codex empirical spike aharness.
// See docs/ideas/2026-05-11-headless-spikes.md §"Spike aharness shape".
//
// Spikes are deliberately decoupled from `packages/core` so a
// regression in the SDK cannot mask a codex-substrate regression. The
// JSON-RPC + WS code here is a minimal re-implementation; deps are
// node built-ins only (Node 22+ ships a global `WebSocket`).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';

// ---------- monotonic clock --------------------------------------------------

export function now() {
  return performance.now();
}

// ---------- ephemeral port ---------------------------------------------------

export function pickEphemeralPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || addr === null) {
        srv.close();
        reject(new Error('listen returned no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------- codex app-server spawn ------------------------------------------

// Spawns `codex app-server --listen ws://127.0.0.1:<port>` and waits for
// the WS handshake to succeed. Mirrors packages/core/src/appServer/spawn.ts
// but kept inline so the spike aharness depends on nothing in the SDK.
//
// `cliOverrides` is an array of `[key, value]` rendered as repeated
// `-c key=value`. TOML escaping is the caller's job (use `tomlStr` below).
export async function spawnAppServer({
  cliOverrides = [],
  enabledFeatures = [],
  extraEnv = {},
  readinessTimeoutMs = 5_000,
  stderrSink = null,
  host = '127.0.0.1',
} = {}) {
  const port = await pickEphemeralPort(host);
  const wsUrl = `ws://${host}:${port}`;
  const args = ['app-server', '--listen', wsUrl];
  for (const f of enabledFeatures) args.push('--enable', f);
  for (const [k, v] of cliOverrides) args.push('-c', `${k}=${v}`);

  const child = spawn('codex', args, {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => {
    stderrChunks.push(s);
    if (stderrSink) stderrSink(s);
  });

  let exited = false;
  let exitCode = null;
  let spawnErr = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  // Node emits 'error' (ENOENT etc.) BEFORE 'exit' for spawn failures.
  // Without a handler the EventEmitter throws synchronously and aborts the
  // process before waitForWs can observe the failure.
  child.once('error', (e) => {
    exited = true;
    spawnErr = e;
  });

  try {
    await waitForWs(wsUrl, readinessTimeoutMs, () => exited);
  } catch (e) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Best-effort cleanup after readiness failure.
    }
    const reason = spawnErr
      ? `spawn failed: ${spawnErr.code ?? ''} ${spawnErr.message}`
      : e.message;
    throw new Error(
      `app-server failed to become ready at ${wsUrl}: ${reason}\nstderr:\n${stderrChunks.join('')}`,
      { cause: e },
    );
  }

  return {
    wsUrl,
    port,
    child,
    stderr: () => stderrChunks.join(''),
    async close() {
      if (exited) return exitCode;
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
      return exitCode;
    },
  };
}

async function waitForWs(url, timeoutMs, exited) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    if (exited()) throw new Error('app-server exited before WS handshake');
    try {
      await probeWsOnce(url, 500);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(50);
    }
  }
  throw new Error(`timeout waiting for WS handshake: ${lastErr?.message ?? 'unknown'}`);
}

function probeWsOnce(url, perAttemptTimeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Best-effort cleanup after handshake timeout.
      }
      reject(new Error('handshake timeout'));
    }, perAttemptTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        // Best-effort cleanup after successful probe.
      }
      resolve();
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(t);
      reject(new Error(ev.message ?? 'ws error'));
    });
  });
}

// ---------- JSON-RPC client over Node's built-in WebSocket -------------------

// Every send and recv goes through `onWire(direction, msg, timestamp)` so
// the spike can dump a full wire log. `direction` is 'send' or 'recv'.
//
// Server-requests (codex → us) are handled by `onServerRequest(method, h)`.
// Unhandled server-requests get a -32601 reply.
export async function connectJsonRpc(url, { onWire = null, connectTimeoutMs = 5_000 } = {}) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Best-effort cleanup after connect timeout.
      }
      reject(new Error(`ws connect timeout: ${url}`));
    }, connectTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(t);
      reject(new Error(ev.message ?? 'ws error'));
    });
  });

  let nextId = 1;
  const pending = new Map();
  const notifSubs = new Map();
  const serverHandlers = new Map();
  let closed = false;

  function send(msg) {
    if (closed) return;
    const text = JSON.stringify(msg);
    if (onWire) onWire('send', msg, now());
    ws.send(text);
  }

  ws.addEventListener('message', (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (onWire) onWire('recv', msg, now());
    if (msg && typeof msg === 'object') {
      if (msg.method && msg.id !== undefined) {
        // server-request
        void handleServerRequest(msg.id, msg.method, msg.params);
        return;
      }
      if (msg.method) {
        const subs = notifSubs.get(msg.method);
        if (subs)
          for (const h of subs) {
            try {
              h(msg.params);
            } catch {
              // Notification observers are isolated from transport handling.
            }
          }
        return;
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`jsonrpc error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  });

  ws.addEventListener('close', () => {
    closed = true;
    for (const [, p] of pending) p.reject(new Error('ws closed'));
    pending.clear();
  });
  ws.addEventListener('error', () => {
    /* surfaced via close */
  });

  async function handleServerRequest(id, method, params) {
    const h = serverHandlers.get(method);
    if (!h) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      return;
    }
    try {
      const result = await h(params);
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: e?.message ?? 'handler error' },
      });
    }
  }

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error('ws closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    onNotification(method, h) {
      const set = notifSubs.get(method) ?? new Set();
      set.add(h);
      notifSubs.set(method, set);
      return () => set.delete(h);
    },
    onServerRequest(method, h) {
      if (serverHandlers.has(method)) throw new Error(`handler already registered for ${method}`);
      serverHandlers.set(method, h);
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((r) => {
        ws.addEventListener('close', () => r(), { once: true });
        try {
          ws.close();
        } catch {
          r();
        }
      });
    },
    isClosed: () => closed,
  };
}

// ---------- utilities --------------------------------------------------------

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Render a TOML basic-string with codex-config-style quoting. Backslash and
// double-quote get escaped; everything else passes through.
export function tomlStr(s) {
  return `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
