// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function renderStatic(props: {
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

function renderInteractive(props: {
  completionStats: RunCompletionStats | null;
  loading?: boolean;
  error?: string | null;
  onClose?: () => void;
}): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(FinalOverviewModal, {
        completionStats: props.completionStats,
        loading: props.loading ?? false,
        error: props.error ?? null,
        onClose: props.onClose ?? (() => undefined),
      }),
    );
  });
  return host;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('FinalOverviewModal', () => {
  it('renders loading without stats', () => {
    const html = renderStatic({ completionStats: null, loading: true });

    expect(html).toContain('Loading summary');
    expect(html).toContain('Loading exact summary');
  });

  it('renders success stats and available work delta', () => {
    const html = renderStatic({ completionStats: stats() });

    expect(html).toContain('workflow completed');
    expect(html).toContain('1m 05s');
    expect(html).toContain('1,234');
    expect(html).toContain('Token burn');
    expect(html).toContain('Cache hit');
    expect(html).toContain('Committed Work');
    expect(html).toContain('17 lines changed');
    expect(html).toContain('Where the time went');
    expect(html).toContain('12');
    expect(html).toContain('collect');
    expect(html.match(/final-overview-dashboard-tile/g)).toHaveLength(4);
    expect(html).not.toContain('Main tokens');
    expect(html).not.toContain('Subthread tokens');
  });

  it('renders share controls for failure but not unknown outcomes', () => {
    const failureHtml = renderStatic({ completionStats: stats({ outcome: 'failure' }) });
    const unknownHtml = renderStatic({ completionStats: stats({ outcome: 'unknown' }) });

    expect(failureHtml).toContain('workflow failed');
    expect(failureHtml).toContain('Share Card');
    expect(failureHtml).toContain('Share');
    expect(unknownHtml).toContain('workflow summary');
    expect(unknownHtml).toContain('Partial terminal summary');
    expect(unknownHtml).not.toMatch(/download|copy png|share/i);
  });

  it('does not render share controls without shareable stats', () => {
    const html = renderStatic({ completionStats: null, loading: true });

    expect(html).not.toMatch(/download|copy png|share/i);
  });

  it('renders unavailable work delta as N/A with explanatory copy', () => {
    const html = renderStatic({
      completionStats: stats({
        workDelta: { status: 'unavailable', reason: 'missing' },
      }),
    });

    expect(html).toContain('N/A');
    expect(html).toContain('Committed work delta was unavailable from recorded git facts');
  });

  it('does not render low-disclosure forbidden fields', () => {
    const html = renderStatic({ completionStats: stats() });

    expect(html).not.toMatch(
      /run-1|repoRoot|fsmFile|codex|git head|[a-f0-9]{40}|transcript text|owner input|raw tool output|command output/i,
    );
  });

  it('opens an intentional poster preview with export actions only for shareable SVG stats', () => {
    const success = renderInteractive({ completionStats: stats() });

    act(() => {
      buttonByText(success, 'Share').click();
    });

    expect(success.querySelector('.final-overview-share-card-frame')).not.toBeNull();
    expect(success.querySelector('.final-overview-share-card svg')).not.toBeNull();
    expect(success.textContent).toContain('Download PNG');
    expect(success.textContent).toContain('Copy PNG');

    act(() => {
      root?.unmount();
    });
    root = null;
    success.remove();

    const unknown = renderInteractive({ completionStats: stats({ outcome: 'unknown' }) });

    expect(unknown.querySelector('.final-overview-share-card svg')).toBeNull();
    expect(unknown.textContent).not.toMatch(/Download PNG|Copy PNG|Share Card/);
  });

  it('keeps the modal open and reports distinct copy failure status', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const onClose = vi.fn();
    const container = renderInteractive({ completionStats: stats(), onClose });

    act(() => {
      buttonByText(container, 'Share').click();
    });
    await act(async () => {
      buttonByText(container, 'Copy PNG').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('.final-overview-modal')).not.toBeNull();
    expect(container.textContent).toContain('Copy PNG unsupported in this browser.');
  });
});
