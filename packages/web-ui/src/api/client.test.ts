import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  fetchBootstrap,
  fetchRecentRows,
  fetchVisitRows,
  postReply,
  readBootMode,
  readBootRunId,
  resyncAndReconnect,
  retainStateAfterReplyFailure,
  subscribeToEvents,
  type EventSourceLike,
  type FetchLike,
  type StreamMessageEvent,
} from './client.js';
import type {
  RunScopedApiEvent,
  RunScopedBootstrap,
  RunScopedRowPage,
  RunScopedResyncRequired,
} from '../types/events.js';
import {
  isRunScopedApiEvent,
  isRunScopedBootstrap,
  isRunScopedEventPage,
  isRunScopedResyncRequired,
  isRunScopedRowPage,
} from '../types/events.js';
import type { UiState } from '../state/store.js';

const UI_TOKEN = 'ui-token';
const RUN_ID = 'run-1';

function bootstrap(overrides: Partial<RunScopedBootstrap> = {}): RunScopedBootstrap {
  return {
    run: {
      runId: RUN_ID,
      threadId: 'thread-1',
      repoRoot: '/repo',
      fsmFile: 'workflow.ts',
      fsmHash6: 'abc123',
      codexPin: 'pin-1',
      startedAt: '2026-05-29T00:00:00.000Z',
    },
    topology: null,
    latestEventId: 'run-1:4',
    currentState: {
      path: 'workflow.collect',
      leaf: 'collect',
      kind: 'stateful',
      exits: [{ name: 'continue', kind: 'submit' }],
      visitCount: 1,
    },
    posture: {
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: true,
    },
    currentStateVisit: {
      id: 'workflow.collect#1',
      path: 'workflow.collect',
      seq: 1,
      time: '2026-05-29T00:00:00.000Z',
      from: null,
      to: 'workflow.collect',
      cause: 'boot',
    },
    stateVisits: [],
    statePathVisits: {},
    pending: [],
    aggregateStats: {
      status: 'running',
      turnCount: 1,
      activeTurnId: 'turn-1',
    },
    recentRows: [],
    diagnostics: [],
    ...overrides,
  };
}

