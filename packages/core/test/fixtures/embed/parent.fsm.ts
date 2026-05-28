import { harness, state, exit, final, embed } from '../../../src/index.js';
import { assign } from 'xstate';
import child from './child.fsm.js';

interface RouteData {
  readonly choice: 'embed' | 'skip';
}
interface ParentCtx {
  readonly capturedShippedOutput: unknown;
  readonly capturedFailedOutput: unknown;
}

export default harness.machine({
  id: 'parent',
  initial: 'router',
  context: (): ParentCtx => ({
    capturedShippedOutput: undefined,
    capturedFailedOutput: undefined,
  }),
  states: {
    router: state({
      entryPrompt: 'choose',
      exits: {
        go: exit<RouteData>({ to: 'inner' }),
      },
    }),
    inner: embed(child, {
      on: {
        shipped: {
          target: 'done',
          actions: assign({
            capturedShippedOutput: ({ event }) => (event as { output?: unknown }).output,
          }),
        },
        failed: {
          target: 'router',
          actions: assign({
            capturedFailedOutput: ({ event }) => (event as { output?: unknown }).output,
          }),
        },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
