import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  RunCompletionShareCard,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildRunCompletionShareCardProps,
} from './RunCompletionShareCard.js';
import type { RunCompletionStats } from '../types/events.js';

const forbidden = [
  '/Users/alfredvc/src/aharness/examples/raw.fsm.ts',
  'repoRoot',
  'fsmFile',
  '0123456789abcdef0123456789abcdef01234567',
  'run-1',
  'codex-test-pin',
  'transcript text',
  'raw command output',
  'owner input',
  'feature/private-branch',
  'https://github.com/example/private',
  'packages/core/src/private.ts',
  'command output',
];

function stats(overrides: Partial<RunCompletionStats> = {}): RunCompletionStats {
  return {
    outcome: 'success',
    fsmDisplayName: 'autonomous repair',
    duration: { elapsedMs: 125_000 },
    transitionCount: 8,
    freshClearCount: 2,
    mainTurnCount: 3,
    subthreadTurnCount: 4,
    tokenTotals: {
      totalTokens: 9876,
      inputTokens: 4000,
      cachedInputTokens: 1000,
      outputTokens: 4876,
      reasoningOutputTokens: 2200,
      mainTokens: 7000,
      subthreadTokens: 2800,
      unattributedTokens: 76,
    },
    topologyStatus: 'available',
    stateBuckets: Array.from({ length: 7 }, (_, index) => ({
      id: `workflow.state-${index}`,
      label: index === 6 ? forbidden[11] : `state ${index}`,
      elapsedMs: (index + 1) * 10_000,
      eventCount: index + 2,
      transitionCount: index,
      mainTurnCount: index % 2,
      subthreadTurnCount: index + 1,
      tokenTotals: {
        totalTokens: (index + 1) * 100,
        inputTokens: 40,
        cachedInputTokens: 10,
        outputTokens: 60,
        reasoningOutputTokens: 20,
      },
    })),
    workDelta: { status: 'available', filesChanged: 5, linesAdded: 44, linesDeleted: 12 },
    ...overrides,
  };
}

function render(statsValue: RunCompletionStats): string {
  const props = buildRunCompletionShareCardProps(statsValue);
  if (props === null) throw new Error('expected share-card props');
  return renderToStaticMarkup(createElement(RunCompletionShareCard, props));
}

describe('RunCompletionShareCard', () => {
  it('builds safe props only for success and failure outcomes', () => {
    expect(buildRunCompletionShareCardProps(stats({ outcome: 'success' }))?.outcome).toBe(
      'success',
    );
    expect(buildRunCompletionShareCardProps(stats({ outcome: 'failure' }))?.outcome).toBe(
      'failure',
    );
    expect(buildRunCompletionShareCardProps(stats({ outcome: 'unknown' }))).toBeNull();
  });

  it('renders a fixed-size self-contained SVG for success and failure', () => {
    const successHtml = render(stats({ outcome: 'success' }));
    const failureHtml = render(stats({ outcome: 'failure' }));

    expect(successHtml).toContain(`width="${SHARE_CARD_WIDTH}"`);
    expect(successHtml).toContain(`height="${SHARE_CARD_HEIGHT}"`);
    expect(successHtml).toContain(`viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}"`);
    expect(successHtml).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(successHtml).toContain('Completed');
    expect(failureHtml).toContain('Failed');
    expect(successHtml).toContain('font-family');
    expect(successHtml).not.toContain('class=');
  });

  it('renders approved metrics, unavailable work as N/A, and an Other states row', () => {
    const html = render(
      stats({
        workDelta: { status: 'unavailable', reason: 'missing' },
      }),
    );

    expect(html).toContain('autonomous repair');
    expect(html).toContain('2m 05s');
    expect(html).toContain('9,876');
    expect(html).toContain('Fresh clears');
    expect(html).toContain('N/A');
    expect(html).toContain('Other states');
  });

  it('does not render forbidden low-disclosure strings', () => {
    const html = render(stats());

    for (const value of forbidden) {
      expect(html).not.toContain(value);
    }
  });
});
