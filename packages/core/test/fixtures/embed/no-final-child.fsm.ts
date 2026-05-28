import { aharness, state, exit, final } from '../../../src/index.js';

// A child with NO final() nodes. Build a parent that bypasses embed()'s
// constructor-time check by hand-constructing the embedded shape — and read
// the child's pre-synthesis __aharnessRawConfig (NOT the compiled .config) so
// we don't end up double-walking SUBMIT__ keys when the parent synthesizes.
const childWithNoFinal = aharness.machine({
  id: 'noFinalChild',
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'spin forever',
      exits: {
        loop: exit<{ noop: true }>({ to: 'go' }),
      },
    }),
  },
});

const childRaw = (childWithNoFinal as { __aharnessRawConfig: { states: unknown; initial: string } })
  .__aharnessRawConfig;

export default aharness.machine({
  id: 'parentWithNoFinalChild',
  initial: 'inner',
  states: {
    inner: {
      initial: childRaw.initial,
      states: childRaw.states as never,
      meta: {
        aharness: {
          embedded: {
            source: 'noFinalChild',
            exits: [],
            onMap: {},
            childConfig: childRaw,
          },
        },
      },
    } as never,
    done: final({ outcome: 'success' }),
  },
});
