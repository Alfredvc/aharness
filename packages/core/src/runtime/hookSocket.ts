/**
 * UDS server for the Codex hook IPC channel.
 *
 * Wire protocol: framed request/reply per `docs/specs/2026-05-04-mcp-submit-route-design.md` §5.2.
 * One frame per connection: open, send `<TAG> <len>\n<body>`, read `<OK|ERROR> <len>\n<body>`,
 * close. Multiplexing multiple frames over one connection is forbidden — see
 * `wireFraming.ts` for the parser invariant.
 *
 * Dispatch is keyed by request type (`PRE_TOOL_USE` | `POST_TOOL_USE` |
 * `USER_PROMPT_SUBMIT`); the runtime supplies a handler per type. Handlers
 * return `{status, body}` directly — no implicit defaulting; framing-level
 * errors short-circuit to `ERROR` before dispatch is invoked.
 */
import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';

import { encodeFramed, parseFramedRequest, type RequestType } from '../protocol/wireFraming.js';

export interface DispatchResult {
  readonly status: 'OK' | 'ERROR';
  /** UTF-8 body, expected to be JSON. */
  readonly body: string;
}

export type HookHandler = (body: string) => Promise<DispatchResult>;

export type HookDispatchByType = Readonly<Record<RequestType, HookHandler>>;

export interface StartHookSocketOpts {
  readonly path: string;
  readonly dispatch: HookDispatchByType;
}

export interface HookSocketHandle {
  close(): Promise<void>;
}

// `sockaddr_un.sun_path` byte caps (incl. NUL): 104 on macOS/BSD, 108 on Linux.
// Going over yields `EINVAL` from `bind(2)` with no Node-side hint about why.
const SUN_PATH_MAX = process.platform === 'linux' ? 107 : 103;

export async function startHookSocket(o: StartHookSocketOpts): Promise<HookSocketHandle> {
  const len = Buffer.byteLength(o.path, 'utf8');
  if (len > SUN_PATH_MAX) {
    throw new Error(
      `hook UDS path exceeds ${String(SUN_PATH_MAX)}-byte sun_path limit ` +
        `(${String(len)} bytes): ${o.path}`,
    );
  }

  // Defensive cleanup of a stale socket file from a previous run that crashed
  // before its own close handler ran.
  try {
    unlinkSync(o.path);
  } catch {
    /* not present — fine */
  }

  // allowHalfOpen: true keeps the server's *writable* half open after the
  // client half-closes its writable (i.e. the script's stdin EOF that fires
  // 'end' here). Without this, Node closes both halves when the client FINs,
  // and the dispatcher's reply lands on a non-writable socket.
  const server: Server = createServer({ allowHalfOpen: true }, (c) => {
    const chunks: Buffer[] = [];
    c.on('data', (d: Buffer) => {
      chunks.push(d);
    });
    c.on('error', () => {
      /* swallow per-connection socket errors (broken pipe etc.) */
    });
    c.on('end', () => {
      const buf = Buffer.concat(chunks);
      void handleRequest(buf, o.dispatch).then((reply) => {
        c.write(encodeFramed(reply.status, reply.body));
        c.end();
      });
    });
  });

  await new Promise<void>((res, rej) => {
    server.once('listening', res);
    server.once('error', rej);
    server.listen(o.path);
  });

  return {
    async close() {
      // `server.close(cb)` waits for all in-flight connections to
      // drain before firing `cb`. Callers wrap this in a timeout
      // (`runRestartShutdown` / `runShutdown`) so a peer that never
      // FINs cannot stall daemon teardown.
      await new Promise<void>((r) => {
        server.close(() => r());
      });
      try {
        unlinkSync(o.path);
      } catch {
        /* already gone — fine */
      }
    },
  };
}

async function handleRequest(buf: Buffer, dispatch: HookDispatchByType): Promise<DispatchResult> {
  const parsed = parseFramedRequest(buf);
  if (!parsed.ok) {
    return { status: 'ERROR', body: JSON.stringify({ message: `bad frame: ${parsed.error}` }) };
  }
  const handler = dispatch[parsed.value.type];
  try {
    return await handler(parsed.value.body);
  } catch (e) {
    return { status: 'ERROR', body: JSON.stringify({ message: (e as Error).message }) };
  }
}
