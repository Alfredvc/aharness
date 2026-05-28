import { describe, expect, it } from 'vitest';
import {
  encodeTurn,
  sseAssistantText,
  sseFunctionCall,
  sseTurnComplete,
  startMockModel,
} from '../src/index.js';

// Event-name expectations are pinned to codex commit
// 127434cd8b968ca3d830ea78106dcb1506bcd843 — see `src/sse.ts` for the full
// citation chain (`codex-rs/codex-api/src/sse/responses.rs`,
// `codex-rs/core/src/session/turn.rs`,
// `codex-rs/core/tests/cli_responses_fixture.sse`).

describe('SSE helpers', () => {
  it('encodes a function-call event as response.output_item.done', () => {
    const e = sseFunctionCall('submit', { state: 's', exit: 'e', data: { x: 1 } });
    expect(e.event).toBe('response.output_item.done');
    expect(e.data).toMatchObject({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'submit' },
    });
    const dataItem = (e.data as { item: { arguments: string } }).item;
    expect(JSON.parse(dataItem.arguments)).toEqual({
      state: 's',
      exit: 'e',
      data: { x: 1 },
    });
  });

  it('uses a caller-supplied call_id when provided', () => {
    const e = sseFunctionCall('submit', { ok: true }, 'call_fixed');
    const dataItem = (e.data as { item: { call_id: string } }).item;
    expect(dataItem.call_id).toBe('call_fixed');
  });

  it('encodes an assistant text and a turn-complete with required response.id', () => {
    const t = sseAssistantText('hi');
    expect(t.event).toBe('response.output_item.done');
    expect(t.data).toMatchObject({
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
      },
    });

    const c = sseTurnComplete();
    expect(c.event).toBe('response.completed');
    const completed = c.data as { type: string; response: { id: string } };
    expect(completed.type).toBe('response.completed');
    // `response.completed` requires `response.id` per codex's
    // `ResponseCompleted` deserializer (id is non-optional).
    expect(typeof completed.response.id).toBe('string');
    expect(completed.response.id.length).toBeGreaterThan(0);
  });

  it('encodeTurn flattens to wire SSE bytes', () => {
    const buf = encodeTurn([sseAssistantText('hi'), sseTurnComplete('resp1')]);
    const wire = buf.toString('utf8');
    expect(wire).toMatch(/event: response\.output_item\.done\ndata: .+\n\n/);
    expect(wire).toMatch(/event: response\.completed\ndata: .+\n\n/);
    // `data:` JSON's `type` must match the event header — codex dispatches
    // on the JSON `type` field, not the SSE event name.
    expect(wire).toContain('"type":"response.output_item.done"');
    expect(wire).toContain('"type":"response.completed"');
  });
});

describe('mockModel', () => {
  it('serves the next queued SSE turn on POST /v1/responses', async () => {
    const m = await startMockModel();
    try {
      m.queueTurn([sseAssistantText('hi'), sseTurnComplete('resp1')]);
      const res = await fetch(m.baseUrl + '/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: '{"model":"any"}',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const text = await res.text();
      expect(text).toMatch(/event: response\.output_item\.done/);
      expect(text).toMatch(/event: response\.completed/);
    } finally {
      await m.close();
    }
  });

  it('serves queued turns in FIFO order', async () => {
    const m = await startMockModel();
    try {
      m.queueTurn([sseFunctionCall('first', {}, 'call_1'), sseTurnComplete('resp_1')]);
      m.queueTurn([sseFunctionCall('second', {}, 'call_2'), sseTurnComplete('resp_2')]);

      const a = await fetch(m.baseUrl + '/v1/responses', { method: 'POST', body: '{}' });
      const aText = await a.text();
      const b = await fetch(m.baseUrl + '/v1/responses', { method: 'POST', body: '{}' });
      const bText = await b.text();

      expect(aText).toContain('"name":"first"');
      expect(aText).not.toContain('"name":"second"');
      expect(bText).toContain('"name":"second"');
      expect(bText).not.toContain('"name":"first"');
    } finally {
      await m.close();
    }
  });

  it('blocks the POST handler until a turn is queued (no 400)', async () => {
    const m = await startMockModel();
    try {
      const pending = fetch(m.baseUrl + '/v1/responses', { method: 'POST', body: '{}' });
      // give the request a tick to actually arrive at the server
      await new Promise((r) => setTimeout(r, 50));
      expect(m.hasPending()).toBe(true);
      m.queueTurn([sseAssistantText('ok'), sseTurnComplete()]);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(m.requestCount).toBe(1);
    } finally {
      await m.close();
    }
  });

  it('awaitNextRequest resolves with the request body once codex POSTs', async () => {
    const m = await startMockModel();
    try {
      const next = m.awaitNextRequest();
      void fetch(m.baseUrl + '/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"input":"hello"}',
      }).then(async (r) => {
        // drain so the server can finalize the response after queueTurn
        await r.text().catch(() => undefined);
      });
      const { body } = await next;
      expect(body).toEqual({ input: 'hello' });
      // unblock the parked POST so close() can complete cleanly
      m.queueTurn([sseAssistantText('ok'), sseTurnComplete()]);
    } finally {
      await m.close();
    }
  });

  it('404s on unrelated paths and methods', async () => {
    const m = await startMockModel();
    try {
      const get = await fetch(m.baseUrl + '/v1/responses');
      expect(get.status).toBe(404);
      const wrong = await fetch(m.baseUrl + '/v1/wrong', { method: 'POST', body: '{}' });
      expect(wrong.status).toBe(404);
    } finally {
      await m.close();
    }
  });
});
