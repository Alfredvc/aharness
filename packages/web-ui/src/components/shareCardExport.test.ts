// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  RunCompletionShareCard,
  type RunCompletionShareCardProps,
} from './RunCompletionShareCard.js';
import {
  buildRunCompletionShareCardProps,
  buildShareCardFilename,
  copyShareCardPng,
  downloadShareCardPng,
  renderShareCardPngBlob,
} from './shareCardExport.js';
import type { RunCompletionStats } from '../types/events.js';

type MockEnvironment = Parameters<typeof renderShareCardPngBlob>[1];

function stats(overrides: Partial<RunCompletionStats> = {}): RunCompletionStats {
  return {
    outcome: 'success',
    fsmDisplayName: 'Autonomous Repair',
    duration: { elapsedMs: 60_000 },
    transitionCount: 3,
    freshClearCount: 1,
    mainTurnCount: 2,
    subthreadTurnCount: 1,
    tokenTotals: {
      totalTokens: 500,
      inputTokens: 200,
      cachedInputTokens: 50,
      outputTokens: 300,
      reasoningOutputTokens: 100,
      mainTokens: 350,
      subthreadTokens: 150,
      unattributedTokens: 0,
    },
    topologyStatus: 'available',
    stateBuckets: [
      {
        id: 'workflow.collect',
        label: 'collect',
        elapsedMs: 30_000,
        eventCount: 4,
        transitionCount: 1,
        mainTurnCount: 1,
        subthreadTurnCount: 0,
        tokenTotals: {
          totalTokens: 300,
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 200,
          reasoningOutputTokens: 50,
        },
      },
    ],
    workDelta: { status: 'available', filesChanged: 2, linesAdded: 10, linesDeleted: 3 },
    ...overrides,
  };
}

function shareProps(overrides: Partial<RunCompletionStats> = {}): RunCompletionShareCardProps {
  const props = buildRunCompletionShareCardProps(stats(overrides));
  if (props === null) throw new Error('expected share props');
  return props;
}

function actualShareCardSvg(props = shareProps()): SVGSVGElement {
  const html = renderToStaticMarkup(createElement(RunCompletionShareCard, props));
  const host = document.createElement('div');
  host.innerHTML = html;
  const svg = host.querySelector('svg');
  if (!svg) throw new Error('svg missing');
  return svg;
}

function mockEnvironment(
  options: {
    blob?: Blob | null;
    mutateCanvasDimensions?: boolean;
    clipboardWrite?: () => Promise<void>;
  } = {},
): {
  environment: MockEnvironment;
  anchorClicks: string[];
  revokedUrls: string[];
  clipboardItems: unknown[];
} {
  const anchorClicks: string[] = [];
  const revokedUrls: string[] = [];
  const clipboardItems: unknown[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {
        if (options.mutateCanvasDimensions) canvas.width = 1;
      },
    }),
    toBlob: (callback: BlobCallback) =>
      callback('blob' in options ? options.blob! : new Blob(['png'], { type: 'image/png' })),
  } as unknown as HTMLCanvasElement;
  const environment: MockEnvironment = {
    document: {
      createElement: (name: string) => {
        if (name === 'canvas') return canvas;
        const anchor = document.createElement('a');
        anchor.click = () => anchorClicks.push(anchor.download);
        return anchor;
      },
    },
    Image: class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    } as unknown as { new (): HTMLImageElement },
    XMLSerializer,
    URL: {
      createObjectURL: () => `blob:${revokedUrls.length}`,
      revokeObjectURL: (url: string) => revokedUrls.push(url),
    },
    navigator: options.clipboardWrite
      ? {
          clipboard: {
            write: (items: ClipboardItem[]) => {
              clipboardItems.push(...items);
              return options.clipboardWrite!();
            },
          },
        }
      : undefined,
    ClipboardItem: class {
      constructor(items: Record<string, Blob>) {
        clipboardItems.push(items);
      }
    } as unknown as { new (items: Record<string, Blob>): ClipboardItem },
  };
  return { environment, anchorClicks, revokedUrls, clipboardItems };
}

