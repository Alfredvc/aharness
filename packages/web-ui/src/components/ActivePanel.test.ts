import { describe, expect, it } from 'vitest';

import { buildNodeDetailRowsForTest } from './ActivePanel.js';
import { canAcceptElicitation } from './elicitationActions.js';

describe('ActivePanel elicitation actions', () => {
  it('only offers accept when the browser can send valid elicitation content', () => {
    expect(canAcceptElicitation({ mode: 'url' })).toBe(true);
    expect(canAcceptElicitation({ mode: 'form' })).toBe(false);
  });
});

describe('ActivePanel inspect node details', () => {
  it('formats prompt, clear, hooks, and exit details for visualize mode', () => {
    expect(
      buildNodeDetailRowsForTest({
        id: 'plan',
        label: 'plan',
        kind: 'stateful',
        detail: {
          entryPrompt: { kind: 'static', text: 'Plan carefully.' },
          clearOnEntry: true,
          open: true,
          hooks: [{ kind: 'PreToolUse', count: 1, matchers: ['^Bash$'] }],
          exits: [
            {
              name: 'submitPlan',
              kind: 'submit',
              targets: ['review'],
              description: 'Plan is ready.',
            },
          ],
        },
      }),
    ).toEqual([
      { label: 'mode', value: 'open' },
      { label: 'clear on entry', value: 'yes' },
      { label: 'entry prompt', value: 'Plan carefully.' },
      { label: 'hooks', value: 'PreToolUse x1 (^Bash$)' },
      { label: 'exits', value: 'submitPlan -> review: Plan is ready.' },
    ]);
  });
});
