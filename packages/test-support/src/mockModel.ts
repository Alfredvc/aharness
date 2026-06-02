/**
 * Mock OpenAI Responses API for codex tests.
 *
 * Starts a local HTTP server bound to `127.0.0.1:0` that accepts
 * `POST /v1/responses` and replies with a queued SSE turn. Tests override
 * codex's model base URL via config (see codex's per-provider `base_url`
 * setting) so codex's HTTP client posts here instead of OpenAI.
 *
 * The queue is FIFO: each `queueTurn(events)` enqueues one turn of SSE
 * events; each incoming POST consumes the head. When the queue is empty,
 * the POST handler parks the request on a per-server condition variable
 * and resolves it as soon as a turn arrives — this is what `phase9`
 * needs, where codex polls before the test queues the next turn.
 *
 * `awaitNextRequest()` lets a test rendezvous with codex's next POST
 * (e.g. to inspect the request body before deciding what to queue).
 * `hasPending()` and `requestCount` expose enough state for tests to
 * assert ordering without sleeping.
 */

import { createServer, type Server } from 'node:http';
import { encodeTurn, type SseEvent } from './sse.js';

export interface MockModelHandle {
  readonly baseUrl: string;
  queueTurn(events: ReadonlyArray<SseEvent>): void;
  awaitNextRequest(): Promise<{ body: unknown }>;
  hasPending(): boolean;
  readonly requestCount: number;
  /**
   * Full history of every `POST /v1/responses` body the mock has
   * received, in arrival order. Each entry's `body` is the JSON-parsed
   * request body (or the raw string if parsing failed). Read-back-only
   * surface for tests that need to inspect the FULL POST history after
   * the run terminates (rather than gating mid-run on a specific POST
   * via `awaitNextRequest()`).
   *
   * Used by request-user-input and multi-turn CLI tests that inspect the
   * full model request history.
   */
  readonly recordedRequests: ReadonlyArray<{ body: unknown }>;
  close(): Promise<void>;
}

interface ParkedRequest {
  resolve: (events: ReadonlyArray<SseEvent>) => void;
  body: unknown;
}

interface NextRequestWaiter {
  resolve: (value: { body: unknown }) => void;
}

export async function startMockModel(): Promise<MockModelHandle> {
  const queue: Array<ReadonlyArray<SseEvent>> = [];
  const parked: Array<ParkedRequest> = [];
  const nextRequestWaiters: Array<NextRequestWaiter> = [];
  let requestCount = 0;
  const recorded: Array<{ body: unknown }> = [];

  const handle = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> => {
    // codex's `wire_api: responses` POSTs to `${base_url}/responses`
    // (no `/v1/` prefix — the prefix is OpenAI's chat-completions
    // convention, see codex `core/src/client.rs::RESPONSES_ENDPOINT`).
    // Accept both paths so tests that previously hard-coded `/v1/`
    // continue to work.
    const path = req.url ?? '';
    if (
      req.method !== 'POST' ||
      !(path.startsWith('/v1/responses') || path.startsWith('/responses'))
    ) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('mockModel: not found');
      return;
    }

    // Drain body and JSON-parse (best effort — fall back to raw string).
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown = raw;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // leave as raw string
      }
    }

    requestCount += 1;
    // Record the full POST history BEFORE the rendezvous resolve so a
    // test that reads `recordedRequests[N-1]` immediately after its
    // `awaitNextRequest()` promise resolves sees the same body.
    recorded.push({ body: parsed });

    // Notify any awaitNextRequest() observers in arrival order.
    const waiter = nextRequestWaiters.shift();
    if (waiter) waiter.resolve({ body: parsed });

    // Resolve from the queue if we have a turn ready; otherwise park.
    let events: ReadonlyArray<SseEvent>;
    const head = queue.shift();
    if (head) {
      events = head;
    } else {
      events = await new Promise<ReadonlyArray<SseEvent>>((resolve) => {
        parked.push({ resolve, body: parsed });
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.end(encodeTurn(events));
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  // Don't keep the event loop alive on this socket — tests are responsible
  // for calling close(), but `unref` prevents a forgotten handle from
  // pinning vitest if a test throws before reaching its `finally`.
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('mockModel: failed to bind 127.0.0.1');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    queueTurn: (events) => {
      const waiting = parked.shift();
      if (waiting) {
        waiting.resolve(events);
        return;
      }
      queue.push(events);
    },
    awaitNextRequest: () =>
      new Promise<{ body: unknown }>((resolve) => {
        nextRequestWaiters.push({ resolve });
      }),
    hasPending: () => parked.length > 0,
    get requestCount() {
      return requestCount;
    },
    get recordedRequests() {
      return recorded;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Release any parked POSTs with an empty turn so they can finalize
        // and the server can close cleanly.
        while (parked.length > 0) {
          const w = parked.shift();
          w?.resolve([]);
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
