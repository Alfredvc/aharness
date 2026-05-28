import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawnAppServer, waitForWs } from '../src/appServer/spawn.js';
import { connectWs } from '../src/jsonrpc/wsTransport.js';
import { pickEphemeralPort } from '../src/appServer/port.js';

const hasCodex = (() => {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('waitForWs (real WS handshake probe)', () => {
  it('keeps polling while the server accepts TCP but has not wired the WS upgrade yet', async () => {
    // Start a plain HTTP server that accepts TCP connections immediately
    // but delays attaching its WebSocket upgrade handler by 200ms. A
    // bare TCP probe would resolve at t=0; the real-handshake probe must
    // keep retrying until the upgrade handler exists.
    const port = await pickEphemeralPort('127.0.0.1');
    const url = `ws://127.0.0.1:${port}`;
    const http: Server = createServer();
    await new Promise<void>((r) => http.listen(port, '127.0.0.1', () => r()));
    let wss: WebSocketServer | undefined;
    const upgradeWiredAt = Date.now() + 200;
    const wireUpgrade = setTimeout(() => {
      wss = new WebSocketServer({ noServer: true });
      http.on('upgrade', (req, socket, head) => {
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wss!.emit('connection', ws, req);
        });
      });
    }, 200);

    try {
      const start = Date.now();
      await waitForWs(url, 5_000, () => false);
      const elapsed = Date.now() - start;
      // Probe must not have succeeded before the upgrade handler was wired.
      expect(elapsed).toBeGreaterThanOrEqual(upgradeWiredAt - start - 50);
    } finally {
      clearTimeout(wireUpgrade);
      wss?.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });

  it('rejects when the process exits before the handshake completes', async () => {
    const port = await pickEphemeralPort('127.0.0.1');
    const url = `ws://127.0.0.1:${port}`;
    let exited = false;
    setTimeout(() => {
      exited = true;
    }, 100);
    await expect(waitForWs(url, 5_000, () => exited)).rejects.toThrow(/exited before WS handshake/);
  });

  it('times out when the endpoint never speaks WebSocket', async () => {
    // Listen on a TCP port that never responds to the upgrade. The probe
    // should give up at the readiness deadline rather than hanging.
    const port = await pickEphemeralPort('127.0.0.1');
    const url = `ws://127.0.0.1:${port}`;
    const http = createServer();
    await new Promise<void>((r) => http.listen(port, '127.0.0.1', () => r()));
    try {
      await expect(waitForWs(url, 300, () => false)).rejects.toThrow(
        /timeout waiting for WS handshake/,
      );
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});

describe.skipIf(!hasCodex)('spawnAppServer', () => {
  it('boots, accepts a WS connection, then shuts down on close()', async () => {
    // Isolate codex's HOME to a tmpdir so the test does not touch the
    // user's `~/.codex/`. spawnAppServer no longer sets CODEX_HOME on its
    // own; callers that need isolation pass it via `extraEnv`.
    const dir = mkdtempSync(join(tmpdir(), 'h-as-'));
    const codexHome = join(dir, 'codex_home');
    mkdirSync(codexHome, { recursive: true });
    const handle = await spawnAppServer({ extraEnv: { CODEX_HOME: codexHome } });
    try {
      const t = await connectWs(handle.wsUrl, { timeoutMs: 5_000 });
      await t.close?.();
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
