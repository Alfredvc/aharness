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

function renderStaticHost(props: {
  completionStats: RunCompletionStats | null;
  loading?: boolean;
  error?: string | null;
}): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderStatic(props);
  return container;
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

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
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
  vi.restoreAllMocks();
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

    expect(html).toContain('workflow');
    expect(html).toContain('1m 05s');
    expect(html).toContain('1,234');
    expect(html).toContain('Token burn');
    expect(html).toContain('Cache hit');
    expect(html).toContain('Input');
    expect(html).toContain('Cached input');
    expect(html).toContain('Reasoning');
    expect(html).toContain('17 lines');
    expect(html).toContain('Time by state');
    expect(html).toContain('Tokens by state');
    expect(html).toContain('State activity');
    expect(html).toContain('FSM topology');
    expect(html).toContain('12');
    expect(html).toContain('collect');
    expect(html).toContain('Transitions');
    expect(html).toContain('Turns');
    expect(html).toContain('+12 / -5');
    expect(html).not.toContain('Main tokens');
    expect(html).not.toContain('Subthread tokens');
    expect(html).not.toContain('Display-safe terminal FSM run summary');
  });

  it('sorts the tokens by state card by total tokens', () => {
    const container = renderStaticHost({
      completionStats: stats({
        stateBuckets: [
          {
            id: 'workflow.long',
            label: 'longTimeLowTokens',
            elapsedMs: 50_000,
            eventCount: 2,
            transitionCount: 1,
            mainTurnCount: 1,
            subthreadTurnCount: 0,
            tokenTotals: {
              totalTokens: 100,
              inputTokens: 40,
              cachedInputTokens: 10,
              outputTokens: 60,
              reasoningOutputTokens: 20,
            },
          },
          {
            id: 'workflow.short',
            label: 'shortTimeHighTokens',
            elapsedMs: 5_000,
            eventCount: 2,
            transitionCount: 1,
            mainTurnCount: 1,
            subthreadTurnCount: 0,
            tokenTotals: {
              totalTokens: 900,
              inputTokens: 300,
              cachedInputTokens: 100,
              outputTokens: 600,
              reasoningOutputTokens: 120,
            },
          },
          {
            id: 'workflow.middle',
            label: 'middleTokens',
            elapsedMs: 10_000,
            eventCount: 2,
            transitionCount: 1,
            mainTurnCount: 1,
            subthreadTurnCount: 0,
            tokenTotals: {
              totalTokens: 500,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 300,
              reasoningOutputTokens: 80,
            },
          },
        ],
      }),
    });
    const tokenPanel = Array.from(container.querySelectorAll('.final-overview-state-panel')).find(
      (panel) => panel.textContent?.includes('Tokens by state'),
    );

    expect(
      Array.from(tokenPanel?.querySelectorAll('.final-overview-state-row b') ?? []).map(
        (label) => label.textContent,
      ),
    ).toEqual(['shortTimeHighTokens', 'middleTokens', 'longTimeLowTokens']);
  });

  it('renders share controls for failure but not unknown outcomes', () => {
    const failureHtml = renderStatic({ completionStats: stats({ outcome: 'failure' }) });
    const unknownHtml = renderStatic({ completionStats: stats({ outcome: 'unknown' }) });

    expect(failureHtml).toContain('workflow');
    expect(failureHtml).toContain('Terminal failure');
    expect(failureHtml).toContain('aria-label="Download summary image"');
    expect(failureHtml).toContain('aria-label="Copy summary image to clipboard"');
    expect(failureHtml).not.toContain('Summary image');
    expect(unknownHtml).toContain('workflow');
    expect(unknownHtml).toContain('Partial terminal summary');
    expect(unknownHtml).not.toMatch(/download summary image|copy summary image|share/i);
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
    expect(html).toContain('work delta unavailable');
  });

  it('does not render low-disclosure forbidden fields', () => {
    const html = renderStatic({ completionStats: stats() });

    expect(html).not.toMatch(
      /run-1|repoRoot|fsmFile|codex|git head|[a-f0-9]{40}|transcript text|owner input|raw tool output|command output/i,
    );
  });

  it('renders direct summary image export actions only for shareable SVG stats', () => {
    const success = renderInteractive({ completionStats: stats() });

    expect(success.querySelector('.final-overview-share-card-frame')).toBeNull();
    expect(success.querySelector('.final-overview-share-card-source svg')).not.toBeNull();
    expect(buttonByLabel(success, 'Download summary image')).not.toBeNull();
    expect(buttonByLabel(success, 'Copy summary image to clipboard')).not.toBeNull();
    expect(success.textContent).not.toContain('Summary image');

    act(() => {
      root?.unmount();
    });
    root = null;
    success.remove();

    const unknown = renderInteractive({ completionStats: stats({ outcome: 'unknown' }) });

    expect(unknown.querySelector('.final-overview-share-card-source svg')).toBeNull();
    expect(unknown.querySelector('button[aria-label="Download summary image"]')).toBeNull();
    expect(
      unknown.querySelector('button[aria-label="Copy summary image to clipboard"]'),
    ).toBeNull();
    expect(unknown.textContent).not.toContain('Summary image');
  });

  it('keeps the modal open and reports distinct copy failure status', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const onClose = vi.fn();
    const container = renderInteractive({ completionStats: stats(), onClose });

    await act(async () => {
      buttonByLabel(container, 'Copy summary image to clipboard').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('.final-overview-modal')).not.toBeNull();
    expect(container.textContent).toContain('Copy Summary Image unsupported in this browser.');
  });

  it('shows a copied toast after the share icon copies the summary image', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['png'], { type: 'image/png' }));
    });
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        set src(_value: string) {
          this.onload?.();
        }
      },
    );
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:summary-image',
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(_items: Record<string, Blob>) {}
      },
    );
    const container = renderInteractive({ completionStats: stats() });

    await act(async () => {
      buttonByLabel(container, 'Copy summary image to clipboard').click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('summary copied to clipboard');
  });
});
