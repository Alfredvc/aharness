import { describe, expect, it } from 'vitest';
import { encodeFunctionCallTurn } from '../src/index.js';

// Event-name expectations are pinned to codex commit
// 127434cd8b968ca3d830ea78106dcb1506bcd843 — see `src/sse.ts` for the full
// citation chain.

describe('encodeFunctionCallTurn', () => {
  it('produces a UInt8Array with response.created + function_call + response.completed events', () => {
    const bytes = encodeFunctionCallTurn({ name: 'foo', arguments: '{"x":1}' });
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain('response.created');
    expect(text).toContain('"name":"foo"');
    expect(text).toContain('response.completed');
  });

  it('embeds the caller-supplied arguments on the function_call item', () => {
    const bytes = encodeFunctionCallTurn({
      name: 'harness_submit',
      arguments: JSON.stringify({ state: 'greet', exit: 'finish', data: {} }),
    });
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain('"name":"harness_submit"');
    expect(text).toContain('"type":"function_call"');
    // `arguments` is wire-encoded as a JSON-stringified string field, so the
    // inner JSON's quotes are escaped on the outer SSE `data:` line.
    expect(text).toContain('\\"state\\":\\"greet\\"');
    expect(text).toContain('\\"exit\\":\\"finish\\"');
  });

  it('uses the caller-supplied callId when provided', () => {
    const bytes = encodeFunctionCallTurn({
      name: 'foo',
      arguments: '{}',
      callId: 'call_fixed_id',
    });
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain('"call_id":"call_fixed_id"');
  });

  it('generates a callId when omitted', () => {
    const bytes = encodeFunctionCallTurn({ name: 'foo', arguments: '{}' });
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toMatch(/"call_id":"call_[a-z0-9]+"/);
  });

  it('emits SSE events in order: response.created → function_call done → response.completed', () => {
    const bytes = encodeFunctionCallTurn({ name: 'foo', arguments: '{}' });
    const text = Buffer.from(bytes).toString('utf8');
    const createdIdx = text.indexOf('event: response.created');
    const doneIdx = text.indexOf('event: response.output_item.done');
    const completedIdx = text.indexOf('event: response.completed');
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(createdIdx);
    expect(completedIdx).toBeGreaterThan(doneIdx);
  });
});
