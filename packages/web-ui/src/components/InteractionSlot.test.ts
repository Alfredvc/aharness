// @vitest-environment jsdom

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
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

  it('marks owner choices as submitting and prevents duplicate submissions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    let resolveReply: (() => void) | null = null;
    const replyCalls: unknown[] = [];
    const pendingReply: UiActions['reply'] = (payload) => {
      replyCalls.push(payload);
      return new Promise<void>((resolve) => {
        resolveReply = resolve;
      });
    };

    act(() => {
      root.render(
        createElement(OwnerChoiceSlot, {
          reply: pendingReply,
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
    });

    const firstChoice = host.querySelector('.choice');
    if (!(firstChoice instanceof HTMLElement)) throw new Error('first choice missing');

    act(() => {
      firstChoice.click();
      firstChoice.click();
    });

    expect(replyCalls).toHaveLength(1);
    expect(host.querySelector('.slot-owner-choice')?.getAttribute('data-submitting')).toBe('true');
    expect(firstChoice.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      resolveReply?.();
      await Promise.resolve();
    });
    act(() => root.unmount());
    host.remove();
  });
});
