import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AharnessShell, documentTitleForMode } from './App.js';
import { RunStatsBar } from './components/RunStatsBar.js';
import type { UiActions, UiState } from './state/store.js';

type TestSession = UiState & UiActions;

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
      isTerminal: false,
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
    stateVisits: [
      {
        id: 'workflow.collect#1',
        path: 'workflow.collect',
        seq: 1,
        time: '2026-05-29T00:00:00.000Z',
        from: null,
        to: 'workflow.collect',
        cause: 'boot',
      },
    ],
    statePathVisits: { 'workflow.collect': ['workflow.collect#1'] },
    rowPageCursors: {},
    rowLoadStatus: {},
    recentRowsCursor: null,
    recentRowsLoadStatus: { loading: false, loaded: false, error: null },
    aggregateStats: { turnCount: 0 },
    completionStats: null,
    finalOverview: {
      open: false,
      autoOpened: false,
      dismissed: false,
      loading: false,
      error: null,
    },
    history: [
      {
        at: Date.parse('2026-05-29T00:00:00.000Z'),
        from: null,
        to: 'workflow.collect',
        cause: 'boot',
        visitId: 'workflow.collect#1',
      },
    ],
    turns: [],
    connection: 'live',
    replyError: null,
    rowLoadError: null,
    activeVisitId: 'workflow.collect#1',
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

describe('AharnessShell run stats chrome', () => {
  it('labels view mode as read-only view chrome instead of live execution', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          mode: 'view',
          posture: {
            isTerminal: false,
            isAwaiting: true,
            submittedThisTurn: false,
            open: false,
          },
        }),
      }),
    );

    expect(html).toContain('·\u00a0view');
    expect(html.match(/>view</g) ?? []).toHaveLength(2);
    expect(html).not.toContain('·\u00a0run');
    expect(html).not.toContain('>live<');
    expect(html).not.toContain('awaiting owner');
  });

  it('uses the boot mode in the document title', () => {
    expect(documentTitleForMode('run')).toBe('aharness - run');
    expect(documentTitleForMode('inspect')).toBe('aharness - inspect');
    expect(documentTitleForMode('view')).toBe('aharness - view');
  });

  it('keeps terminal status and summary controls for terminal view-mode runs', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          mode: 'view',
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
        }),
      }),
    );

    expect(html).toContain('·\u00a0view');
    expect(html.match(/>terminal</g) ?? []).toHaveLength(2);
    expect(html).toContain('>summary<');
    expect(html).not.toContain('>live<');
  });

  it('prioritizes completed run status over a lost stream', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          connection: 'lost',
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          aggregateStats: {
            status: 'success',
            startedAt: '2026-05-29T00:00:00.000Z',
            endedAt: '2026-05-29T00:01:05.000Z',
            turnCount: 2,
          },
        }),
      }),
    );

    expect(html).toContain('>completed<');
    expect(html).toContain('data-tone="mint"');
    expect(html).not.toContain('>lost<');
    expect(html).not.toContain('connection lost');
  });

  it('shows a foreground-ended banner only for non-terminal lost sessions', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({ connection: 'lost' }),
      }),
    );

    expect(html).toContain('connection lost');
    expect(html).toContain('foreground run ended');
  });

  it('renders a single completed shell status label for successful terminal runs', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          aggregateStats: {
            status: 'success',
            startedAt: '2026-05-29T00:00:00.000Z',
            endedAt: '2026-05-29T00:01:05.000Z',
            turnCount: 2,
          },
        }),
      }),
    );

    expect(html.match(/>completed</g) ?? []).toHaveLength(1);
    expect(html).not.toContain('>success<');
  });

  it('renders a single failed shell status label for failed terminal runs', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          aggregateStats: {
            status: 'failed',
            startedAt: '2026-05-29T00:00:00.000Z',
            endedAt: '2026-05-29T00:01:05.000Z',
            turnCount: 2,
          },
        }),
      }),
    );

    expect(html.match(/>failed</g) ?? []).toHaveLength(1);
    expect(html).not.toContain('>failure<');
  });

  it('renders aggregate header and bottom stats with formatted duration and token totals', () => {
    const html = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          aggregateStats: {
            status: 'success',
            startedAt: '2026-05-29T00:00:00.000Z',
            endedAt: '2026-05-29T00:01:05.000Z',
            turnCount: 3,
            totalTokens: 1234,
            modelContextWindow: 200000,
          },
          turns: [
            {
              turnId: 'turn-1',
              finishReason: 'stop',
              endedAt: Date.parse('2026-05-29T00:01:05.000Z'),
              stateVisitId: 'workflow.collect#1',
            },
          ],
        }),
      }),
    );

    expect(html).toContain('data-surface="header-run-stats"');
    expect(html).toContain('data-surface="bottom-run-stats"');
    expect(html.match(/1m 05s/g)).toHaveLength(2);
    expect(html).toContain('1,234 tokens');
    expect(html).toContain('context 200,000 tokens');
  });

  it('omits unavailable inspect-mode runtime stats while keeping the bottom surface', () => {
    const html = renderToStaticMarkup(
      createElement(RunStatsBar, {
        session: baseSession({
          mode: 'inspect',
          aggregateStats: { turnCount: 0 },
        }),
        variant: 'bottom',
        nowMs: Date.parse('2026-05-29T00:01:00.000Z'),
      }),
    );

    expect(html).toContain('data-surface="bottom-run-stats"');
    expect(html).toContain('inspect');
    expect(html).toContain('run-1');
    expect(html).not.toContain('data-stat-kind="duration"');
    expect(html).not.toContain('data-stat-kind="tokens"');
    expect(html).not.toContain('data-stat-kind="context"');
  });

  it('uses token breakdown labels when total tokens are absent', () => {
    const html = renderToStaticMarkup(
      createElement(RunStatsBar, {
        session: baseSession({
          aggregateStats: {
            status: 'running',
            startedAt: '2026-05-29T00:00:00.000Z',
            turnCount: 1,
            inputTokens: 5,
            outputTokens: 7,
          },
        }),
        variant: 'header',
        nowMs: Date.parse('2026-05-29T00:00:15.000Z'),
      }),
    );

    expect(html).toContain('input 5 tokens / output 7 tokens');
  });

  it('shows Summary only for terminal runs and renders the terminal modal when open', () => {
    const terminalHtml = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          finalOverview: {
            open: true,
            autoOpened: true,
            dismissed: false,
            loading: true,
            error: null,
          },
        }),
      }),
    );
    const activeHtml = renderToStaticMarkup(
      createElement(AharnessShell, { session: baseSession() }),
    );
    const dismissedHtml = renderToStaticMarkup(
      createElement(AharnessShell, {
        session: baseSession({
          posture: {
            isTerminal: true,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          finalOverview: {
            open: false,
            autoOpened: true,
            dismissed: true,
            loading: false,
            error: null,
          },
        }),
      }),
    );

    expect(terminalHtml).toContain('>summary<');
    expect(terminalHtml).toContain('role="dialog"');
    expect(activeHtml).not.toContain('>summary<');
    expect(activeHtml).not.toContain('role="dialog"');
    expect(dismissedHtml).toContain('>summary<');
    expect(dismissedHtml).not.toContain('role="dialog"');
  });
});
