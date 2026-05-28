/**
 * Line-delimited Unix-domain-socket {@link Transport} for the JSON-RPC client.
 *
 * Intended use: aharness-internal UDS traffic only (e.g. between aharness
 * components such as the gateway and daemon). Each JSON message is a single
 * `\n`-terminated line on the byte stream; framing is handled by
 * {@link LineFramer}.
 *
 * NOT for aharness↔codex traffic. Codex's UDS transport is WebSocket-on-UDS
 * (see codex `app-server-transport/src/transport/unix_socket.rs:78`,
 * `accept_async(stream)`); to speak to codex's app-server over UDS, wrap a
 * UDS connection in WebSocket framing — use {@link connectWs} with a
 * `ws+unix://` style URL or an explicit ws-on-uds adapter, not this module.
 */

import { connect, type Socket } from 'node:net';
import type { Transport } from './client.js';
import { LineFramer } from './framing.js';

export interface UdsTransport extends Transport {
  readonly path: string;
}

export function connectUds(path: string, opts: { timeoutMs?: number } = {}): Promise<UdsTransport> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(path);
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`uds: connect timeout to ${path}`));
    }, timeoutMs);

    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      const framer = new LineFramer();
      sock.on('data', (d) => framer.feed(d));
      const transport: UdsTransport = {
        path,
        send(m) {
          sock.write(JSON.stringify(m) + '\n');
        },
        async close() {
          await new Promise<void>((r) => {
            sock.once('close', () => r());
            sock.end();
          });
        },
      };
      framer.on('message', (m) => transport.onMessage?.(m));
      sock.on('close', () => transport.onClose?.());
      sock.on('error', () => {
        /* surfaced via close */
      });
      resolve(transport);
    });
    sock.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(e);
    });
  });
}
