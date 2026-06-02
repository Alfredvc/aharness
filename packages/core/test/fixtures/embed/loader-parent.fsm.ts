import { aharness, state, exit, final, embed, skill, skillDir } from '@aharness/core';
import child from './loader-child.fsm.js';

interface RoutePayload {
  readonly choice: 'embed' | 'skip';
}

export default aharness.machine({
  id: 'loaderParent',
  availableSkills: [skill({ path: './root-skill/SKILL.md' }), skillDir('./root-skills')],
  initial: 'router',
  states: {
    router: state({
      entryPrompt: 'choose',
      exits: {
        go: exit<RoutePayload>({ to: 'inner' }),
      },
    }),
    inner: embed(child, {
      on: {
        shipped: { target: 'done' },
        failed: { target: 'router' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
