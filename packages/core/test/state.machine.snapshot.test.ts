import { describe, expect, it } from 'vitest';
import { harness } from '../src/state/machine.js';
import { state, exit, terminal } from '../src/state/exits.js';

describe('harness.machine() — __harnessRawConfig snapshot', () => {
  it('stashes a non-enumerable, top-level-frozen pre-synthesis snapshot of the input config', () => {
    const inputConfig = {
      id: 'test',
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    };
    const compiled = harness.machine(inputConfig as never);
    const snapshot = (compiled as { __harnessRawConfig?: unknown }).__harnessRawConfig;
    expect(snapshot).toBeDefined();
    // Top-level is frozen so callers cannot replace `states`.
    expect(Object.isFrozen(snapshot)).toBe(true);
    // But inner objects are NOT frozen — `embed()` will clone them, and the
    // parent's synthesis pass mutates the clone via injectFrameworkActions.
    const snap = snapshot as { states: Record<string, { on?: Record<string, unknown> }> };
    expect(Object.isFrozen(snap.states)).toBe(false);
    expect(Object.isFrozen(snap.states.go)).toBe(false);
    // Snapshot is non-enumerable.
    const desc = Object.getOwnPropertyDescriptor(compiled, '__harnessRawConfig');
    expect(desc?.enumerable).toBe(false);
    // Snapshot's `go` state has no SUBMIT__ keys (pre-synthesis).
    const goOn = snap.states.go.on ?? {};
    const submitKeys = Object.keys(goOn).filter((k) => k.startsWith('SUBMIT__'));
    expect(submitKeys).toEqual([]);
    // Sanity: the compiled machine's live StateNode tree DOES have SUBMIT__
    // keys (post-synthesis). We read the StateNode rather than `compiled.config`
    // because XState 5 may copy or normalize the config object during
    // `createMachine`; the StateNode tree is what `iterStates` and the
    // verifier actually walk.
    const goNode = compiled.root.states['go'];
    const goNodeOn = (goNode as { on?: Record<string, unknown> }).on ?? {};
    const submitKeysFromNode = Object.keys(goNodeOn).filter((k) => k.startsWith('SUBMIT__'));
    expect(submitKeysFromNode.length).toBeGreaterThan(0);
  });

  it('snapshot preserves function references', () => {
    // Use a `state(...)` with a function-form `entryPrompt` to exercise
    // the function-reference preservation contract. (T2's `final({output: cb})`
    // would also exercise it but is not yet landed; `entryPrompt` as a
    // function is on the same code path through `cloneConfigPreservingFns`.)
    const promptFn = () => 'do the thing';
    const compiled = harness.machine({
      id: 'test',
      initial: 'go',
      states: {
        go: state({
          entryPrompt: promptFn,
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    } as never);
    const snap = (
      compiled as {
        __harnessRawConfig: {
          states: { go: { meta: { harness: { entryPrompt: unknown } } } };
        };
      }
    ).__harnessRawConfig;
    expect(snap.states.go.meta.harness.entryPrompt).toBe(promptFn);
  });
});
