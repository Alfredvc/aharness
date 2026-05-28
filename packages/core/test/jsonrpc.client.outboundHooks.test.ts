import { describe, expect, it, vi } from 'vitest';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';

/**
 * Coverage for the `onOutboundRequest` / `onOutboundResponse` hooks added on
 * `JsonRpcClient`. The hooks replace the previous `handle.client.request = …`
 * monkey-patching pattern used by Phase 2a integration tests; this file pins
 * down their contract.
 */

class MemoryTransport implements Transport {
  send = vi.fn();
  onMessage?: (m: unknown) => void;
  onClose?: () => void;
  emit(m: unknown) {
    this.onMessage?.(m);
  }
  emitClose() {
    this.onClose?.();
  }
}

describe('JsonRpcClient outbound hooks', () => {
  describe('onOutboundRequest', () => {
    it('fires synchronously BEFORE transport.send', () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const events: Array<['hook' | 'send', { method: string; params: unknown }]> = [];
      t.send.mockImplementation((m: unknown) => {
        const msg = m as { method: string; params: unknown };
        events.push(['send', { method: msg.method, params: msg.params }]);
      });
      c.onOutboundRequest((method, params) => {
        events.push(['hook', { method, params }]);
      });
      void c.request('foo', { x: 1 });
      expect(events).toEqual([
        ['hook', { method: 'foo', params: { x: 1 } }],
        ['send', { method: 'foo', params: { x: 1 } }],
      ]);
    });

    it('stacks multiple subscribers in registration order', () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const order: number[] = [];
      c.onOutboundRequest(() => order.push(1));
      c.onOutboundRequest(() => order.push(2));
      c.onOutboundRequest(() => order.push(3));
      void c.request('foo', null);
      expect(order).toEqual([1, 2, 3]);
    });

    it('a throw in one subscriber does not block later subscribers or the request', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const order: number[] = [];
      c.onOutboundRequest(() => {
        order.push(1);
        throw new Error('boom');
      });
      c.onOutboundRequest(() => order.push(2));
      const p = c.request('foo', null);
      expect(order).toEqual([1, 2]);
      expect(t.send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        id: 1,
        method: 'foo',
        params: null,
      });
      t.emit({ jsonrpc: '2.0', id: 1, result: 'ok' });
      await expect(p).resolves.toBe('ok');
    });

    it('returned closer removes the subscriber idempotently', () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const fired: string[] = [];
      const close = c.onOutboundRequest((m) => fired.push(m));
      void c.request('a', null);
      close();
      close(); // second call must be a no-op
      void c.request('b', null);
      expect(fired).toEqual(['a']);
    });

    it('does NOT fire for notify(...)', () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const fired: string[] = [];
      c.onOutboundRequest((m) => fired.push(m));
      c.notify('some/notification', { x: 1 });
      expect(fired).toEqual([]);
      // notify did go out on the wire — only the hook is silent.
      expect(t.send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'some/notification',
        params: { x: 1 },
      });
    });

    it('does NOT fire when request rejects at the closed-client guard', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      await c.close();
      const fired: string[] = [];
      c.onOutboundRequest((m) => fired.push(m));
      await expect(c.request('foo', null)).rejects.toThrow(/client closed/);
      expect(fired).toEqual([]);
      // The closed-client guard returns before transport.send too.
      expect(t.send).not.toHaveBeenCalled();
    });
  });

  describe('onOutboundResponse', () => {
    it('fires with the original method/params and the success outcome', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const events: Array<{ method: string; params: unknown; outcome: unknown }> = [];
      c.onOutboundResponse((method, params, outcome) => {
        events.push({ method, params, outcome });
      });
      const p = c.request('foo', { x: 1 });
      t.emit({ jsonrpc: '2.0', id: 1, result: { ok: true } });
      await expect(p).resolves.toEqual({ ok: true });
      expect(events).toEqual([
        {
          method: 'foo',
          params: { x: 1 },
          outcome: { ok: true, result: { ok: true } },
        },
      ]);
    });

    it('fires with the error outcome on JSON-RPC error response', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const events: Array<{ method: string; outcome: unknown }> = [];
      c.onOutboundResponse((method, _params, outcome) => {
        events.push({ method, outcome });
      });
      const p = c.request('foo', null);
      t.emit({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'boom' } });
      await expect(p).rejects.toThrow(/boom/);
      expect(events).toHaveLength(1);
      expect(events[0]!.method).toBe('foo');
      const outcome = events[0]!.outcome as { ok: false; error: Error };
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.error.message).toMatch(/boom/);
    });

    it('fires AFTER pending.delete and the request promise has been resolved', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const order: string[] = [];
      const p = c.request('foo', null).then(() => {
        order.push('promise-then');
      });
      c.onOutboundResponse(() => {
        order.push('hook');
      });
      t.emit({ jsonrpc: '2.0', id: 1, result: 'ok' });
      // The hook fires synchronously inside handleIncoming (after p.resolve),
      // whereas the `.then` callback queues a microtask. So hook lands first
      // in synchronous order; awaiting the promise drains the microtask.
      await p;
      expect(order).toEqual(['hook', 'promise-then']);
    });

    it('stacks multiple subscribers in registration order', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const order: number[] = [];
      c.onOutboundResponse(() => order.push(1));
      c.onOutboundResponse(() => order.push(2));
      c.onOutboundResponse(() => order.push(3));
      const p = c.request('foo', null);
      t.emit({ jsonrpc: '2.0', id: 1, result: 'ok' });
      await p;
      expect(order).toEqual([1, 2, 3]);
    });

    it('a throw in one subscriber does not block later subscribers', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const order: number[] = [];
      c.onOutboundResponse(() => {
        order.push(1);
        throw new Error('boom');
      });
      c.onOutboundResponse(() => order.push(2));
      const p = c.request('foo', null);
      t.emit({ jsonrpc: '2.0', id: 1, result: 'ok' });
      await expect(p).resolves.toBe('ok');
      expect(order).toEqual([1, 2]);
    });

    it('returned closer removes the subscriber idempotently', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const fired: string[] = [];
      const close = c.onOutboundResponse((method) => fired.push(method));
      const p1 = c.request('a', null);
      t.emit({ jsonrpc: '2.0', id: 1, result: 'ok' });
      await p1;
      close();
      close(); // second call must be a no-op
      const p2 = c.request('b', null);
      t.emit({ jsonrpc: '2.0', id: 2, result: 'ok' });
      await p2;
      expect(fired).toEqual(['a']);
    });

    it('does NOT fire for notify(...) (no call-id correlation)', () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const fired: string[] = [];
      c.onOutboundResponse((m) => fired.push(m));
      c.notify('some/notification', { x: 1 });
      expect(fired).toEqual([]);
    });

    it('does NOT fire when request rejects at the closed-client guard', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      await c.close();
      const fired: string[] = [];
      c.onOutboundResponse((m) => fired.push(m));
      await expect(c.request('foo', null)).rejects.toThrow(/client closed/);
      expect(fired).toEqual([]);
    });

    it('fires for in-flight requests when close() is called', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const events: Array<{ method: string; outcome: unknown }> = [];
      c.onOutboundResponse((method, _params, outcome) => {
        events.push({ method, outcome });
      });
      const p = c.request('foo', { x: 1 });
      // Don't emit a response — close instead.
      await c.close();
      await expect(p).rejects.toThrow(/closed before response/);
      expect(events).toHaveLength(1);
      expect(events[0]!.method).toBe('foo');
      const outcome = events[0]!.outcome as { ok: false; error: Error };
      expect(outcome.ok).toBe(false);
      expect(outcome.error.message).toMatch(/closed before response/);
    });

    it('fires for in-flight requests when the transport closes', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const events: Array<{ method: string; outcome: unknown }> = [];
      c.onOutboundResponse((method, _params, outcome) => {
        events.push({ method, outcome });
      });
      const p = c.request('foo', null);
      t.emitClose();
      await expect(p).rejects.toThrow(/transport closed/);
      expect(events).toHaveLength(1);
      expect(events[0]!.method).toBe('foo');
      const outcome = events[0]!.outcome as { ok: false; error: Error };
      expect(outcome.ok).toBe(false);
      expect(outcome.error.message).toMatch(/transport closed/);
    });

    it('the request promise rejection and response hook see the same Error instance', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      let hookErr: Error | undefined;
      c.onOutboundResponse((_m, _p, outcome) => {
        if (!outcome.ok) hookErr = outcome.error;
      });
      const p = c.request('foo', null);
      t.emit({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'boom' } });
      let rejErr: Error | undefined;
      await p.catch((e: Error) => {
        rejErr = e;
      });
      expect(hookErr).toBeDefined();
      expect(rejErr).toBeDefined();
      expect(hookErr).toBe(rejErr);
    });
  });

  describe('cross-hook interaction', () => {
    it('request hook -> send -> response hook order is stable across many requests', async () => {
      const t = new MemoryTransport();
      const c = new JsonRpcClient(t);
      const events: string[] = [];
      t.send.mockImplementation((m: unknown) => {
        const msg = m as { method?: string };
        if (msg.method) events.push(`send:${msg.method}`);
      });
      c.onOutboundRequest((m) => events.push(`req:${m}`));
      c.onOutboundResponse((m) => events.push(`res:${m}`));
      const p1 = c.request('a', null);
      const p2 = c.request('b', null);
      t.emit({ jsonrpc: '2.0', id: 1, result: 'ok-a' });
      t.emit({ jsonrpc: '2.0', id: 2, result: 'ok-b' });
      await Promise.all([p1, p2]);
      expect(events).toEqual(['req:a', 'send:a', 'req:b', 'send:b', 'res:a', 'res:b']);
    });
  });
});
