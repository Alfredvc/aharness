import { describe, expect, it, vi } from 'vitest';
import { DO_NOT_REPLY, JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';

class MemoryTransport implements Transport {
  send = vi.fn();
  onMessage?: (m: unknown) => void;
  onClose?: () => void;
  emit(m: unknown) {
    this.onMessage?.(m);
  }
}

describe('JsonRpcClient', () => {
  it('correlates request/response by id', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    const p = c.request('foo', { x: 1 });
    expect(t.send).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 1,
      method: 'foo',
      params: { x: 1 },
    });
    t.emit({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects on error response', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    const p = c.request('foo', {});
    t.emit({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'boom' } });
    await expect(p).rejects.toThrow(/boom/);
  });

  it('dispatches notifications to subscribers', () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    const got: unknown[] = [];
    c.onNotification('turn/started', (p) => got.push(p));
    t.emit({ jsonrpc: '2.0', method: 'turn/started', params: { thread_id: 't' } });
    expect(got).toEqual([{ thread_id: 't' }]);
  });

  it('routes server requests to registered handler and replies', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    c.onServerRequest('tool/dynamicCall', async (p) => ({ ok: true, echo: p }));
    t.emit({
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'tool/dynamicCall',
      params: { tool_name: 'submit' },
    });
    await new Promise((r) => setImmediate(r));
    expect(t.send).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 'srv-1',
      result: { ok: true, echo: { tool_name: 'submit' } },
    });
  });

  it('runs afterReply callbacks after sending a normal server-request reply', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    const order: string[] = [];
    c.onServerRequest('tool/dynamicCall', async (_p, meta) => {
      meta.afterReply(() => order.push('after'));
      return { ok: true };
    });
    t.send.mockImplementation(() => order.push('send'));

    t.emit({ jsonrpc: '2.0', id: 'srv-1', method: 'tool/dynamicCall', params: {} });
    await new Promise((r) => setImmediate(r));

    expect(order).toEqual(['send', 'after']);
  });

  it('runs afterReply callbacks after sending an error envelope', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    const order: string[] = [];
    c.onServerRequest('tool/dynamicCall', async (_p, meta) => {
      meta.afterReply(() => order.push('after'));
      throw new Error('nope');
    });
    t.send.mockImplementation(() => order.push('send'));

    t.emit({ jsonrpc: '2.0', id: 'srv-1', method: 'tool/dynamicCall', params: {} });
    await new Promise((r) => setImmediate(r));

    expect(order).toEqual(['send', 'after']);
  });

  it('replies with an error if the server-request handler throws', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    c.onServerRequest('tool/dynamicCall', async () => {
      throw new Error('nope');
    });
    t.emit({ jsonrpc: '2.0', id: 'srv-1', method: 'tool/dynamicCall', params: {} });
    await new Promise((r) => setImmediate(r));
    expect(t.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'srv-1',
        error: expect.objectContaining({ message: expect.stringContaining('nope') }),
      }),
    );
  });

  it('does not write any reply when handler resolves to DO_NOT_REPLY (R8)', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    c.onServerRequest('tool/requestUserInput', async () => DO_NOT_REPLY);
    t.emit({
      jsonrpc: '2.0',
      id: 'srv-42',
      method: 'tool/requestUserInput',
      params: {},
    });
    await new Promise((r) => setImmediate(r));
    // No call to send for the server-request id.
    expect(t.send).not.toHaveBeenCalled();
    // close() must drain without sending responses for in-flight server-requests.
    await c.close();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('does not run afterReply callbacks when handler resolves to DO_NOT_REPLY', async () => {
    const t = new MemoryTransport();
    const c = new JsonRpcClient(t);
    const after = vi.fn();
    c.onServerRequest('tool/requestUserInput', async (_p, meta) => {
      meta.afterReply(after);
      return DO_NOT_REPLY;
    });

    t.emit({
      jsonrpc: '2.0',
      id: 'srv-42',
      method: 'tool/requestUserInput',
      params: {},
    });
    await new Promise((r) => setImmediate(r));

    expect(after).not.toHaveBeenCalled();
  });
});
