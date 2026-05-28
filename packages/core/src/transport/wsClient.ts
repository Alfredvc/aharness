/**
 * `connectHeadlessWs` — WS-over-Unix JSON-RPC client used by the harness
 * CLI to dial its `codex app-server` child.
 *
 * Spec §3 boot sequence step 6, §4.1, §5.1. The CLI is the SOLE WS
 * subscriber to its app-server.
 *
 * Three things in one synchronous chain so M18's "handlers MUST be
 * registered before any thread/* call" invariant holds:
 *   1. Open `ws+unix://<sockPath>` via `ws` over a `net.Socket`.
 *   2. Let the caller register every parkable ServerRequest handler
 *      synchronously on the returned client.
 *   3. Send `initialize` with `clientInfo` (CF-19) + capabilities
 *      including `optOutNotificationMethods`.
 *
 * The caller is responsible for the subsequent `thread/start` call.
 */
import WebSocket from 'ws';

import { JsonRpcClient, type Transport } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type { InitializeParams, InitializeResult } from '../protocol/types.js';

export interface ConnectHeadlessWsOptions {
  readonly sockPath: string;
  readonly clientInfo: { name: string; version: string };
  readonly optOutNotificationMethods?: ReadonlyArray<string>;
  /**
   * Callback invoked synchronously between WS open and `initialize`.
   * The caller MUST register every parkable ServerRequest handler here
   * (M18 invariant — spec §3 step 7).
   */
  readonly registerHandlers?: (client: JsonRpcClient) => void;
  readonly connectTimeoutMs?: number;
  /**
   * Optional diagnostic sink for connection setup. Intended for real
   * app-server integration tests and manual debugging; normal runs should
   * stay quiet unless setup fails.
   */
  readonly diagnostics?: (message: string) => void;
}

export interface ConnectHeadlessWsResult {
  readonly client: JsonRpcClient;
  readonly close: () => Promise<void>;
}

export async function connectHeadlessWs(
  opts: ConnectHeadlessWsOptions,
): Promise<ConnectHeadlessWsResult> {
  const timeoutMs = opts.connectTimeoutMs ?? 5_000;
  // ws@8 supports the Unix-domain-socket transport via the
  // `ws+unix:/<absolute-sockPath>:<http-path>` URL form. The path after `:`
  // is the HTTP upgrade request path; `/` is what codex's app-server expects.
  // Reference: ws/lib/websocket.js — `isIpcUrl` branch splits on `:`.
  const wsUrl = `ws+unix:${opts.sockPath}:/`;
  const ws = new WebSocket(wsUrl, {
    // Codex's Unix-socket acceptor uses tungstenite without negotiated
    // extensions; Node `ws` offers permessage-deflate by default, which
    // tungstenite rejects during the upgrade with a socket reset.
    perMessageDeflate: false,
  });
  opts.diagnostics?.(`connect start url=${wsUrl} sockPath=${opts.sockPath}`);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      ws.close();
      reject(new Error(`ws+unix: connect timeout to ${opts.sockPath} url=${wsUrl}`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(t);
      opts.diagnostics?.(`connect open url=${wsUrl}`);
      resolve();
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(t);
      const message = `unexpected response status=${response.statusCode} statusMessage=${
        response.statusMessage ?? ''
      } url=${wsUrl}`;
      opts.diagnostics?.(message);
      reject(new Error(`ws+unix: ${message}`));
    });
    ws.once('close', (code, reason) => {
      opts.diagnostics?.(
        `connect close code=${code} reason=${reason.toString('utf8')} url=${wsUrl}`,
      );
    });
    ws.once('error', (e) => {
      clearTimeout(t);
      const message = `${e.message} url=${wsUrl}`;
      opts.diagnostics?.(`connect error ${message}`);
      reject(new Error(`ws+unix: ${message}`, { cause: e }));
    });
  });

  const transport: Transport = {
    send(m) {
      ws.send(JSON.stringify(m));
    },
    async close() {
      await closeWebSocket(ws);
    },
  };
  ws.on('message', (data) => {
    // `ws` emits Buffer | ArrayBuffer | Buffer[] for binary frames and a
    // string for text frames. Coerce to a single utf-8 string.
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

  const client = new JsonRpcClient(transport);
  // M18: register handlers BEFORE initialize so parkable ServerRequests
  // cannot land before the handler exists.
  opts.registerHandlers?.(client);

  const initParams: InitializeParams = {
    clientInfo: opts.clientInfo,
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      ...(opts.optOutNotificationMethods
        ? { optOutNotificationMethods: opts.optOutNotificationMethods }
        : {}),
    },
  };
  opts.diagnostics?.(`initialize request url=${wsUrl}`);
  await client.request<InitializeResult>(METHOD.initialize, initParams);
  opts.diagnostics?.(`initialize response url=${wsUrl}`);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

function closeWebSocket(ws: WebSocket, timeoutMs = 1_000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.off('close', finish);
      ws.off('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.once('close', finish);
    ws.once('error', finish);
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        finish();
      }
    }
  });
}
