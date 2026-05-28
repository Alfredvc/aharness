import { describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  fetchSnapshot,
  postReply,
  resyncAndReconnect,
  retainStateAfterReplyFailure,
  subscribeToEvents,
  type EventSourceLike,
  type FetchLike,
  type StreamMessageEvent,
} from './client.js';
import { applyAppEvent, createConnectingUiState, hydrateFromSnapshot } from '../state/store.js';
import type { AppEvent, FsmState, Posture, UiSnapshot } from '../types/events.js';

const posture: Posture = {
  isTerminal: false,
  isAwaiting: false,
  submittedThisTurn: false,
  open: true,
};

const currentState: FsmState = {
  path: 'workflow.collect',
  leaf: 'collect',
  kind: 'stateful',
  exits: [{ name: 'continue', kind: 'submit' }],
  visitCount: 1,
};

const nextState: FsmState = {
  path: 'workflow.review',
  leaf: 'review',
  kind: 'stateful',
  exits: [{ name: 'approve', kind: 'submit' }],
  visitCount: 1,
};
const UI_TOKEN = 'ui-token';

function snapshot(overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    latestEventId: 'event-1',
    state: {
      run: {
        runId: 'run-1',
        threadId: 'thread-1',
        repoRoot: '/repo',
        fsmFile: 'workflow.ts',
        fsmHash6: 'abc123',
        codexPin: 'pin-1',
        startedAt: '2026-05-13T00:00:00.000Z',
      },
      posture,
      currentState,
      transcript: [],
      frameworkNotes: [],
      diagnostics: [],
      completedTurns: [],
      pending: {
        ownerInput: null,
      },
    },
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

  emit(type: string, data: AppEvent, lastEventId?: string): void {
    const event: StreamMessageEvent = { data: JSON.stringify(data) };
    if (lastEventId !== undefined) {
      event.lastEventId = lastEventId;
    }
    this.listeners.get(type)?.(event);
  }

  emitError(): void {
    this.onerror?.({} as ErrorEvent);
  }
}

