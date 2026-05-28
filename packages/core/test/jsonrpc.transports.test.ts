import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWs } from '../src/jsonrpc/wsTransport.js';
import { connectUds } from '../src/jsonrpc/udsTransport.js';

describe('WS transport', () => {
  it('round-trips a JSON message', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(m.toString())));
    const port = (wss.address() as { port: number }).port;
    const t = await connectWs(`ws://127.0.0.1:${port}`);
    const got = new Promise((resolve) => {
      t.onMessage = (m) => resolve(m);
    });
    t.send({ hello: 'world' });
    await expect(got).resolves.toEqual({ hello: 'world' });
    await t.close?.();
    wss.close();
  });
});

describe('UDS transport', () => {
  it('round-trips a JSON message via line-delimited framing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-uds-'));
    const sockPath = join(dir, 's.sock');
    const server = createNetServer((c) => c.on('data', (d) => c.write(d)));
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    try {
      const t = await connectUds(sockPath);
      const got = new Promise((resolve) => {
        t.onMessage = (m) => resolve(m);
      });
      t.send({ hello: 'uds' });
      await expect(got).resolves.toEqual({ hello: 'uds' });
      await t.close?.();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
