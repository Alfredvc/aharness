#!/usr/bin/env node
/* Minimal Node UDS client for the harness hook UDS.
 *
 * Reads stdin into a buffer, frames it as `<TAG> <byteLen>\n<body>`
 * (per spec docs/specs/2026-05-04-mcp-submit-route-design.md §5.2),
 * sends to the daemon's UDS, reads a framed reply
 * `<OK|ERROR> <byteLen>\n<json>`, and writes only the JSON body to
 * stdout. Exit 0 on OK, 1 on ERROR or transport failure.
 *
 * TAG is taken from argv (see argv-parsing block below). The set of
 * valid tags is pinned by the wire framing in
 * `packages/core/src/protocol/wireFraming.ts`.
 */
'use strict';
const net = require('node:net');

// Argv shape (one frame per invocation):
//   node hookClient.cjs <TAG> <socketPath>
//
// TAG must be one of the v1 framing tags from
// `packages/core/src/protocol/wireFraming.ts`.
const VALID_TAGS = new Set(['PRE_TOOL_USE', 'POST_TOOL_USE', 'USER_PROMPT_SUBMIT']);
let tag, sockPath;
if (process.argv.length === 4) {
  tag = process.argv[2];
  sockPath = process.argv[3];
} else {
  process.stderr.write('hookClient: usage: hookClient.cjs <TAG> <socketPath>\n');
  process.exit(2);
}
if (!VALID_TAGS.has(tag)) {
  process.stderr.write('hookClient: unknown framing tag: ' + tag + '\n');
  process.exit(2);
}
if (!sockPath) {
  process.stderr.write('hookClient: missing socket path argument\n');
  process.exit(2);
}

// Codex's hook timeout is 30 s (configured in runCli.ts). We bound the
// daemon's reply read at 25 s so a hung daemon surfaces with a clearer
// message than codex's generic timeout.
const READ_TIMEOUT_MS = 25_000;

// Stdin-inactivity watchdog. If codex spawns the hook but never closes
// stdin (or stalls mid-payload), the script would hang until codex's own
// 30 s SIGKILL — by which time the daemon never observed the hook fire.
// We bound the wait at 28 s (just inside codex's 30 s budget) so we can
// emit a clear stderr diagnostic and exit 1 ourselves. The timer resets
// on every 'data' chunk so it only fires when stdin is genuinely idle,
// not when a large payload is mid-flight.
//
// Overridable via `HARNESS_HOOK_STDIN_TIMEOUT_MS` so tests can run in
// ~200 ms rather than 28 s.
const STDIN_TIMEOUT_MS = (() => {
  const raw = process.env.HARNESS_HOOK_STDIN_TIMEOUT_MS;
  if (raw == null || raw === '') return 28_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 28_000;
})();

let stdinTimer = setTimeout(onStdinIdle, STDIN_TIMEOUT_MS);
function onStdinIdle() {
  process.stderr.write('harness-hook-client: stdin inactivity timeout\n');
  process.exit(1);
}
function bumpStdinTimer() {
  clearTimeout(stdinTimer);
  stdinTimer = setTimeout(onStdinIdle, STDIN_TIMEOUT_MS);
}

// Ensure stdin is in flowing mode. On macOS/Linux, when this script is
// exec'd from a bash hook (e.g. `cat | hookClient.cjs`), Node's stdin
// starts paused; without `resume()` the 'data'/'end' events never fire.
process.stdin.resume();

let stdinBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  bumpStdinTimer();
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
});
process.stdin.on('error', (err) => {
  clearTimeout(stdinTimer);
  process.stderr.write(
    'hookClient: stdin: ' + (err && err.message ? err.message : String(err)) + '\n',
  );
  process.exit(1);
});
process.stdin.on('end', () => {
  clearTimeout(stdinTimer);
  const body = stdinBuf.toString('utf8');
  const frame = `${tag} ${Buffer.byteLength(body, 'utf8')}\n${body}`;

  const sock = net.connect(sockPath);
  let replyBuf = Buffer.alloc(0);
  const readTimer = setTimeout(() => {
    process.stderr.write('hookClient: daemon did not reply within ' + READ_TIMEOUT_MS + ' ms\n');
    sock.destroy();
    process.exit(1);
  }, READ_TIMEOUT_MS);
  sock.on('error', (err) => {
    clearTimeout(readTimer);
    process.stderr.write('hookClient: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exit(1);
  });
  sock.on('data', (d) => {
    replyBuf = Buffer.concat([replyBuf, d]);
  });
  sock.on('end', () => {
    clearTimeout(readTimer);
    const headerEnd = replyBuf.indexOf(0x0a);
    if (headerEnd < 0) {
      process.stderr.write('hookClient: malformed reply: no header newline\n');
      process.exit(1);
    }
    const header = replyBuf.slice(0, headerEnd).toString('utf8');
    const sp = header.indexOf(' ');
    if (sp < 0) {
      process.stderr.write('hookClient: malformed header: ' + header + '\n');
      process.exit(1);
    }
    const status = header.slice(0, sp);
    const lenStr = header.slice(sp + 1);
    const len = Number(lenStr);
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + len;
    if (replyBuf.byteLength !== bodyEnd) {
      process.stderr.write(
        'hookClient: body length mismatch (declared ' +
          lenStr +
          ', actual ' +
          (replyBuf.byteLength - bodyStart) +
          ')\n',
      );
      process.exit(1);
    }
    const replyBody = replyBuf.slice(bodyStart, bodyEnd).toString('utf8');
    if (status === 'OK') {
      process.stdout.write(replyBody);
      process.exit(0);
    } else if (status === 'ERROR') {
      try {
        const obj = JSON.parse(replyBody);
        process.stderr.write(
          'hookClient: daemon error: ' + (obj && obj.message ? obj.message : replyBody) + '\n',
        );
      } catch {
        process.stderr.write('hookClient: daemon error: ' + replyBody + '\n');
      }
      process.exit(1);
    } else {
      process.stderr.write('hookClient: unknown reply status: ' + status + '\n');
      process.exit(1);
    }
  });
  sock.write(frame);
  sock.end();
});
