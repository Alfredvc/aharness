import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InteractionSlot, OwnerChoiceSlot } from './InteractionSlot.js';
import type { UiActions } from '../state/store.js';

const reply: UiActions['reply'] = () => Promise.resolve();

describe('InteractionSlot', () => {
  it('renders framework-owned choices separately from owner-input choices', () => {
    const ownerChoice = renderToStaticMarkup(
      createElement(OwnerChoiceSlot, {
        reply,
        req: {
          kind: 'OwnerChoice',
          id: 'owner-choice:pick#1',
          requestId: 'owner-choice:pick#1',
          state: 'pick',
          visitCount: 1,
          question: 'Pick a route',
          options: [{ label: 'North' }, { label: 'South' }],
        },
      }),
    );
    const ownerInputChoice = renderToStaticMarkup(
      createElement(InteractionSlot, {
        reply,
        req: {
          kind: 'ServerRequest',
          id: 'owner-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Route',
              question: 'Which route?',
              isOther: true,
              isSecret: false,
              choices: ['North', '__other__'],
            },
          ],
        },
      }),
    );

    expect(ownerChoice).toContain('framework choice');
    expect(ownerChoice).toContain('Pick a route');
    expect(ownerChoice).not.toContain('other');
    expect(ownerInputChoice).toContain('awaits owner');
    expect(ownerInputChoice).toContain('Which route?');
    expect(ownerInputChoice).toContain('other');
  });
});
