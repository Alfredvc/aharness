import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BootSkeleton } from './BootSkeleton.js';

describe('BootSkeleton', () => {
  it('describes foreground startup without resume or snapshot hydration copy', () => {
    const html = renderToStaticMarkup(createElement(BootSkeleton, { connection: 'connecting' }));

    expect(html).toContain('opening fresh thread');
    expect(html).not.toContain('hydrating snapshot');
    expect(html).not.toContain('--resume');
  });

  it('describes lost connections as ended foreground runs with inspectable artifacts', () => {
    const html = renderToStaticMarkup(createElement(BootSkeleton, { connection: 'lost' }));

    expect(html).toContain('The foreground aharness run ended.');
    expect(html).toContain('Run artifacts remain inspectable.');
    expect(html).not.toContain('--resume');
    expect(html).not.toContain('reconnect');
  });
});