function rowPage(overrides: Partial<RunScopedRowPage> = {}): RunScopedRowPage {
  return {
    rows: [
      {
        id: 'row-1',
        eventId: 'run-1:4',
        seq: 4,
        time: '2026-05-29T00:00:04.000Z',
        type: 'model.delta',
        stateVisitId: 'root.plan#1',
        kind: 'message',
        text: 'hello',
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

function apiEvent(overrides: Partial<RunScopedApiEvent> = {}): RunScopedApiEvent {
  const type = overrides.type ?? 'state.changed';
  return {
    schema: 'aharness.event.v1',
    runId: RUN_ID,
    seq: 4,
    id: 'run-1:4',
    time: '2026-05-29T00:00:04.000Z',
    type,
    data: { row: { kind: 'state_change' } },
    offset: 128,
    lineBytes: 96,
    ...overrides,
  };
}

function resyncFrame(overrides: Partial<RunScopedResyncRequired> = {}): RunScopedResyncRequired {
  return {
    kind: 'RunScopedResyncRequired',
    control: true,
    requestedEventId: 'run-1:99',
    latestEventId: 'run-1:4',
    reason: 'future-event-cursor',
    ...overrides,
  };
}

function okJson(value: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
  });
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, (event: StreamMessageEvent) => void>();
  onerror: ((event: ErrorEvent) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: StreamMessageEvent) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  emit(type: string, data: unknown, lastEventId?: string): void {
    const event: StreamMessageEvent = { data: JSON.stringify(data) };
    if (lastEventId !== undefined) {
      event.lastEventId = lastEventId;
    }
    this.listeners.get(type)?.(event);
  }

  emitRaw(type: string, data: string): void {
    this.listeners.get(type)?.({ data });
  }

  emitError(): void {
    this.onerror?.({} as ErrorEvent);
  }
}

describe('run-scoped API client', () => {
  it('keeps Task 2 row-page guard coverage for valid and malformed compact rows', () => {
    expect(isRunScopedRowPage(rowPage())).toBe(true);
    expect(isRunScopedRowPage({ rows: {}, nextCursor: null })).toBe(false);
  });

  it('keeps Task 2 API event-page guard coverage for canonical ids and raw rejection', () => {
    const event = apiEvent();

    expect(isRunScopedApiEvent(event)).toBe(true);
    expect(isRunScopedEventPage({ events: [event], nextCursor: 'run-1:4', diagnostics: [] })).toBe(
      true,
    );
    expect(isRunScopedApiEvent({ ...event, id: 1 })).toBe(false);
    expect(isRunScopedApiEvent({ ...event, raw: { secret: true } })).toBe(false);
  });

  it('keeps Task 2 resync guard coverage for run-scoped control frames', () => {
    expect(isRunScopedResyncRequired(resyncFrame())).toBe(true);
    expect(
      isRunScopedResyncRequired({
        kind: 'ResyncRequired',
        requestedLastEventId: '4',
      }),
    ).toBe(false);
  });

  it('reads boot run id and inspect mode from URL search params', () => {
    expect(readBootRunId('?token=t&runId=run%2Fencoded&mode=inspect')).toBe('run/encoded');
    expect(readBootMode('?token=t&runId=run-1&mode=inspect')).toBe('inspect');
    expect(readBootMode('?token=t&runId=run-1')).toBe('run');
    expect(() => readBootRunId('?token=t')).toThrow(ApiClientError);
  });

  it('fetchBootstrap GETs the encoded run-scoped bootstrap URL with header token auth', async () => {
    const fetch = vi.fn<FetchLike>(() => okJson(bootstrap({ run: { runId: 'run/one' } })));

    await expect(
      fetchBootstrap({ runId: 'run/one', fetch, uiToken: UI_TOKEN }),
    ).resolves.toMatchObject({ run: { runId: 'run/one' }, latestEventId: 'run-1:4' });
    expect(fetch).toHaveBeenCalledWith('/api/runs/run%2Fone/bootstrap', {
      headers: { 'X-Aharness-Ui-Token': UI_TOKEN },
    });
  });

  it('fetchBootstrap rejects malformed bootstrap JSON with a typed client error', async () => {
    const fetch = vi.fn<FetchLike>(() => okJson({ latestEventId: 'run-1:4' }));

    await expect(
      fetchBootstrap({ runId: RUN_ID, fetch, uiToken: UI_TOKEN }),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetch).toHaveBeenCalledWith('/api/runs/run-1/bootstrap', {
      headers: { 'X-Aharness-Ui-Token': UI_TOKEN },
    });
  });

  it('validates API-safe aggregate stats while accepting explicit zero values', () => {
    expect(
      isRunScopedBootstrap(
        bootstrap({
          aggregateStats: {
            turnCount: 0,
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            modelContextWindow: 0,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isRunScopedBootstrap(
        bootstrap({
          aggregateStats: {
            turnCount: 0,
            totalTokens: Number.NaN,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isRunScopedBootstrap(
        bootstrap({
          aggregateStats: {
            turnCount: 0,
            raw: { totalTokens: 999 },
          } as unknown as RunScopedBootstrap['aggregateStats'],
        }),
      ),
    ).toBe(false);
  });

  it('fetchBootstrap wraps malformed JSON parse failures as ApiClientError', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not json')),
      }),
    );

    await expect(fetchBootstrap({ runId: RUN_ID, fetch, uiToken: UI_TOKEN })).rejects.toThrow(
      /Malformed JSON response/,
    );
  });

  it('fetchVisitRows keeps # in visit ids as encoded path data and validates row pages', async () => {
    const fetch = vi.fn<FetchLike>(() => okJson(rowPage()));

    await expect(
      fetchVisitRows({
        runId: RUN_ID,
        visitId: 'root.plan#1',
        cursor: 'run-1:4',
        limit: 25,
        fetch,
        uiToken: UI_TOKEN,
      }),
    ).resolves.toMatchObject({ rows: [expect.objectContaining({ stateVisitId: 'root.plan#1' })] });
    expect(fetch).toHaveBeenCalledWith(
      '/api/runs/run-1/visits/root.plan%231/rows?cursor=run-1%3A4&limit=25',
      { headers: { 'X-Aharness-Ui-Token': UI_TOKEN } },
    );
  });

  it('fetchRecentRows GETs recent compact rows with optional cursor and limit', async () => {
    const fetch = vi.fn<FetchLike>(() => okJson(rowPage({ nextCursor: 'run-1:9' })));

    await expect(
      fetchRecentRows({
        runId: 'run/two',
        cursor: 'run/two:4',
        limit: 10,
        fetch,
        uiToken: UI_TOKEN,
      }),
    ).resolves.toMatchObject({ nextCursor: 'run-1:9' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/runs/run%2Ftwo/rows/recent?cursor=run%2Ftwo%3A4&limit=10',
      { headers: { 'X-Aharness-Ui-Token': UI_TOKEN } },
    );
  });

  it('subscribeToEvents opens the run-scoped stream and dispatches canonical run events', () => {
    const onRunEvent = vi.fn();

    subscribeToEvents({
      runId: 'run/one',
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      afterEventId: 'run/one:4',
      onRunEvent,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    expect(FakeEventSource.instances.at(-1)?.url).toBe(
      '/api/runs/run%2Fone/stream?token=ui-token&after=run%2Fone%3A4',
    );
    FakeEventSource.instances
      .at(-1)
      ?.emit(
        'state.changed',
        apiEvent({ runId: 'run/one', id: 'run/one:5', type: 'state.changed' }),
        'run/one:5',
      );

    expect(onRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run/one:5', type: 'state.changed' }),
    );
  });

  it('uses canonical event id equality for setup-race dedupe without decimal parsing', () => {
    const onRunEvent = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      afterEventId: 'run-1:4',
      onRunEvent,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    const source = FakeEventSource.instances.at(-1);
    source?.emit('model.delta', apiEvent({ type: 'model.delta', id: 'run-1:4' }), 'run-1:4');
    source?.emit('model.delta', apiEvent({ type: 'model.delta', id: 'run-1:5' }), 'run-1:5');

    expect(onRunEvent).toHaveBeenCalledTimes(1);
    expect(onRunEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1:5' }));
  });

  it('handles fallback runEvent payloads for unsafe canonical event names', () => {
    const onRunEvent = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      onRunEvent,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances
      .at(-1)
      ?.emit('runEvent', apiEvent({ type: 'subthread/worker-started', id: 'run-1:6', seq: 6 }));

    expect(onRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subthread/worker-started', id: 'run-1:6' }),
    );
  });

  it('dispatches exact safe subthread event names without relying on fallback', () => {
    const onRunEvent = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      onRunEvent,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances
      .at(-1)
      ?.emit(
        'subthread.item.started',
        apiEvent({ type: 'subthread.item.started', id: 'run-1:7', seq: 7 }),
      );

    expect(onRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subthread.item.started', id: 'run-1:7' }),
    );
  });

  it('invokes onResyncRequired for run-scoped resync control frames', async () => {
    const onResyncRequired = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      onRunEvent: vi.fn(),
      onResyncRequired,
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances.at(-1)?.emit('runEvent.resyncRequired', resyncFrame(), 'run-1:4');
    await vi.waitFor(() => expect(onResyncRequired).toHaveBeenCalledOnce());
    expect(onResyncRequired).toHaveBeenCalledWith(
      expect.objectContaining({ requestedEventId: 'run-1:99', latestEventId: 'run-1:4' }),
    );
  });

  it('closes the current stream, refetches bootstrap, hydrates, then reopens after resync', async () => {
    const calls: string[] = [];
    const reopen = vi.fn(() => calls.push('reopen'));

    await resyncAndReconnect({
      closeCurrent: () => calls.push('close'),
      fetchBootstrap: () => {
        calls.push('fetch');
        return Promise.resolve(bootstrap({ latestEventId: 'run-1:9' }));
      },
      hydrate: (next) => calls.push(`hydrate:${next.latestEventId}`),
      reopen,
    });

    expect(calls).toEqual(['close', 'fetch', 'hydrate:run-1:9', 'reopen']);
    expect(reopen).toHaveBeenCalledWith('run-1:9');
  });

  it('marks connection lost on stream JSON parse failures or malformed run events', () => {
    const onConnectionLost = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      onRunEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onConnectionLost,
    });

    const source = FakeEventSource.instances.at(-1);
    source?.emitRaw('state.changed', '{');
    source?.emit('state.changed', { kind: 'StateChange' });

    expect(onConnectionLost).toHaveBeenCalledTimes(2);
  });

  it('marks connection lost on EventSource errors without closing solely because onerror fired', () => {
    const onConnectionLost = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      onRunEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onConnectionLost,
    });

    const source = FakeEventSource.instances.at(-1);
    source?.emitError();

    expect(onConnectionLost).toHaveBeenCalledOnce();
    expect(source?.close).not.toHaveBeenCalled();
  });

  it('signals the connection live when a valid run event arrives after an error', () => {
    const onConnectionLost = vi.fn();
    const onConnectionLive = vi.fn();

    subscribeToEvents({
      runId: RUN_ID,
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      onRunEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onConnectionLost,
      onConnectionLive,
    });

    const source = FakeEventSource.instances.at(-1);
    source?.emitError();
    source?.emit('posture.changed', apiEvent({ type: 'posture.changed' }));

    expect(onConnectionLost).toHaveBeenCalledOnce();
    expect(onConnectionLive).toHaveBeenCalledOnce();
  });

  it.each([
    [{ kind: 'user-prompt' as const, text: 'continue' }],
    [
      {
        kind: 'owner-input' as const,
        requestId: 'owner-1',
        answers: { q1: 'continue' },
      },
    ],
  ])('postReply POSTs accepted reply payloads to the run-scoped reply URL', async (payload) => {
    const fetch = vi.fn<FetchLike>(() => okJson({ ok: true }));

    await expect(
      postReply(payload, { runId: 'run/one', fetch, uiToken: UI_TOKEN }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('/api/runs/run%2Fone/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': UI_TOKEN },
      body: JSON.stringify(payload),
    });
  });

  it('postReply rejects non-2xx server responses and keeps pending state retention behavior separate', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: () => Promise.resolve({ error: 'reply rejected' }),
      }),
    );
    const state = { replyError: null } as UiState;

    await expect(
      postReply(
        { kind: 'user-prompt', text: 'continue' },
        { runId: RUN_ID, fetch, uiToken: UI_TOKEN },
      ),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetch).toHaveBeenCalledWith('/api/runs/run-1/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });
    expect(retainStateAfterReplyFailure(state)).toBe(state);
  });

  it('does not retain production references to the flat browser endpoints', () => {
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('/api/state');
    expect(source).not.toContain('/api/stream');
    expect(source).not.toContain('/api/reply');
  });
});
