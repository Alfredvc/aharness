/**
 * Tests for `daemon/injectNudge.ts`.
 *
 * The factory is a thin wrapper over `JsonRpcClient.request`; the tests
 * pin the wire shape against the codex protocol audit (Task 4 / commit
 * 18cfa697 — camelCase params; snake_case Responses API item tags).
 */
import { describe, expect, it, vi } from 'vitest';

import { createInjectNudge } from '../src/runtime/injectNudge.js';

describe('createInjectNudge', () => {
  it('emits a thread/inject_items request with a developer-role message', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: vi.fn((method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve({});
      }),
    };
    const inject = createInjectNudge({ client: client as never, threadId: 't1' });

    await inject('hello');

    expect(calls).toEqual([
      {
        method: 'thread/inject_items',
        params: {
          threadId: 't1',
          items: [
            {
              type: 'message',
              role: 'developer',
              content: [{ type: 'input_text', text: 'hello' }],
            },
          ],
        },
      },
    ]);
  });

  it('binds threadId at construct time and forwards each call', async () => {
    const client = {
      request: vi.fn(() => Promise.resolve({})),
    };
    const inject = createInjectNudge({ client: client as never, threadId: 'bound-thread' });

    await inject('first');
    await inject('second');

    expect(client.request).toHaveBeenCalledTimes(2);
    const firstParams = client.request.mock.calls[0]?.[1] as { threadId: string; items: unknown[] };
    const secondParams = client.request.mock.calls[1]?.[1] as {
      threadId: string;
      items: unknown[];
    };
    expect(firstParams.threadId).toBe('bound-thread');
    expect(secondParams.threadId).toBe('bound-thread');
    expect(firstParams.items).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'first' }] },
    ]);
    expect(secondParams.items).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'second' }] },
    ]);
  });

  it('propagates errors from the underlying client.request', async () => {
    const client = {
      request: vi.fn(() => Promise.reject(new Error('transport closed'))),
    };
    const inject = createInjectNudge({ client: client as never, threadId: 't1' });

    await expect(inject('hello')).rejects.toThrow('transport closed');
  });
});
