/**
 * Wire framing for the aharness hook UDS — pinned by spec §5.2 of
 * `docs/specs/2026-05-04-mcp-submit-route-design.md`.
 *
 * Format: `<TAG> <len>\n<body>` where:
 *   - <TAG>  is `PRE_TOOL_USE` | `POST_TOOL_USE` |
 *            `USER_PROMPT_SUBMIT` (request side) or `OK` | `ERROR`
 *            (reply side).
 *   - <len>  is the byte length of the UTF-8 body that follows.
 *   - <body> is exactly <len> bytes of UTF-8 JSON.
 *
 * The framing is text-only (no binary), one round trip per
 * connection (open, send, read, close).
 *
 * **Load-bearing invariant: one-frame-per-connection.** The parser is
 * intentionally strict — extra bytes after the declared body length
 * trigger a "body length mismatch" rejection. This is by design.
 * Multiplexing multiple frames over one connection is forbidden.
 * Future protocol evolution (batch submits, pipelined hooks) must
 * either open additional connections or introduce a new wire layer
 * with its own framing helpers; do not relax the parser here.
 */
export type RequestType = 'PRE_TOOL_USE' | 'POST_TOOL_USE' | 'USER_PROMPT_SUBMIT';
export type ReplyStatus = 'OK' | 'ERROR';

export interface FramedRequest {
  readonly type: RequestType;
  readonly body: string;
}
export interface FramedReply {
  readonly status: ReplyStatus;
  readonly body: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const REQUEST_TYPES = new Set<RequestType>(['PRE_TOOL_USE', 'POST_TOOL_USE', 'USER_PROMPT_SUBMIT']);
const REPLY_STATUSES = new Set<ReplyStatus>(['OK', 'ERROR']);

export function encodeFramed(tag: RequestType | ReplyStatus, body: string): string {
  return `${tag} ${String(Buffer.byteLength(body, 'utf8'))}\n${body}`;
}

export function parseFramedRequest(buf: Buffer): ParseResult<FramedRequest> {
  const parsed = parseHeader(buf);
  if (!parsed.ok) return parsed;
  const { tag, body } = parsed.value;
  if (!REQUEST_TYPES.has(tag as RequestType)) {
    return { ok: false, error: `unknown request type: ${tag}` };
  }
  return { ok: true, value: { type: tag as RequestType, body } };
}

export function parseFramedReply(buf: Buffer): ParseResult<FramedReply> {
  const parsed = parseHeader(buf);
  if (!parsed.ok) return parsed;
  const { tag, body } = parsed.value;
  if (!REPLY_STATUSES.has(tag as ReplyStatus)) {
    return { ok: false, error: `unknown reply status: ${tag}` };
  }
  return { ok: true, value: { status: tag as ReplyStatus, body } };
}

function parseHeader(buf: Buffer): ParseResult<{ tag: string; body: string }> {
  const nl = buf.indexOf(0x0a /* '\n' */);
  if (nl < 0) return { ok: false, error: 'no header newline found' };
  const header = buf.slice(0, nl).toString('utf8');
  const sp = header.indexOf(' ');
  if (sp < 0) return { ok: false, error: `malformed header: ${header}` };
  const tag = header.slice(0, sp);
  const lenStr = header.slice(sp + 1);
  const len = Number(lenStr);
  if (!Number.isFinite(len) || len < 0 || !Number.isInteger(len)) {
    return { ok: false, error: `invalid length: ${lenStr}` };
  }
  const bodyStart = nl + 1;
  const bodyEnd = bodyStart + len;
  if (buf.byteLength < bodyEnd) {
    return {
      ok: false,
      error: `body truncated: declared ${String(len)} bytes, got ${String(buf.byteLength - bodyStart)}`,
    };
  }
  if (buf.byteLength > bodyEnd) {
    return {
      ok: false,
      error: `body length mismatch: declared ${String(len)} bytes, got ${String(buf.byteLength - bodyStart)}`,
    };
  }
  const body = buf.slice(bodyStart, bodyEnd).toString('utf8');
  return { ok: true, value: { tag, body } };
}
