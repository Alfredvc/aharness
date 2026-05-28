/**
 * Transport-agnostic JSON-RPC 2.0 client used by `@aharness/core` to
 * speak to the codex `app-server`.
 *
 * Surface:
 * - `request(method, params)` — client → server call, correlated by numeric id.
 * - `notify(method, params)` — fire-and-forget client → server notification.
 * - `onNotification(method, handler)` — subscribe to server → client notifications.
 * - `onServerRequest(method, handler)` — register a handler for server → client
 *   calls. The handler's resolved value becomes the `result` of the JSON-RPC reply.
 *   If the handler throws, an error envelope is sent. If the handler resolves to
 *   {@link DO_NOT_REPLY}, the call_id is dropped from local bookkeeping and the
 *   transport never sends any response (per design R8 — used by the multicast
 *   race in §5.7 where the loser drops without replying).
 * - `onOutboundRequest(handler)` / `onOutboundResponse(handler)` — register a
 *   synchronous observer for outbound client → server `request(...)` calls and
 *   their eventual resolution / rejection. `notify(...)` does NOT fire either
 *   hook (no call-id correlation). Handlers fire in registration order; a throw
 *   in one handler is swallowed and does not block later handlers or the
 *   request pipeline. The returned closer is idempotent.
 *
 * On `close()`, in-flight client → server requests reject with a
 * "closed before response" error and any in-flight server-request handlers'
 * eventual resolutions are silently discarded — the transport teardown is the
 * cleanup signal for the peer.
 */

export interface Transport {
  send(message: unknown): void;
  onMessage?: (message: unknown) => void;
  onClose?: () => void;
  close?(): Promise<void> | void;
}

/**
 * Sentinel returned by a server-request handler to suppress the reply (R8).
 *
 * The transport will not send any response for that call_id and the client
 * drops the call_id from in-flight bookkeeping. The peer is expected to
 * handle the missing reply (e.g. via its own race / timeout logic).
 */
export const DO_NOT_REPLY: unique symbol = Symbol('jsonrpc:do-not-reply');

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  params: unknown;
};

export type OutboundRequestHandler = (method: string, params: unknown) => void;
export type OutboundResponseOutcome = { ok: true; result: unknown } | { ok: false; error: Error };
export type OutboundResponseHandler = (
  method: string,
  params: unknown,
  outcome: OutboundResponseOutcome,
) => void;

export interface ServerRequestMeta {
  readonly requestId: number | string;
  afterReply(callback: () => void | Promise<void>): void;
}

export type ServerRequestHandler = (params: unknown, meta: ServerRequestMeta) => unknown;

