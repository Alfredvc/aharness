import type { AppEvent, UiSnapshot } from '../types/events.js';
import type { ReplyPayload, UiState } from '../state/store.js';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
}>;

export type StreamMessageEvent = {
  data: string;
  lastEventId?: string;
};

export type EventSourceLike = {
  addEventListener: (type: string, listener: (event: StreamMessageEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: StreamMessageEvent) => void) => void;
  close: () => void;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type EventSourceConstructorLike = new (url: string) => EventSourceLike;

export type SubscribeOptions = {
  uiToken: string;
  EventSourceCtor?: EventSourceConstructorLike;
  skipThroughEventId?: string | null;
  dispatch: (event: AppEvent) => void;
  onResyncRequired: (event: Extract<AppEvent, { kind: 'ResyncRequired' }>) => void | Promise<void>;
  onConnectionLost: () => void;
  onConnectionLive?: () => void;
};

export type ResyncOptions = {
  closeCurrent: () => void;
  fetchSnapshot: () => Promise<UiSnapshot>;
  hydrate: (snapshot: UiSnapshot) => void;
  reopen: (skipThroughEventId: string | null) => void;
};

const STREAM_EVENT_TYPES = [
  'AgentMessageDelta',
  'ItemStarted',
  'TurnStarted',
  'ServerRequest',
  'OwnerInputResolved',
  'FileApprovalUpdated',
  'ApprovalRequestResolved',
  'StateChange',
  'FreshClearBoundary',
  'AbandonedThreadDiagnostic',
  'FrameworkNote',
  'TurnCompleted',
  'PostureChange',
  'ResyncRequired',
] as const satisfies ReadonlyArray<AppEvent['kind']>;

function parseEventId(eventId: string | null | undefined): number | null {
  if (eventId === undefined || eventId === null || !/^[1-9]\d*$/.test(eventId)) {
    return null;
  }

  const parsed = Number(eventId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function shouldSkipReplayedEvent(
  lastEventId: string | undefined,
  skipThroughEventId: string | null | undefined,
): boolean {
  const eventId = parseEventId(lastEventId);
  const skipThrough = parseEventId(skipThroughEventId);
  return eventId !== null && skipThrough !== null && eventId <= skipThrough;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUiSnapshot(value: unknown): value is UiSnapshot {
  if (!isRecord(value)) return false;
  if (!(typeof value['latestEventId'] === 'string' || value['latestEventId'] === null)) {
    return false;
  }
  if (!isRecord(value['state'])) return false;
  const state = value['state'];
  return (
    (isRecord(state['run']) || state['run'] === null) &&
    isRecord(state['posture']) &&
    (isRecord(state['currentState']) || state['currentState'] === null) &&
    Array.isArray(state['transcript']) &&
    Array.isArray(state['frameworkNotes']) &&
    Array.isArray(state['diagnostics']) &&
    Array.isArray(state['completedTurns']) &&
    (state['pending'] === undefined || isRecord(state['pending']))
  );
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    throw new ApiClientError('fetch is unavailable in this environment');
  }
  return globalThis.fetch;
}

function defaultEventSourceCtor(): EventSourceConstructorLike {
  if (typeof globalThis.EventSource !== 'function') {
    throw new ApiClientError('EventSource is unavailable in this environment');
  }
  return globalThis.EventSource;
}

async function readJson(response: Awaited<ReturnType<FetchLike>>): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ApiClientError(
      error instanceof Error
        ? `Malformed JSON response: ${error.message}`
        : 'Malformed JSON response',
      response.status,
    );
  }
}

export async function fetchSnapshot(options: {
  uiToken: string;
  fetch?: FetchLike;
}): Promise<UiSnapshot> {
  if (!('uiToken' in options) || typeof options.uiToken !== 'string' || options.uiToken === '') {
    throw new ApiClientError('UI token is unavailable');
  }
  const fetch = options.fetch ?? defaultFetch();
  const response = await fetch('/api/state', {
    headers: { 'X-Aharness-Ui-Token': options.uiToken },
  });
  if (!response.ok) {
    throw new ApiClientError(
      `GET /api/state failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      response.status,
    );
  }
  const json = await readJson(response);
  if (!isUiSnapshot(json)) {
    throw new ApiClientError('GET /api/state returned a malformed UiSnapshot', response.status);
  }
  return json;
}

export function subscribeToEvents(options: SubscribeOptions): () => void {
  const EventSourceCtor = options.EventSourceCtor ?? defaultEventSourceCtor();
  const source = new EventSourceCtor(streamUrl(options.uiToken, options.skipThroughEventId));
  const listeners = new Map<string, (event: StreamMessageEvent) => void>();
  let closed = false;

  for (const type of STREAM_EVENT_TYPES) {
    const listener = (message: StreamMessageEvent) => {
      try {
        if (shouldSkipReplayedEvent(message.lastEventId, options.skipThroughEventId)) {
          return;
        }
        const event = JSON.parse(message.data) as AppEvent;
        if (!isRecord(event) || event.kind !== type) {
          throw new ApiClientError(`SSE ${type} payload kind mismatch`);
        }
        if (event.kind === 'ResyncRequired') {
          void Promise.resolve(options.onResyncRequired(event)).catch(() => {
            if (!closed) options.onConnectionLost();
          });
          return;
        }
        options.onConnectionLive?.();
        options.dispatch(event);
      } catch {
        if (!closed) options.onConnectionLost();
      }
    };
    listeners.set(type, listener);
    source.addEventListener(type, listener);
  }

  source.onerror = () => {
    if (!closed) options.onConnectionLost();
  };

  return () => {
    closed = true;
    for (const [type, listener] of listeners) {
      source.removeEventListener(type, listener);
    }
    source.onerror = null;
    source.close();
  };
}

export async function resyncAndReconnect(options: ResyncOptions): Promise<void> {
  options.closeCurrent();
  const snapshot = await options.fetchSnapshot();
  options.hydrate(snapshot);
  options.reopen(snapshot.latestEventId);
}

export async function postReply(
  payload: ReplyPayload,
  options: { uiToken: string; fetch?: FetchLike },
): Promise<void> {
  const fetch = options.fetch ?? defaultFetch();
  const response = await fetch('/api/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': options.uiToken },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new ApiClientError(
      `POST /api/reply failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      response.status,
    );
  }
}

function streamUrl(uiToken: string, skipThroughEventId: string | null | undefined): string {
  const params = new URLSearchParams({ token: uiToken });
  if (skipThroughEventId !== undefined && skipThroughEventId !== null) {
    params.set('after', skipThroughEventId);
  }
  return `/api/stream?${params.toString()}`;
}

export function retainStateAfterReplyFailure(state: UiState): UiState {
  return state;
}
