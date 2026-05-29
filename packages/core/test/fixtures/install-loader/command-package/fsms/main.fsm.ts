import { aharness, embed, exit, final, state } from '@aharness/core';
import dependencyChild from '@scope/dependency-package/fsms/dependency-child.fsm.js';
import { dependencyHelper } from '@scope/dependency-package/src/dependency-helper.js';
import { assign } from 'xstate';
import samePackageChild from './child.fsm.js';
import { commandHelper } from './helper.js';
import type { RoutePayload } from './payloadTypes.js';

interface RouteContext {
  readonly routedBy?: string;
}

export default aharness.machine({
  id: `installed-${commandHelper()}-${dependencyHelper()}`,
  initial: 'router',
  states: {
    router: state<RouteContext>({
      entryPrompt: `route ${commandHelper()} ${dependencyHelper()}`,
      exits: {
        go: exit<RoutePayload, RouteContext>({
          when: [
            {
              guard: ({ event }) => event.payload.destination === 'dependency',
              to: 'dependency',
              actions: assign({
                routedBy: () => dependencyHelper(),
              }),
            },
            {
              to: 'same',
              actions: assign({
                routedBy: () => dependencyHelper(),
              }),
            },
          ],
        }),
      },
    }),
    same: embed(samePackageChild, {
      on: {
        shipped: { target: 'done' },
        failed: { target: 'router' },
      },
    }),
    dependency: embed(dependencyChild, {
      on: {
        dependencyDone: { target: 'done' },
        dependencyFailed: { target: 'router' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
