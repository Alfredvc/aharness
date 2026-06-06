// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  RunCompletionShareCard,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
} from './RunCompletionShareCard.js';
import { buildRunCompletionShareCardProps } from './shareCardExport.js';
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

function renderSvg(statsValue: RunCompletionStats): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = render(statsValue);
  const svg = host.querySelector('svg');
  if (!svg) throw new Error('expected share-card svg');
  return svg;
}

function requiredElement(container: ParentNode, selector: string): Element {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`missing SVG element: ${selector}`);
  return element;
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
    expect(successHtml).toContain('RUN COMPLETE');
    expect(failureHtml).toContain('RUN FAILED');
    expect(successHtml).not.toContain('Run completed');
    expect(successHtml).toContain('font-family');
    expect(successHtml).not.toContain('class=');
  });

  it('renders the poster hierarchy, unavailable work fallback, and other time bucket', () => {
    const unavailableReason = 'missing';
    const statsValue = stats({
      workDelta: { status: 'unavailable', reason: unavailableReason },
    });
    const props = buildRunCompletionShareCardProps(statsValue);
    if (props === null) throw new Error('expected share-card props');
    const svg = renderSvg(statsValue);

    expect(requiredElement(svg, '#run-completion-share-title').textContent).toContain(
      props.fsmDisplayName,
    );
    expect(props.totalTimeLabel).toBe('2m 05s');
    expect(props.totalTokenLabel).toBe('9,876');
    expect(props.filesChangedLabel).toBe('N/A');
    expect(props.linesChangedLabel).toBe('N/A');
    expect(props.lineDeltaDetailLabel).toBe('N/A');
    expect(props.topTimeBuckets.at(-1)).toEqual(expect.objectContaining({ label: 'Other states' }));

    const posterText = svg.textContent ?? '';
    expect(posterText).toContain('TERMINAL STATE');
    expect(posterText).toContain(props.totalTimeLabel);
    expect(posterText).toContain('TOKEN BURN');
    expect(posterText).toContain(props.totalTokenLabel);
    expect(posterText).toContain('TRANSITIONS');
    expect(posterText).toContain('TURNS');
    expect(posterText).toContain('CHANGES');
    expect(posterText).toContain('Time by state');
    expect(posterText).toContain(props.topTimeBuckets.at(-1)?.label);
    expect(posterText).not.toContain('Main');
    expect(posterText).not.toContain('Subthreads');
    requiredElement(svg, '#share-card-token-burn-bar');

    const footerStatus = requiredElement(svg, 'text[text-anchor="middle"]');
    expect(footerStatus.textContent).toContain('Run with npmjs.com/package/@aharness/core');
    expect(footerStatus.textContent).not.toContain(unavailableReason);
    expect(footerStatus.textContent).not.toContain(props.lineDeltaDetailLabel);
    expect(render(statsValue)).not.toContain('Display-safe poster');
  });

  it('renders success and failure outcome labels in the same poster shape', () => {
    const successSvg = renderSvg(stats({ outcome: 'success' }));
    const failureSvg = renderSvg(stats({ outcome: 'failure' }));

    expect(successSvg.textContent).toContain('RUN COMPLETE');
    expect(successSvg.textContent).toContain('DONE');
    expect(failureSvg.textContent).toContain('RUN FAILED');
    expect(failureSvg.textContent).toContain('HALT');
    requiredElement(successSvg, '#share-card-token-burn-bar');
    requiredElement(failureSvg, '#share-card-token-burn-bar');
  });

  it('builds derived poster metric labels from display-safe completion stats', () => {
    const props = buildRunCompletionShareCardProps(
      stats({
        mainTurnCount: 9,
        subthreadTurnCount: 3,
        tokenTotals: {
          totalTokens: 99_600_000,
          inputTokens: 80_000_000,
          cachedInputTokens: 20_000_000,
          outputTokens: 19_600_000,
          reasoningOutputTokens: 7_000_000,
          mainTokens: 74_700_000,
          subthreadTokens: 24_900_000,
          unattributedTokens: 0,
        },
        workDelta: { status: 'available', filesChanged: 5, linesAdded: 44, linesDeleted: 12 },
        stateBuckets: [
          {
            id: 'workflow.plan',
            label: 'Planning',
            elapsedMs: 50_000,
            eventCount: 6,
            transitionCount: 1,
            mainTurnCount: 3,
            subthreadTurnCount: 1,
            tokenTotals: {
              totalTokens: 700,
              inputTokens: 250,
              cachedInputTokens: 20,
              outputTokens: 450,
              reasoningOutputTokens: 120,
            },
          },
          {
            id: 'workflow.build',
            label: 'Build',
            elapsedMs: 25_000,
            eventCount: 5,
            transitionCount: 2,
            mainTurnCount: 4,
            subthreadTurnCount: 0,
            tokenTotals: {
              totalTokens: 500,
              inputTokens: 200,
              cachedInputTokens: 30,
              outputTokens: 300,
              reasoningOutputTokens: 80,
            },
          },
          {
            id: 'workflow.verify',
            label: 'Verify',
            elapsedMs: 25_000,
            eventCount: 4,
            transitionCount: 1,
            mainTurnCount: 2,
            subthreadTurnCount: 2,
            tokenTotals: {
              totalTokens: 400,
              inputTokens: 180,
              cachedInputTokens: 20,
              outputTokens: 220,
              reasoningOutputTokens: 40,
            },
          },
        ],
      }),
    );

    expect(props).not.toBeNull();
    expect(props?.totalTimeLabel).toBe('2m 05s');
    expect(props?.totalTurnCountLabel).toBe('12');
    expect(props?.transitionCountLabel).toBe('8');
    expect(props?.filesChangedLabel).toBe('5');
    expect(props?.linesChangedLabel).toBe('56');
    expect(props?.lineDeltaDetailLabel).toBe('+44 / -12');
    expect(props?.cacheHitPercentageLabel).toBe('25%');
    expect(props?.outputTokenLabel).toBe('19.6M');
    expect(props?.totalTokenLabel).toBe('99.6M');
    expect(props?.mainTokenPercent).toBe(75);
    expect(props?.subthreadTokenPercent).toBe(25);
    expect(props?.mainTokenPercentageLabel).toBe('75%');
    expect(props?.subthreadTokenPercentageLabel).toBe('25%');
    expect(props?.topTimeBuckets).toEqual([
      expect.objectContaining({ label: 'Planning', percentageLabel: '40%', percent: 40 }),
      expect.objectContaining({ label: 'Build', percentageLabel: '20%', percent: 20 }),
      expect.objectContaining({ label: 'Verify', percentageLabel: '20%', percent: 20 }),
    ]);
  });

  it('renders token burn as a single public aggregate bar without thread split copy', () => {
    const html = render(
      stats({
        tokenTotals: {
          totalTokens: 1000,
          inputTokens: 600,
          cachedInputTokens: 120,
          outputTokens: 400,
          reasoningOutputTokens: 140,
          mainTokens: 250,
          subthreadTokens: 500,
          unattributedTokens: 250,
        },
      }),
    );

    expect(html).not.toContain('Main 25%');
    expect(html).not.toContain('Subthreads 50%');
    expect(html).toContain('id="share-card-token-burn-bar"');
  });

  it('guards poster metric percentages against zero denominators and unavailable work deltas', () => {
    const props = buildRunCompletionShareCardProps(
      stats({
        duration: {},
        tokenTotals: {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          mainTokens: 0,
          subthreadTokens: 0,
          unattributedTokens: 0,
        },
        workDelta: { status: 'unavailable', reason: 'missing' },
        stateBuckets: [
          {
            id: 'workflow.wait',
            label: 'Wait',
            elapsedMs: 0,
            eventCount: 1,
            transitionCount: 0,
            mainTurnCount: 0,
            subthreadTurnCount: 0,
            tokenTotals: {
              totalTokens: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
          },
        ],
      }),
    );

    expect(props).not.toBeNull();
    expect(props?.cacheHitPercentageLabel).toBe('0%');
    expect(props?.mainTokenPercent).toBe(0);
    expect(props?.subthreadTokenPercent).toBe(0);
    expect(props?.mainTokenPercentageLabel).toBe('0%');
    expect(props?.subthreadTokenPercentageLabel).toBe('0%');
    expect(props?.filesChangedLabel).toBe('N/A');
    expect(props?.linesChangedLabel).toBe('N/A');
    expect(props?.lineDeltaDetailLabel).toBe('N/A');
    expect(props?.topTimeBuckets).toEqual([
      expect.objectContaining({ label: 'Wait', percentageLabel: '0%', percent: 0 }),
    ]);
  });

  it('does not render forbidden low-disclosure strings', () => {
    const statsValue = stats();
    const props = buildRunCompletionShareCardProps(statsValue);
    const html = render(statsValue);

    for (const value of forbidden) {
      expect(JSON.stringify(props)).not.toContain(value);
      expect(html).not.toContain(value);
    }
  });
});
