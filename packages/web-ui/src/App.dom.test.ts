// @vitest-environment jsdom

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AharnessShell } from './App.js';
import type { UiActions, UiState } from './state/store.js';

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
});
