import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FinalOverviewModal } from './FinalOverviewModal.js';
import type { RunCompletionStats } from '../types/events.js';

function stats(overrides: Partial<RunCompletionStats> = {}): RunCompletionStats {
  return {
    outcome: 'success',
    fsmDisplayName: 'workflow',
    duration: { elapsedMs: 65_000 },
    transitionCount: 4,
    freshClearCount: 1,
    mainTurnCount: 2,
    subthreadTurnCount: 1,
    tokenTotals: {
      totalTokens: 1234,
      inputTokens: 500,
      cachedInputTokens: 100,
      outputTokens: 734,
      reasoningOutputTokens: 300,
      mainTokens: 900,
      subthreadTokens: 300,
      unattributedTokens: 34,
    },
    topologyStatus: 'available',
    stateBuckets: [
      {
        id: 'workflow.collect',
        label: 'collect',
        elapsedMs: 40_000,
        eventCount: 7,
        transitionCount: 2,
        mainTurnCount: 1,
        subthreadTurnCount: 1,
        tokenTotals: {
          totalTokens: 800,
          inputTokens: 300,
          cachedInputTokens: 80,
          outputTokens: 500,
          reasoningOutputTokens: 200,
        },
      },
    ],
    workDelta: { status: 'available', filesChanged: 3, linesAdded: 12, linesDeleted: 5 },
    ...overrides,
  };
}

function render(props: {
  completionStats: RunCompletionStats | null;
  loading?: boolean;
  error?: string | null;
}): string {
  return renderToStaticMarkup(
    createElement(FinalOverviewModal, {
      completionStats: props.completionStats,
      loading: props.loading ?? false,
      error: props.error ?? null,
      onClose: () => undefined,
    }),
  );
}

describe('FinalOverviewModal', () => {
  it('renders loading without stats', () => {
    const html = render({ completionStats: null, loading: true });

    expect(html).toContain('Loading summary');
    expect(html).toContain('Loading exact summary');
  });

  it('renders success stats and available work delta', () => {
    const html = render({ completionStats: stats() });

    expect(html).toContain('workflow completed');
    expect(html).toContain('1m 05s');
    expect(html).toContain('1,234');
    expect(html).toContain('Committed Work');
    expect(html).toContain('12');
    expect(html).toContain('collect');
  });

  it('renders failure and unknown outcomes distinctly without share controls', () => {
    const failureHtml = render({ completionStats: stats({ outcome: 'failure' }) });
    const unknownHtml = render({ completionStats: stats({ outcome: 'unknown' }) });

    expect(failureHtml).toContain('workflow failed');
    expect(unknownHtml).toContain('workflow summary');
    expect(unknownHtml).toContain('Partial terminal summary');
    expect(`${failureHtml}${unknownHtml}`).not.toMatch(/download|copy png|share/i);
  });

  it('renders unavailable work delta as N/A with explanatory copy', () => {
    const html = render({
      completionStats: stats({
        workDelta: { status: 'unavailable', reason: 'missing' },
      }),
    });

    expect(html).toContain('N/A');
    expect(html).toContain('Committed work delta was unavailable from recorded git facts');
  });

  it('does not render low-disclosure forbidden fields', () => {
    const html = render({ completionStats: stats() });

    expect(html).not.toMatch(
      /run-1|repoRoot|fsmFile|codex|git head|[a-f0-9]{40}|transcript text|owner input|raw tool output|command output/i,
    );
  });
});
