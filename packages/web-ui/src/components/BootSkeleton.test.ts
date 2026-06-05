// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { BootSkeleton } from './BootSkeleton.js';

function renderBoot(connection: 'live' | 'connecting' | 'lost'): Document {
  document.body.innerHTML = renderToStaticMarkup(createElement(BootSkeleton, { connection }));
  return document;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('BootSkeleton', () => {
  it('renders an accessible busy boot section with ordered startup stages', () => {
    const doc = renderBoot('connecting');

    const section = doc.querySelector('section.boot-skeleton');
    expect(section?.getAttribute('aria-busy')).toBe('true');
    expect(section?.querySelector('.boot-card')).not.toBeNull();
    expect(section?.querySelector('.boot-orbit')?.getAttribute('aria-hidden')).toBe('true');

    const stages = Array.from(doc.querySelectorAll('ol.boot-stages > li.boot-stage'));
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => stage.getAttribute('data-status'))).toEqual([
      'active',
      'pending',
      'pending',
      'pending',
    ]);
    expect(
      stages.every(
        (stage) => (stage.querySelector('.bs-label')?.textContent?.trim().length ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it('marks lost startup as interrupted without an active progress spinner', () => {
    const doc = renderBoot('lost');

    const stages = Array.from(doc.querySelectorAll('ol.boot-stages > li.boot-stage'));
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => stage.getAttribute('data-status'))).toEqual([
      'lost',
      'pending',
      'pending',
      'pending',
    ]);

    expect(doc.querySelector('.bs-ellipsis')).toBeNull();
  });
});
