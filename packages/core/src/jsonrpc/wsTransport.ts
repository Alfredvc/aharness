/**
 * WebSocket {@link Transport} for the JSON-RPC client.
 *
 * Intended use: aharness ↔ codex `app-server`. Codex's app-server speaks
 * WebSocket framing on both its TCP and UDS transports — see
 * `app-server-transport/src/transport/websocket.rs` and
 * `app-server-transport/src/transport/unix_socket.rs:78` (`accept_async`) at
 * the pinned codex commit. This is therefore the primary transport for
 * aharness↔codex traffic; one JSON-RPC message per WS Text frame.
 *
 * For aharness-internal line-delimited UDS traffic, use `udsTransport.ts`
 * instead — that path is for aharness components, not for talking to codex.
 */

import WebSocket from 'ws';
import type { Transport } from './client.js';

export interface WsTransport extends Transport {
  readonly url: string;
}

export function connectWs(url: string, opts: { timeoutMs?: number } = {}): Promise<WsTransport> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`ws: connect timeout to ${url}`));
    }, timeoutMs);

    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);

      const transport: WsTransport = {
        url,
        send(m) {
          ws.send(JSON.stringify(m));
        },
        async close() {
          await new Promise<void>((r) => {
            ws.once('close', () => r());
            ws.close();
          });
        },
      };
      ws.on('message', (data) => {
        // `ws` emits Buffer | ArrayBuffer | Buffer[] for binary frames and a
        // string for text frames. Coerce all of them to a single utf-8 string.
        let text: string;
        if (typeof data === 'string') {
          text = data;
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString('utf8');
        } else if (data instanceof ArrayBuffer) {
          text = Buffer.from(data).toString('utf8');
        } else {
          text = data.toString('utf8');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        transport.onMessage?.(parsed);
      });
      ws.on('close', () => transport.onClose?.());
      ws.on('error', () => {
        /* surfaced via close */
      });
      resolve(transport);
    });
    ws.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(e);
    });
  });
}