export type NotificationHandler = (params: unknown) => void;

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notifSubs = new Map<string, Set<NotificationHandler>>();
  private serverHandlers = new Map<string, ServerRequestHandler>();
  /** Set of in-flight server-request ids (for drain on close). */
  private inFlightServerRequests = new Set<number | string>();
  private outboundRequestSubs = new Set<OutboundRequestHandler>();
  private outboundResponseSubs = new Set<OutboundResponseHandler>();
  private closed = false;

  constructor(private transport: Transport) {
    transport.onMessage = (m) => this.handleIncoming(m);
    transport.onClose = () => this.handleClose();
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('jsonrpc: client closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        params,
      });
      // Fire outbound-request observers synchronously BEFORE transport.send so
      // tests / telemetry capture the send-time ordering. Per-subscriber throws
      // are swallowed — observers must not break the request pipeline.
      for (const h of this.outboundRequestSubs)
        try {
          h(method, params);
        } catch {
          /* swallow */
        }
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const set = this.notifSubs.get(method) ?? new Set();
    set.add(handler);
    this.notifSubs.set(method, set);
    return () => set.delete(handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    if (this.serverHandlers.has(method))
      throw new Error(`jsonrpc: server-request handler already registered for ${method}`);
    this.serverHandlers.set(method, handler);
  }

  /**
   * Register a synchronous observer for outbound client → server `request(...)`
   * calls. Fires BEFORE `transport.send`. Does NOT fire for `notify(...)` (no
   * call-id correlation) or for requests that reject at the closed-client
   * guard (no send happens). Handlers fire in registration order; a throw in
   * one handler is swallowed and does not block later handlers. Returns an
   * idempotent closer.
   */
  onOutboundRequest(handler: OutboundRequestHandler): () => void {
    this.outboundRequestSubs.add(handler);
    return () => {
      this.outboundRequestSubs.delete(handler);
    };
  }

  /**
   * Register a synchronous observer for the resolution / rejection of an
   * outbound `request(...)` call. Fires AFTER the pending entry is deleted
   * and AFTER the request promise is resolved/rejected. The handler receives
   * the original request's `method` + `params` so tests can correlate without
   * the JSON-RPC `id`. Also fires for in-flight requests that are rejected by
   * `close()` / transport-close (the request flew before the close).
   * Idempotent closer.
   */
  onOutboundResponse(handler: OutboundResponseHandler): () => void {
    this.outboundResponseSubs.add(handler);
    return () => {
      this.outboundResponseSubs.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    // Reject any in-flight client → server requests.
    for (const [id, p] of this.pending) {
      const err = new Error('jsonrpc: closed before response');
      p.reject(err);
      this.pending.delete(id);
      this.fanOutResponse(p.method, p.params, { ok: false, error: err });
    }
    // Drain in-flight server-request ids without sending replies (R8).
    // The transport teardown is the peer's cleanup signal.
    this.inFlightServerRequests.clear();
    await this.transport.close?.();
  }

  private handleIncoming(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const msg = m as {
      id?: number | string;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string };
      params?: unknown;
    };
    if (msg.method && msg.id !== undefined) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) {
      const subs = this.notifSubs.get(msg.method);
      if (subs)
        for (const h of subs)
          try {
            h(msg.params);
          } catch {
            /* swallow */
          }
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      let outcome: OutboundResponseOutcome;
      if (msg.error) {
        const err = new Error(`jsonrpc error ${msg.error.code}: ${msg.error.message}`);
        p.reject(err);
        outcome = { ok: false, error: err };
      } else {
        p.resolve(msg.result);
        outcome = { ok: true, result: msg.result };
      }
      this.fanOutResponse(p.method, p.params, outcome);
    }
  }

  /** Fan out outbound-response observers; swallow per-subscriber throws. */
  private fanOutResponse(method: string, params: unknown, outcome: OutboundResponseOutcome): void {
    for (const h of this.outboundResponseSubs)
      try {
        h(method, params, outcome);
      } catch {
        /* swallow */
      }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const h = this.serverHandlers.get(method);
    if (!h) {
      this.transport.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
      return;
    }
    this.inFlightServerRequests.add(id);
    const afterReplyCallbacks: Array<() => void | Promise<void>> = [];
    const meta: ServerRequestMeta = {
      requestId: id,
      afterReply(callback) {
        afterReplyCallbacks.push(callback);
      },
    };
    try {
      const result = await h(params, meta);
      // R8: handler opted out of replying. Drop the call_id silently.
      if (result === DO_NOT_REPLY) {
        this.inFlightServerRequests.delete(id);
        return;
      }
      // If we were closed while the handler was running, drop without sending.
      if (this.closed || !this.inFlightServerRequests.has(id)) return;
      this.inFlightServerRequests.delete(id);
      this.transport.send({ jsonrpc: '2.0', id, result });
      await runAfterReplyCallbacks(afterReplyCallbacks);
    } catch (e) {
      if (this.closed || !this.inFlightServerRequests.has(id)) {
        this.inFlightServerRequests.delete(id);
        return;
      }
      this.inFlightServerRequests.delete(id);
      this.transport.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: (e as Error).message ?? 'handler error',
        },
      });
      await runAfterReplyCallbacks(afterReplyCallbacks);
    }
  }

  private handleClose(): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      const err = new Error('jsonrpc: transport closed');
      p.reject(err);
      this.pending.delete(id);
      this.fanOutResponse(p.method, p.params, { ok: false, error: err });
    }
    this.inFlightServerRequests.clear();
  }
}

async function runAfterReplyCallbacks(callbacks: ReadonlyArray<() => void | Promise<void>>) {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch {
      /* after-reply callbacks must not produce duplicate JSON-RPC replies. */
    }
  }
}
