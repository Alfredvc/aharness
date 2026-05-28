/**
 * Line-delimited JSON framer (one JSON object per `\n`-terminated line; no
 * Content-Length headers).
 *
 * Framing landscape at the pinned codex commit
 * (`127434cd8b968ca3d830ea78106dcb1506bcd843`):
 * - **stdio transport** uses newline-delimited JSON. See
 *   `app-server-transport/src/transport/stdio.rs:50`
 *   (`reader.lines() ... lines.next_line().await`) and
 *   `app-server-transport/src/transport/stdio.rs:88`
 *   (`json.push('\n')` before `stdout.write_all`).
 * - **UDS and TCP transports** use WebSocket framing on top of the byte
 *   stream (one JSON object per WS Text frame); see
 *   `app-server-transport/src/transport/unix_socket.rs:78`
 *   (`accept_async(stream)`) and
 *   `app-server-transport/src/transport/websocket.rs:319`
 *   (`websocket_writer.send(M::text(json))`). Those transports rely on
 *   `tokio-tungstenite` / `ws` for framing and do not use this `LineFramer`.
 *
 * `LineFramer` therefore applies to the stdio surface only; the WS-backed
 * surfaces consume `ws`'s message events directly.
 */

import { EventEmitter } from 'node:events';

export interface LineFramerEvents {
  message: (m: unknown) => void;
  error: (e: Error) => void;
}

export class LineFramer extends EventEmitter {
  private buf = '';

  feed(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        this.emit(
          'error',
          new Error(`framing: failed to parse JSON line: ${(e as Error).message}`),
        );
        continue;
      }
      this.emit('message', parsed);
    }
  }
}
