// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useAharnessSession,
  type UseAharnessSessionOptions,
  type UiActions,
  type UiState,
} from './store.js';
import type { RunCompletionStats, RunScopedApiEvent, RunScopedBootstrap } from '../types/events.js';
import type { EventSourceLike, StreamMessageEvent } from '../api/client.js';

type Session = UiState & UiActions;
type SummaryFetcher = NonNullable<UseAharnessSessionOptions['fetchSummary']>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(event: StreamMessageEvent) => void>>();
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: StreamMessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: StreamMessageEvent) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  close(): void {
    this.listeners.clear();
  }

  emit(event: RunScopedApiEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener({ data: JSON.stringify(event), lastEventId: event.id });
    }
  }
}

function stats(overrides: Partial<RunCompletionStats> = {}): RunCompletionStats {
  return {
    outcome: 'success',
    fsmDisplayName: 'workflow',
    duration: { elapsedMs: 1000 },
    transitionCount: 1,
    freshClearCount: 0,
    mainTurnCount: 1,
    subthreadTurnCount: 0,
    tokenTotals: {
      totalTokens: 10,
      inputTokens: 4,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 2,
      mainTokens: 10,
      subthreadTokens: 0,
      unattributedTokens: 0,
    },
    topologyStatus: 'available',
    stateBuckets: [],
    workDelta: { status: 'unavailable', reason: 'missing' },
    ...overrides,
  };
}

function bootstrap(overrides: Partial<RunScopedBootstrap> = {}): RunScopedBootstrap {
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
    topology: {
      machineId: 'workflow',
      initial: 'workflow.collect',
      nodes: [{ id: 'workflow.collect', label: 'collect', kind: 'stateful' }],
      edges: [],
    },
    latestEventId: 'run-1:1',
    currentState: {
      path: 'workflow.collect',
      kind: 'stateful',
      visitCount: 1,
      exits: [],
    },
    posture: {
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    },
    currentStateVisit: null,
    stateVisits: [],
    statePathVisits: {},
    pending: [],
    aggregateStats: { turnCount: 0 },
    recentRows: [],
    diagnostics: [],
    ...overrides,
  };
}

function apiEvent(overrides: Partial<RunScopedApiEvent>): RunScopedApiEvent {
  return {
    schema: 'aharness.event.v1',
    runId: 'run-1',
    seq: 2,
    id: 'run-1:2',
    time: '2026-05-29T00:00:02.000Z',
    type: 'model.delta',
    offset: 1,
    lineBytes: 1,
    ...overrides,
  };
}

function bootstrapFetch(body: RunScopedBootstrap): UseAharnessSessionOptions['fetch'] {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }),
  );
}

