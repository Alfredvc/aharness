import { describe, expect, it } from 'vitest';
import { final, terminal } from '../src/state/exits.js';
import { createFsm } from '../src/index.js';

describe('final()', () => {
  it('returns an XState final config with terminal meta', () => {
    const node = final({ outcome: 'success' });
    expect(node.type).toBe('final');
    expect(node.meta.harness.kind).toBe('terminal');
    expect(node.meta.harness.outcome).toBe('success');
    expect(node.meta.harness.output).toBeUndefined();
  });

  it('carries an output callback when provided', () => {
    const cb = ({ context }: { context: { x: number } }) => ({ x: context.x });
    const node = final({ outcome: 'success', output: cb });
    expect(node.meta.harness.output).toBe(cb);
  });

  it('is structurally compatible with terminal() for downstream consumers', () => {
    const a = terminal('failure');
    const b = final({ outcome: 'failure' });
    expect(a.type).toBe(b.type);
    expect(a.meta.harness.kind).toBe(b.meta.harness.kind);
    expect(a.meta.harness.outcome).toBe(b.meta.harness.outcome);
  });

  it('throws when outcome is missing', () => {
    expect(() => final({} as never)).toThrow(/outcome/);
  });

  it('throws when output is provided but not a function', () => {
    expect(() => final({ outcome: 'success', output: 'no' as never })).toThrow(
      /output must be a function/,
    );
  });
});

describe('createFsm().final()', () => {
  it('carries typed output and final artifact renderers on terminal metadata', () => {
    const fsm = createFsm<{ fruit: string | null }>();
    const render = (data: Readonly<{ fruit: string | null }>) => `Fruit: ${data.fruit ?? 'none'}`;
    const node = fsm.final({
      outcome: 'success',
      output: (data) => ({ fruit: data.fruit }),
      artifacts: {
        'result.md': render,
      },
    });

    expect(node.type).toBe('final');
    expect(node.meta.harness.kind).toBe('terminal');
    expect(node.meta.harness.output).toEqual(expect.any(Function));
    expect(node.meta.harness.artifacts).toEqual({ 'result.md': render });
  });
});
