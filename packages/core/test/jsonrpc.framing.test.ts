import { describe, expect, it } from 'vitest';
import { LineFramer } from '../src/jsonrpc/framing.js';

describe('LineFramer', () => {
  it('emits whole JSON objects on \\n boundaries', () => {
    const f = new LineFramer();
    const got: unknown[] = [];
    f.on('message', (m) => got.push(m));
    f.feed(Buffer.from('{"jsonrpc":"2.0",'));
    f.feed(Buffer.from('"id":1,"result":{}}\n{"jsonrpc":"2.0","method":"x"}\n'));
    expect(got).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', method: 'x' },
    ]);
  });

  it('rejects malformed JSON via emitted error', () => {
    const f = new LineFramer();
    const errs: Error[] = [];
    f.on('error', (e) => errs.push(e));
    f.feed(Buffer.from('not json\n'));
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toMatch(/parse/i);
  });
});
