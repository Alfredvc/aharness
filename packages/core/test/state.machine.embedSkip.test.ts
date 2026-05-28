import { describe, expect, it } from 'vitest';
import { aharness } from '../src/state/machine.js';
import { state, exit, final } from '../src/state/exits.js';
import { embed } from '../src/state/embed.js';

describe('injectFrameworkActions — embedded-compound marker skip', () => {
  it('does NOT write __aharness_authoredOnKeys onto an embedded-compound node', () => {
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
    const child = aharness.machine(childConfig as never);
    const parent = aharness.machine({
      id: 'parent',
      initial: 'inner',
      states: {
        inner: embed(child, { on: { done: { target: 'finalDone' } } }),
        finalDone: final({ outcome: 'success' as const }),
      },
    } as never);
    const innerNode = parent.root.states['inner'];
    const innerAharnessMeta = (
      innerNode!.meta as
        | { aharness?: { embedded?: unknown; __aharness_authoredOnKeys?: unknown } }
        | undefined
    )?.aharness;
    expect(innerAharnessMeta?.embedded).toBeDefined();
    // The marker must NOT be set on the embedded-compound's aharness meta.
    expect(innerAharnessMeta?.__aharness_authoredOnKeys).toBeUndefined();
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
    const child = aharness.machine(childConfig as never);
    const parent = aharness.machine({
      id: 'parent',
      initial: 'inner',
      states: {
        inner: embed(child, { on: { done: { target: 'finalDone' } } }),
        finalDone: final({ outcome: 'success' as const }),
      },
    } as never);
    const innerGoNode = parent.root.states['inner']!.states['go'];
    const innerGoMeta = (
      innerGoNode?.meta as { aharness?: { __aharness_authoredOnKeys?: unknown } } | undefined
    )?.aharness;
    expect(innerGoMeta?.__aharness_authoredOnKeys).toBeDefined();
  });
});