describe('shareCardExport', () => {
  it('renders the actual share-card SVG path to a PNG blob', async () => {
    const { environment, revokedUrls } = mockEnvironment();

    const blob = await renderShareCardPngBlob(actualShareCardSvg(), environment);

    expect(blob.type).toBe('image/png');
    expect(revokedUrls).toEqual(['blob:0']);
  });

  it('fails before export when canvas dimensions do not match the fixed share-card size', async () => {
    const { environment } = mockEnvironment({ mutateCanvasDimensions: true });

    await expect(renderShareCardPngBlob(actualShareCardSvg(), environment)).rejects.toThrow(
      'dimension-mismatch',
    );
  });

  it('reports PNG encoding failures when canvas toBlob returns null', async () => {
    const { environment } = mockEnvironment({ blob: null });

    await expect(renderShareCardPngBlob(actualShareCardSvg(), environment)).rejects.toThrow(
      'encoding-failed',
    );
  });

  it('downloads a safe filename and revokes both SVG and PNG Blob URLs', async () => {
    const { environment, anchorClicks, revokedUrls } = mockEnvironment();
    const props = shareProps({
      fsmDisplayName: 'Very Long / Odd Name With Symbols !!! And Extra Text',
    });

    const status = await downloadShareCardPng(actualShareCardSvg(props), props, environment);

    expect(status).toEqual({
      ok: true,
      filename: 'aharness-very-long-odd-name-with-symbols-and-extra-text-success.png',
    });
    expect(anchorClicks).toEqual([
      'aharness-very-long-odd-name-with-symbols-and-extra-text-success.png',
    ]);
    expect(revokedUrls).toEqual(['blob:0', 'blob:1']);
  });

  it('distinguishes download encoding failure and dimension mismatch statuses', async () => {
    const props = shareProps();
    const encoding = await downloadShareCardPng(
      actualShareCardSvg(props),
      props,
      mockEnvironment({ blob: null }).environment,
    );
    const mismatch = await downloadShareCardPng(
      actualShareCardSvg(props),
      props,
      mockEnvironment({ mutateCanvasDimensions: true }).environment,
    );

    expect(encoding).toEqual({ ok: false, kind: 'encoding-failed' });
    expect(mismatch).toEqual({ ok: false, kind: 'dimension-mismatch' });
  });

  it('copies PNG through ClipboardItem when supported', async () => {
    const { environment, clipboardItems } = mockEnvironment({
      clipboardWrite: () => Promise.resolve(),
    });

    const status = await copyShareCardPng(actualShareCardSvg(), environment);

    expect(status).toEqual({ ok: true, kind: 'copied' });
    expect(clipboardItems).toHaveLength(2);
  });

  it('distinguishes unsupported clipboard, permission denial, and encoding failure', async () => {
    const unsupported = await copyShareCardPng(actualShareCardSvg(), mockEnvironment().environment);
    const denied = await copyShareCardPng(
      actualShareCardSvg(),
      mockEnvironment({ clipboardWrite: () => Promise.reject(new Error('denied')) }).environment,
    );
    const encoding = await copyShareCardPng(
      actualShareCardSvg(),
      mockEnvironment({ blob: null, clipboardWrite: vi.fn() }).environment,
    );

    expect(unsupported).toEqual({ ok: false, kind: 'unsupported' });
    expect(denied).toEqual({ ok: false, kind: 'permission-denied' });
    expect(encoding).toEqual({ ok: false, kind: 'encoding-failed' });
  });

  it('distinguishes copy dimension mismatch from other copy failures', async () => {
    const mismatch = await copyShareCardPng(
      actualShareCardSvg(),
      mockEnvironment({
        clipboardWrite: vi.fn(),
        mutateCanvasDimensions: true,
      }).environment,
    );

    expect(mismatch).toEqual({ ok: false, kind: 'dimension-mismatch' });
  });

  it('builds filenames from display-safe props only', () => {
    expect(
      buildShareCardFilename({
        ...shareProps(),
        fsmDisplayName: 'Repo Root / Secret Branch / Workflow',
      }),
    ).toBe('aharness-repo-root-secret-branch-workflow-success.png');
  });
});
