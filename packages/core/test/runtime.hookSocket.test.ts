import { describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHookSocket, type HookDispatchByType } from '../src/runtime/hookSocket.js';
import { encodeFramed, parseFramedReply } from '../src/protocol/wireFraming.js';

function tempSock(): string {
  return join(mkdtempSync(join(tmpdir(), 'hooksock-')), 's');
}

async function send(
  path: string,
  frame: string,
): Promise<{ status: 'OK' | 'ERROR'; body: string }> {
  return new Promise((resolveP, rejectP) => {
    const s = connect(path);
    const chunks: Buffer[] = [];
    s.on('error', rejectP);
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => {
      const buf = Buffer.concat(chunks);
      const r = parseFramedReply(buf);
      if (!r.ok) rejectP(new Error(r.error));
      else resolveP(r.value);
    });
    s.on('connect', () => {
      s.write(frame);
      s.end();
    });
  });
}

describe('framed hookSocket', () => {
  it('routes PRE_TOOL_USE to its handler and replies with OK', async () => {
    const path = tempSock();
    const dispatch: HookDispatchByType = {
      PRE_TOOL_USE: async (body) => ({
        status: 'OK',
        body: JSON.stringify({ ack: 'pre', got: JSON.parse(body) }),
      }),
      POST_TOOL_USE: async () => ({
        status: 'ERROR',
        body: JSON.stringify({ message: 'unreachable' }),
      }),
      USER_PROMPT_SUBMIT: async () => ({
        status: 'ERROR',
        body: JSON.stringify({ message: 'unreachable' }),
      }),
    };
    const handle = await startHookSocket({ path, dispatch });
    try {
      const r = await send(
        path,
        encodeFramed('PRE_TOOL_USE', JSON.stringify({ hook_event_name: 'PreToolUse' })),
      );
      expect(r.status).toBe('OK');
      expect(JSON.parse(r.body)).toEqual({
        ack: 'pre',
        got: { hook_event_name: 'PreToolUse' },
      });
    } finally {
      await handle.close();
    }
  });

  it.each([
    ['POST_TOOL_USE', { hook_event_name: 'PostToolUse', tool_name: 'Bash' }],
    ['USER_PROMPT_SUBMIT', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }],
  ] as const)('routes %s to its handler', async (tag, payload) => {
    const path = tempSock();
    const dispatch: HookDispatchByType = {
      PRE_TOOL_USE: async () => ({
        status: 'ERROR',
        body: JSON.stringify({ message: 'unreachable' }),
      }),
      POST_TOOL_USE: async (body) => ({
        status: 'OK',
        body: JSON.stringify({ tag: 'post', echoed: JSON.parse(body) }),
      }),
      USER_PROMPT_SUBMIT: async (body) => ({
        status: 'OK',
        body: JSON.stringify({ tag: 'ups', echoed: JSON.parse(body) }),
      }),
    };
    const handle = await startHookSocket({ path, dispatch });
    try {
      const r = await send(path, encodeFramed(tag, JSON.stringify(payload)));
      expect(r.status).toBe('OK');
      const parsed = JSON.parse(r.body) as { tag: string; echoed: unknown };
      expect(parsed.tag).toBe(tag === 'POST_TOOL_USE' ? 'post' : 'ups');
      expect(parsed.echoed).toEqual(payload);
    } finally {
      await handle.close();
    }
  });

  it('replies ERROR on a malformed frame', async () => {
    const path = tempSock();
    const dispatch: HookDispatchByType = {
      PRE_TOOL_USE: async () => ({ status: 'OK', body: '{}' }),
      POST_TOOL_USE: async () => ({ status: 'OK', body: '{}' }),
      USER_PROMPT_SUBMIT: async () => ({ status: 'OK', body: '{}' }),
    };
    const handle = await startHookSocket({ path, dispatch });
    try {
      const r = await send(path, 'NO_NEWLINE_HERE');
      expect(r.status).toBe('ERROR');
      expect(JSON.parse(r.body).message).toMatch(/header/);
    } finally {
      await handle.close();
    }
  });

  it('replies ERROR on an unknown type tag', async () => {
    const path = tempSock();
    const dispatch: HookDispatchByType = {
      PRE_TOOL_USE: async () => ({ status: 'OK', body: '{}' }),
      POST_TOOL_USE: async () => ({ status: 'OK', body: '{}' }),
      USER_PROMPT_SUBMIT: async () => ({ status: 'OK', body: '{}' }),
    };
    const handle = await startHookSocket({ path, dispatch });
    try {
      const r = await send(path, 'BOGUS 2\n{}');
      expect(r.status).toBe('ERROR');
      expect(JSON.parse(r.body).message).toMatch(/unknown/);
    } finally {
      await handle.close();
    }
  });

  it('serialises concurrent connections — each gets its own reply', async () => {
    const path = tempSock();
    const dispatch: HookDispatchByType = {
      PRE_TOOL_USE: async (body) => ({ status: 'OK', body }),
      POST_TOOL_USE: async () => ({ status: 'OK', body: '{}' }),
      USER_PROMPT_SUBMIT: async () => ({ status: 'OK', body: '{}' }),
    };
    const handle = await startHookSocket({ path, dispatch });
    try {
      const replies = await Promise.all([
        send(path, encodeFramed('PRE_TOOL_USE', JSON.stringify({ id: 1 }))),
        send(path, encodeFramed('PRE_TOOL_USE', JSON.stringify({ id: 2 }))),
        send(path, encodeFramed('PRE_TOOL_USE', JSON.stringify({ id: 3 }))),
      ]);
      const ids = replies.map((r) => JSON.parse(r.body).id).sort();
      expect(ids).toEqual([1, 2, 3]);
    } finally {
      await handle.close();
    }
  });
});
