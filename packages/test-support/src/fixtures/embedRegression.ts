/**
 * Phase 2d embed regression fixture.
 *
 * The parent enters an embedded child. The child reaches `final()`, the
 * synthesized bare final-id raise fires, and the parent captures the child
 * final output before transitioning to its own terminal state.
 */
import { embed, exit, final, harness, state, type HarnessMachine } from '@aharness/core';

interface EmptyPayload {
  readonly _empty?: never;
}

interface ParentContext {
  childOutput: unknown;
}

const child = harness.machine({
  id: 'embed-regression-child',
  initial: 'work',
  states: {
    work: state({
      entryPrompt: 'finish the child',
      exits: {
        ship: exit<EmptyPayload>({ to: 'shipped' }),
      },
    }),
    shipped: final({
      outcome: 'success',
      output: ({ event }) => ({
        childReachedFinal: true,
        payload: (event as { payload?: unknown }).payload,
      }),
    }),
  },
});

export const embedRegressionMachine: HarnessMachine<
  unknown,
  unknown,
  Record<string, unknown>
> = harness.machine({
  id: 'embed-regression-parent',
  initial: 'child',
  context: (): ParentContext => ({
    childOutput: undefined,
  }),
  states: {
    child: embed(child, {
      on: {
        shipped: {
          target: 'done',
          actions: ({ context, event }) => {
            (context as ParentContext).childOutput = (event as { output?: unknown }).output;
          },
        },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});

export const EMBED_REGRESSION_FSM_SOURCE = `import { embed, exit, final, harness, state } from '@aharness/core';

interface EmptyPayload {
  _empty?: never;
}

interface ParentContext {
  childOutput: unknown;
}

const child = harness.machine({
  id: 'embed-regression-child',
  initial: 'work',
  states: {
    work: state({
      entryPrompt: 'finish the child',
      exits: {
        ship: exit<EmptyPayload>({ to: 'shipped' }),
      },
    }),
    shipped: final({
      outcome: 'success',
      output: ({ event }) => ({
        childReachedFinal: true,
        payload: (event as { payload?: unknown }).payload,
      }),
    }),
  },
});

export default harness.machine({
  id: 'embed-regression-parent',
  initial: 'child',
  context: (): ParentContext => ({
    childOutput: undefined,
  }),
  states: {
    child: embed(child, {
      on: {
        shipped: {
          target: 'done',
          actions: ({ context, event }) => {
            (context as ParentContext).childOutput = (event as { output?: unknown }).output;
          },
        },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
`;