describe('production API client', () => {
  it('fetchSnapshot GETs /api/state and validates the minimal UiSnapshot envelope', async () => {
    const fetch = vi.fn<FetchLike>(() => okJson(snapshot()));

    await expect(fetchSnapshot({ fetch, uiToken: UI_TOKEN })).resolves.toEqual(snapshot());
    expect(fetch).toHaveBeenCalledWith('/api/state', {
      headers: { 'X-Aharness-Ui-Token': UI_TOKEN },
    });
  });

  it('fetchSnapshot rejects malformed snapshot JSON with a typed client error', async () => {
    const fetch = vi.fn<FetchLike>(() => okJson({ latestEventId: 'event-1', state: {} }));

    await expect(fetchSnapshot({ fetch, uiToken: UI_TOKEN })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(fetch).toHaveBeenCalledWith('/api/state', {
      headers: { 'X-Aharness-Ui-Token': UI_TOKEN },
    });
  });

  it('subscribeToEvents opens /api/stream and dispatches parsed payloads by SSE event type', () => {
    const dispatch = vi.fn();
    const onResyncRequired = vi.fn();
    const onConnectionLost = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch,
      onResyncRequired,
      onConnectionLost,
    });

    expect(FakeEventSource.instances.at(-1)?.url).toBe('/api/stream?token=ui-token');
    FakeEventSource.instances.at(-1)?.emit('StateChange', {
      kind: 'StateChange',
      from: 'workflow.collect',
      to: 'workflow.review',
      cause: 'submit',
      newState: nextState,
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'StateChange', to: 'workflow.review' }),
    );
  });

  it('subscribeToEvents dispatches owner-input ServerRequest events', () => {
    const dispatch = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances.at(-1)?.emit('ServerRequest', {
      kind: 'ServerRequest',
      id: 'owner-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Next',
          question: 'What now?',
          isOther: false,
          isSecret: false,
        },
      ],
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ServerRequest', id: 'owner-1' }),
    );
  });

  it('subscribeToEvents dispatches OwnerInputResolved events', () => {
    const dispatch = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances.at(-1)?.emit('OwnerInputResolved', {
      kind: 'OwnerInputResolved',
      id: 'owner-1',
    });

    expect(dispatch).toHaveBeenCalledWith({
      kind: 'OwnerInputResolved',
      id: 'owner-1',
    });
  });

  it('skips replayed stream events already covered by the latest /api/state snapshot', () => {
    const dispatch = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      skipThroughEventId: '2',
      dispatch,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    expect(FakeEventSource.instances.at(-1)?.url).toBe('/api/stream?token=ui-token&after=2');
    FakeEventSource.instances.at(-1)?.emit(
      'AgentMessageDelta',
      {
        kind: 'AgentMessageDelta',
        id: 'agent-1',
        delta: 'already snapshotted',
      },
      '2',
    );
    FakeEventSource.instances.at(-1)?.emit(
      'AgentMessageDelta',
      {
        kind: 'AgentMessageDelta',
        id: 'agent-2',
        delta: 'new text',
      },
      '3',
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'AgentMessageDelta', id: 'agent-2' }),
    );
  });

  it('subscribeToEvents dispatches approval update and resolution events', () => {
    const dispatch = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances.at(-1)?.emit('FileApprovalUpdated', {
      kind: 'FileApprovalUpdated',
      id: 'approval-1',
      requestId: 'approval-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      changes: [],
    });
    FakeEventSource.instances.at(-1)?.emit('ApprovalRequestResolved', {
      kind: 'ApprovalRequestResolved',
      id: 'approval-1',
      requestId: 'approval-1',
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FileApprovalUpdated' }));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ApprovalRequestResolved' }),
    );
  });

  it('subscribeToEvents dispatches fresh-clear boundary and abandoned diagnostics', () => {
    const dispatch = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch,
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    FakeEventSource.instances.at(-1)?.emit('FreshClearBoundary', {
      kind: 'FreshClearBoundary',
      id: 'fresh-1',
      reason: 'clearOnEntry',
      previousThreadId: 'thread-old',
      nextThreadId: 'thread-new',
      statePath: 'workflow.review',
    });
    FakeEventSource.instances.at(-1)?.emit('AbandonedThreadDiagnostic', {
      kind: 'AbandonedThreadDiagnostic',
      id: 'diag-1',
      threadId: 'thread-old',
      source: 'turnCompleted',
      message: 'ignored old turn',
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FreshClearBoundary' }));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'AbandonedThreadDiagnostic' }),
    );
  });

  it('subscribeToEvents dispatches connection lost on EventSource error', () => {
    const onConnectionLost = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch: vi.fn(),
      onResyncRequired: vi.fn(),
      onConnectionLost,
    });

    FakeEventSource.instances.at(-1)?.onerror?.({} as ErrorEvent);
    expect(onConnectionLost).toHaveBeenCalledOnce();
  });

  it('does not close the EventSource solely because onerror fired', () => {
    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch: vi.fn(),
      onResyncRequired: vi.fn(),
      onConnectionLost: vi.fn(),
    });

    const source = FakeEventSource.instances.at(-1);
    source?.emitError();

    expect(source?.close).not.toHaveBeenCalled();
  });

  it('signals the connection live when a valid stream event arrives after an error', () => {
    const onConnectionLost = vi.fn();
    const onConnectionLive = vi.fn();

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      dispatch: vi.fn(),
      onResyncRequired: vi.fn(),
      onConnectionLost,
      onConnectionLive,
    });

    const source = FakeEventSource.instances.at(-1);
    source?.emitError();
    source?.emit('PostureChange', {
      kind: 'PostureChange',
      posture: { open: true },
    });

    expect(onConnectionLost).toHaveBeenCalledOnce();
    expect(onConnectionLive).toHaveBeenCalledOnce();
  });

  it('closes the current stream, refetches /api/state, hydrates, then reopens after ResyncRequired', async () => {
    const calls: string[] = [];
    const reopen = vi.fn(() => calls.push('reopen'));

    await resyncAndReconnect({
      closeCurrent: () => calls.push('close'),
      fetchSnapshot: () => {
        calls.push('fetch');
        return Promise.resolve(snapshot({ latestEventId: 'event-2' }));
      },
      hydrate: (next) => calls.push(`hydrate:${next.latestEventId}`),
      reopen,
    });

    expect(calls).toEqual(['close', 'fetch', 'hydrate:event-2', 'reopen']);
    expect(reopen).toHaveBeenCalledWith('event-2');
  });

  it('handles ResyncRequired by closing, hydrating, and reopening with the new skip-through event id', async () => {
    const dispatch = vi.fn();
    const hydrated: UiSnapshot[] = [];
    const closeCurrent = vi.fn();
    const reopen = vi.fn();
    const fetch = vi.fn<FetchLike>(() => okJson(snapshot({ latestEventId: '9' })));
    const fetchState = () => fetchSnapshot({ fetch, uiToken: UI_TOKEN });

    subscribeToEvents({
      uiToken: UI_TOKEN,
      EventSourceCtor: FakeEventSource,
      skipThroughEventId: '4',
      dispatch,
      onConnectionLost: vi.fn(),
      onResyncRequired: () =>
        resyncAndReconnect({
          closeCurrent,
          fetchSnapshot: fetchState,
          hydrate: (next) => hydrated.push(next),
          reopen,
        }),
    });

    FakeEventSource.instances.at(-1)?.emit(
      'ResyncRequired',
      {
        kind: 'ResyncRequired',
        reason: 'event-buffer-overflow',
        requestedLastEventId: '4',
      },
      '12',
    );
    await vi.waitFor(() => expect(hydrated).toHaveLength(1));

    expect(fetch).toHaveBeenCalledWith('/api/state', {
      headers: { 'X-Aharness-Ui-Token': UI_TOKEN },
    });
    expect(closeCurrent).toHaveBeenCalledOnce();
    expect(hydrated).toEqual([expect.objectContaining({ latestEventId: '9' })]);
    expect(reopen).toHaveBeenCalledWith('9');

    FakeEventSource.instances.at(-1)?.emit(
      'AgentMessageDelta',
      {
        kind: 'AgentMessageDelta',
        id: 'agent-replayed',
        delta: 'already covered',
      },
      '4',
    );

    expect(dispatch).not.toHaveBeenCalled();
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
  ])('postReply POSTs accepted reply payloads to /api/reply', async (payload) => {
    const fetch = vi.fn<FetchLike>(() => okJson({ ok: true }));

    await expect(postReply(payload, { fetch, uiToken: UI_TOKEN })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('/api/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': UI_TOKEN },
      body: JSON.stringify(payload),
    });
  });

  it('postReply rejects non-2xx server responses', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: () => Promise.resolve({ error: 'reply rejected' }),
      }),
    );

    await expect(
      postReply({ kind: 'user-prompt', text: 'continue' }, { fetch, uiToken: UI_TOKEN }),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetch).toHaveBeenCalledWith('/api/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });
  });

  it('retains pending approvals, owner input, and open-state draft ownership after reply failure', () => {
    const hydrated = hydrateFromSnapshot(snapshot());
    const withApproval = applyAppEvent(hydrated, {
      kind: 'ServerRequest',
      id: 'approval-1',
      requestId: 'approval-1',
      method: 'item/fileChange/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'call-1',
      changes: [{ path: 'src/file.ts', kind: { type: 'update', move_path: null }, diff: '@@' }],
    });
    const withOwnerInput = applyAppEvent(withApproval, {
      kind: 'ServerRequest',
      id: 'owner-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Next',
          question: 'What now?',
          isOther: false,
          isSecret: false,
        },
      ],
    });

    const retained = retainStateAfterReplyFailure(withOwnerInput);

    expect(retained.pending.fileApprovals).toHaveLength(1);
    expect(retained.pending.ownerInput?.id).toBe('owner-1');
    expect(retained.posture.isAwaiting).toBe(true);
    expect(retained.posture.open).toBe(true);
  });

  it('keeps posture updates independent from connection state', () => {
    const state = createConnectingUiState();
    const lost = applyAppEvent(state, {
      kind: 'PostureChange',
      posture: { open: true },
    });

    expect(lost.posture.open).toBe(true);
  });
});
