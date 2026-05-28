import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { connectHeadlessWs } from '../src/transport/wsClient.js';

describe('connectHeadlessWs', () => {
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups = [];
  });

  it('opens WS-over-Unix and sends initialize with camelCase clientInfo + optOutNotificationMethods', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h-ws-'));
    cleanups.push(async () => rmSync(tmp, { recursive: true, force: true }));
    const sockPath = join(tmp, 's.sock');
    // http.Server (not net.Server) emits 'upgrade' for WS handshakes.
    const http: HttpServer = createHttpServer();
    const wss = new WebSocketServer({ noServer: true });
    let extensionHeader: string | string[] | undefined;
    http.on('upgrade', (req, socket, head) => {
      extensionHeader = req.headers['sec-websocket-extensions'];
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    await new Promise<void>((r) => http.listen(sockPath, () => r()));
    cleanups.push(
      async () =>
        await new Promise<void>((r) => {
          http.close(() => r());
        }),
    );
    const initParams: unknown[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString('utf8')) as {
          id?: number | string;
          method?: string;
          params?: unknown;
        };
        if (m.method === 'initialize') {
          initParams.push(m.params);
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id,
              result: { serverInfo: { name: 'stub', version: '0' } },
            }),
          );
        }
      });
    });
    const { close } = await connectHeadlessWs({
      sockPath,
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      optOutNotificationMethods: ['fs/changed'],
    });
    cleanups.push(close);
    expect(initParams).toHaveLength(1);
    const params = initParams[0] as {
      clientInfo: { name: string; version: string };
      capabilities: { optOutNotificationMethods: string[] };
    };
    expect(params.clientInfo).toEqual({ name: 'codex_app_server_daemon', version: '0.0.0' });
    expect(params.capabilities.optOutNotificationMethods).toEqual(['fs/changed']);
    expect(extensionHeader).toBeUndefined();
  });

  it('invokes registerHandlers synchronously before sending initialize (M18)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h-ws-'));
    cleanups.push(async () => rmSync(tmp, { recursive: true, force: true }));
    const sockPath = join(tmp, 's.sock');
    const http: HttpServer = createHttpServer();
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    await new Promise<void>((r) => http.listen(sockPath, () => r()));
    cleanups.push(
      async () =>
        await new Promise<void>((r) => {
          http.close(() => r());
        }),
    );

    const order: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString('utf8')) as { id?: number | string; method?: string };
        if (m.method === 'initialize') {
          order.push('server-saw-initialize');
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id,
              result: { serverInfo: { name: 'stub', version: '0' } },
            }),
          );
        }
      });
    });
    const { close } = await connectHeadlessWs({
      sockPath,
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      registerHandlers: (client) => {
        order.push('registerHandlers');
        // Register a handler to prove the client object is usable in the
        // callback; the handler need not be invoked during this test.
        client.onServerRequest('item/tool/call', () => ({ contentItems: [], success: true }));
      },
    });
    cleanups.push(close);
    expect(order).toEqual(['registerHandlers', 'server-saw-initialize']);
  });

  it('rejects with a timeout error when the socket cannot be reached', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h-ws-'));
    cleanups.push(async () => rmSync(tmp, { recursive: true, force: true }));
    const sockPath = join(tmp, 'does-not-exist.sock');
    await expect(
      connectHeadlessWs({
        sockPath,
        clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
        connectTimeoutMs: 100,
      }),
    ).rejects.toThrow();
  });
});
