// @vitest-environment jsdom

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AharnessShell } from './App.js';
import type { UiActions, UiState } from './state/store.js';
import type { RunCompletionStats } from './types/events.js';

type TestSession = UiState & UiActions;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function baseSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    mode: 'run',
    run: {
      runId: 'run-1',
      threadId: 'thread-1',
      repoRoot: '/repo',
      fsmFile: 'workflow.ts',
      fsmHash6: 'abc123',
      codexPin: 'codex-test',
      startedAt: '2026-05-29T00:00:00.000Z',
    },
    latestEventId: 'run-1:4',
    posture: {
      isTerminal: true,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    },
    activeTurnId: null,
    state: {
      path: 'workflow.collect',
      leaf: 'collect',
      kind: 'stateful',
      exits: [],
      visitCount: 1,
    },
    topology: {
      machineId: 'workflow',
      initial: 'workflow.collect',
      nodes: [{ id: 'workflow.collect', label: 'collect', kind: 'stateful' }],
      edges: [],
    },
    transcript: [],
    pending: {
      fileApprovals: [],
      cmdApprovals: [],
      permissionApprovals: [],
      elicitations: [],
      ownerInput: null,
      ownerChoice: null,
    },
    diagnostics: [],
    stateVisits: [],
    statePathVisits: {},
    rowPageCursors: {},
    rowLoadStatus: {},
    recentRowsCursor: null,
    recentRowsLoadStatus: { loading: false, loaded: false, error: null },
    aggregateStats: { turnCount: 0 },
    completionStats: null,
    finalOverview: {
      open: true,
      autoOpened: true,
      dismissed: false,
      loading: true,
      error: null,
    },
    history: [],
    turns: [],
    connection: 'live',
    replyError: null,
    rowLoadError: null,
    activeVisitId: null,
    scopedPath: null,
    devMode: false,
    reply: () => Promise.resolve(),
    requestRowsForStatePath: () => Promise.resolve(),
    requestRecentRows: () => Promise.resolve(),
    openFinalOverview: () => undefined,
    dismissFinalOverview: () => undefined,
    toggleDevMode: () => undefined,
    setScope: () => undefined,
    ...overrides,
  };
}

function completionStats(overrides: Partial<RunCompletionStats> = {}): RunCompletionStats {
  return {
    outcome: 'success',
    fsmDisplayName: 'workflow',
    duration: { elapsedMs: 60_000 },
    transitionCount: 3,
    freshClearCount: 1,
    mainTurnCount: 2,
    subthreadTurnCount: 1,
    tokenTotals: {
      totalTokens: 1000,
      inputTokens: 400,
      cachedInputTokens: 100,
      outputTokens: 600,
      reasoningOutputTokens: 200,
      mainTokens: 800,
      subthreadTokens: 200,
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
          totalTokens: 700,
          inputTokens: 300,
          cachedInputTokens: 80,
          outputTokens: 400,
          reasoningOutputTokens: 120,
        },
      },
    ],
    workDelta: { status: 'available', filesChanged: 2, linesAdded: 10, linesDeleted: 3 },
    ...overrides,
  };
}

function render(session: TestSession): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(AharnessShell, { session }));
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

describe('AharnessShell final overview interactions', () => {
  it('clicking Summary calls openFinalOverview', () => {
    const openFinalOverview = vi.fn();
    const container = render(
      baseSession({
        finalOverview: {
          open: false,
          autoOpened: true,
          dismissed: true,
          loading: false,
          error: null,
        },
        openFinalOverview,
      }),
    );

    act(() => {
      container.querySelector<HTMLButtonElement>('button[title="Open final run summary"]')?.click();
    });

    expect(openFinalOverview).toHaveBeenCalledTimes(1);
  });

  it('clicking close button and backdrop dismisses the overview', () => {
    const dismissFinalOverview = vi.fn();
    const container = render(baseSession({ dismissFinalOverview }));

    act(() => {
      container.querySelector<HTMLButtonElement>('.final-overview-close')?.click();
    });
    act(() => {
      container.querySelector<HTMLDivElement>('.final-overview-layer')?.click();
    });

    expect(dismissFinalOverview).toHaveBeenCalledTimes(2);
  });

  it('pressing Escape dismisses when the overview is open', () => {
    const dismissFinalOverview = vi.fn();
    render(baseSession({ dismissFinalOverview }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(dismissFinalOverview).toHaveBeenCalledTimes(1);
  });

  it('opens the share-card preview from terminal success stats', () => {
    const container = render(
      baseSession({
        completionStats: completionStats(),
        finalOverview: {
          open: true,
          autoOpened: true,
          dismissed: false,
          loading: false,
          error: null,
        },
      }),
    );

    const shareButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Share',
    );
    act(() => {
      shareButton?.click();
    });

    expect(container.querySelector('.final-overview-share-card svg')).not.toBeNull();
    expect(container.textContent).toContain('Download PNG');
    expect(container.textContent).toContain('Copy PNG');
  });
});
