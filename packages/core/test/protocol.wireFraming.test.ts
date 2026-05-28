import { describe, expect, it } from 'vitest';
import {
  encodeFramed,
  parseFramedRequest,
  parseFramedReply,
  type FramedRequest,
  type FramedReply,
} from '../src/protocol/wireFraming.js';

describe('wireFraming', () => {
  it('round-trips a PRE_TOOL_USE request', () => {
    const body = JSON.stringify({ hook_event_name: 'PreToolUse', x: 1 });
    const wire = encodeFramed('PRE_TOOL_USE', body);
    expect(wire).toBe(`PRE_TOOL_USE ${String(Buffer.byteLength(body, 'utf8'))}\n${body}`);
    const parsed = parseFramedRequest(Buffer.from(wire, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual<FramedRequest>({ type: 'PRE_TOOL_USE', body });
    }
  });

  it('round-trips an OK reply', () => {
    const body = JSON.stringify({ text: 'Transitioned to b.' });
    const wire = encodeFramed('OK', body);
    const parsed = parseFramedReply(Buffer.from(wire, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual<FramedReply>({ status: 'OK', body });
  });

  it('rejects an unknown type tag', () => {
    const wire = `BOGUS 2\n{}`;
    const parsed = parseFramedRequest(Buffer.from(wire, 'utf8'));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a length mismatch', () => {
    const wire = `PRE_TOOL_USE 5\n{}`; // declared 5, body length 2
    const parsed = parseFramedRequest(Buffer.from(wire, 'utf8'));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a missing newline after header', () => {
    const wire = `PRE_TOOL_USE 2{}`;
    const parsed = parseFramedRequest(Buffer.from(wire, 'utf8'));
    expect(parsed.ok).toBe(false);
  });

  it('handles UTF-8 multi-byte body length correctly', () => {
    const body = JSON.stringify({ s: '日本語' });
    const len = Buffer.byteLength(body, 'utf8');
    const wire = encodeFramed('USER_PROMPT_SUBMIT', body);
    expect(wire.startsWith(`USER_PROMPT_SUBMIT ${String(len)}\n`)).toBe(true);
    const parsed = parseFramedRequest(Buffer.from(wire, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.body).toBe(body);
  });

  it.each([['PRE_TOOL_USE'], ['POST_TOOL_USE'], ['USER_PROMPT_SUBMIT']] as const)(
    'round-trips a %s request',
    (tag) => {
      const body = JSON.stringify({ session_id: 'abc', tool_name: 'Bash' });
      const wire = encodeFramed(tag, body);
      const parsed = parseFramedRequest(Buffer.from(wire, 'utf8'));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.type).toBe(tag);
    },
  );

  it.each([['STOP_HOOK'], ['MCP_SUBMIT']] as const)('rejects retired %s request tags', (tag) => {
    const parsed = parseFramedRequest(Buffer.from(`${tag} 2\n{}`, 'utf8'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/unknown request type/);
  });
});
