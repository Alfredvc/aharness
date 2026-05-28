import { describe, expect, it } from 'vitest';
import { harness } from '../src/state/machine.js';
import { state, exit, final } from '../src/state/exits.js';
import { embed } from '../src/state/embed.js';

describe('injectFrameworkActions — embedded-compound marker skip', () => {
  it('does NOT write __harness_authoredOnKeys onto an embedded-compound node', () => {
    const childConfig = {
      id: 'child',
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' as const }),
      },
    };
    const child = harness.machine(childConfig as never);
    const parent = harness.machine({
      id: 'parent',
      initial: 'inner',
      states: {
        inner: embed(child, { on: { done: { target: 'finalDone' } } }),
        finalDone: final({ outcome: 'success' as const }),
      },
    } as never);
    const innerNode = parent.root.states['inner'];
    const innerHarnessMeta = (
      innerNode!.meta as
        | { harness?: { embedded?: unknown; __harness_authoredOnKeys?: unknown } }
        | undefined
    )?.harness;
    expect(innerHarnessMeta?.embedded).toBeDefined();
    // The marker must NOT be set on the embedded-compound's harness meta.
    expect(innerHarnessMeta?.__harness_authoredOnKeys).toBeUndefined();
  });

  it('still writes the marker on leaf states inside the embedded compound', () => {
    const childConfig = {
      id: 'child',
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' as const }),
      },
    };
    const child = harness.machine(childConfig as never);
    const parent = harness.machine({
      id: 'parent',
      initial: 'inner',
      states: {
        inner: embed(child, { on: { done: { target: 'finalDone' } } }),
        finalDone: final({ outcome: 'success' as const }),
      },
    } as never);
    const innerGoNode = parent.root.states['inner']!.states['go'];
    const innerGoMeta = (
      innerGoNode?.meta as { harness?: { __harness_authoredOnKeys?: unknown } } | undefined
    )?.harness;
    expect(innerGoMeta?.__harness_authoredOnKeys).toBeDefined();
  });
});