async function renderHook(
  options: UseAharnessSessionOptions,
  onSession: (session: Session) => void,
): Promise<void> {
  window.history.pushState({}, '', '/?runId=run-1&token=token-1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  function Probe() {
    const session = useAharnessSession('token-1', options);
    useEffect(() => onSession(session), [session]);
    return null;
  }
  act(() => {
    root?.render(createElement(Probe));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  FakeEventSource.instances = [];
  vi.restoreAllMocks();
});

describe('useAharnessSession final overview summary fetch', () => {
  it('skips summary fetch when terminal bootstrap already has stats', async () => {
    const fetchSummary = vi.fn<SummaryFetcher>();
    const sessions: Session[] = [];

    await renderHook(
      {
        fetch: bootstrapFetch(
          bootstrap({
            posture: { isTerminal: true, isAwaiting: false, submittedThisTurn: false, open: false },
            completionStats: stats(),
          }),
        ),
        EventSourceCtor: FakeEventSource,
        fetchSummary,
      },
      (session) => {
        sessions.push(session);
      },
    );

    const latest = sessions[sessions.length - 1];
    expect(fetchSummary).not.toHaveBeenCalled();
    expect(latest?.finalOverview.open).toBe(true);
    expect(latest?.completionStats?.fsmDisplayName).toBe('workflow');
  });

  it('auto-fetches summary for terminal bootstrap with null stats without showing a loading modal', async () => {
    const fetchSummary = vi.fn<SummaryFetcher>(() =>
      Promise.resolve({
        completionStats: stats({ transitionCount: 5 }),
      }),
    );
    const sessions: Session[] = [];

    await renderHook(
      {
        fetch: bootstrapFetch(
          bootstrap({
            posture: { isTerminal: true, isAwaiting: false, submittedThisTurn: false, open: false },
            completionStats: null,
          }),
        ),
        EventSourceCtor: FakeEventSource,
        fetchSummary,
      },
      (session) => {
        sessions.push(session);
      },
    );

    const latest = sessions[sessions.length - 1];
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(latest?.connection).toBe('live');
    expect(latest?.completionStats?.transitionCount).toBe(5);
    expect(latest?.finalOverview.open).toBe(true);
    expect(latest?.finalOverview.autoOpened).toBe(true);
    expect(latest?.finalOverview.loading).toBe(false);
  });

  it('fetches summary for live terminal events and ignores non-terminal events', async () => {
    const fetchSummary = vi.fn<SummaryFetcher>(() =>
      Promise.resolve({
        completionStats: stats({ outcome: 'failure' }),
      }),
    );
    const sessions: Session[] = [];

    await renderHook(
      {
        fetch: bootstrapFetch(bootstrap()),
        EventSourceCtor: FakeEventSource,
        fetchSummary,
      },
      (session) => {
        sessions.push(session);
      },
    );

    await act(async () => {
      FakeEventSource.instances[0]?.emit(apiEvent({ type: 'state.changed' }));
      await Promise.resolve();
    });
    expect(fetchSummary).not.toHaveBeenCalled();

    await act(async () => {
      FakeEventSource.instances[0]?.emit(apiEvent({ type: 'run.failed', id: 'run-1:3', seq: 3 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const latest = sessions[sessions.length - 1];
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(latest?.posture.isTerminal).toBe(true);
    expect(latest?.completionStats?.outcome).toBe('failure');
    expect(latest?.finalOverview.open).toBe(true);
  });

  it('fetches summary for live cancellation events', async () => {
    const fetchSummary = vi.fn<SummaryFetcher>(() =>
      Promise.resolve({
        completionStats: stats({ outcome: 'cancelled' }),
      }),
    );
    const sessions: Session[] = [];

    await renderHook(
      {
        fetch: bootstrapFetch(bootstrap()),
        EventSourceCtor: FakeEventSource,
        fetchSummary,
      },
      (session) => {
        sessions.push(session);
      },
    );

    await act(async () => {
      FakeEventSource.instances[0]?.emit(
        apiEvent({ type: 'run.cancelled', id: 'run-1:3', seq: 3 }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const latest = sessions[sessions.length - 1];
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(latest?.posture.isTerminal).toBe(true);
    expect(latest?.completionStats?.outcome).toBe('cancelled');
  });

  it('keeps automatic summary fetch errors out of connection-lost state and out of the modal', async () => {
    const fetchSummary = vi.fn<SummaryFetcher>(() =>
      Promise.reject(new Error('summary unavailable')),
    );
    const sessions: Session[] = [];

    await renderHook(
      {
        fetch: bootstrapFetch(
          bootstrap({
            posture: { isTerminal: true, isAwaiting: false, submittedThisTurn: false, open: false },
            completionStats: null,
          }),
        ),
        EventSourceCtor: FakeEventSource,
        fetchSummary,
      },
      (session) => {
        sessions.push(session);
      },
    );

    const latest = sessions[sessions.length - 1];
    expect(latest?.connection).toBe('live');
    expect(latest?.posture.isTerminal).toBe(true);
    expect(latest?.finalOverview.open).toBe(false);
    expect(latest?.finalOverview.loading).toBe(false);
    expect(latest?.finalOverview.error).toBe('summary unavailable');
  });
});
