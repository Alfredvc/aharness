import {
  isRunScopedApiEvent,
  isRunScopedBootstrap,
  isRunScopedResyncRequired,
  isRunScopedRowPage,
  type RunScopedApiEvent,
  type RunScopedBootstrap,
  type RunScopedResyncRequired,
  type RunScopedRowPage,
  type UiMode,
} from '../types/events.js';
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
  runId: string;
  uiToken: string;
  EventSourceCtor?: EventSourceConstructorLike;
  afterEventId?: string | null;
  onRunEvent: (event: RunScopedApiEvent) => void;
  onResyncRequired: (event: RunScopedResyncRequired) => void | Promise<void>;
  onConnectionLost: () => void;
  onConnectionLive?: () => void;
};

export type ResyncOptions = {
  closeCurrent: () => void;
  fetchBootstrap: () => Promise<RunScopedBootstrap>;
  hydrate: (bootstrap: RunScopedBootstrap) => void;
  reopen: (afterEventId: string | null) => void;
};

const RUN_EVENT_TYPES = [
  'run.started',
  'run.completed',
  'run.failed',
  'state.changed',
  'context.initialized',
  'context.changed',
  'posture.changed',
  'turn.started',
  'turn.completed',
  'model.delta',
  'item.started',
  'item.completed',
  'raw_response_item.completed',
  'request.created',
  'request.updated',
  'request.resolved',
  'reply.submitted',
  'reply.resolved',
  'framework.note',
  'fresh_clear.boundary',
  'diagnostic.abandoned_thread',
  'token.updated',
  'subthread.turn.started',
  'subthread.turn.completed',
  'subthread.item.started',
  'subthread.item.completed',
  'subthread.token.updated',
  'artifact.written',
  'submit.recorded',
  'transition.recorded',
  'hook.observed',
  'runEvent',
  'runEvent.resyncRequired',
] as const;

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

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiClientError(`${label} is unavailable`);
  }
  return value;
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

export function readBootRunId(
  search = typeof window === 'undefined' ? '' : window.location.search,
): string {
  const runId = new URLSearchParams(search).get('runId');
  if (!runId) {
    throw new ApiClientError('runId is unavailable');
  }
  return runId;
}

export function readBootMode(
  search = typeof window === 'undefined' ? '' : window.location.search,
): UiMode {
  return new URLSearchParams(search).get('mode') === 'inspect' ? 'inspect' : 'run';
}

export async function fetchBootstrap(options: {
  runId: string;
  uiToken: string;
  fetch?: FetchLike;
}): Promise<RunScopedBootstrap> {
  const runId = requireNonEmpty(options.runId, 'runId');
  const uiToken = requireNonEmpty(options.uiToken, 'UI token');
  const fetch = options.fetch ?? defaultFetch();
  const url = runPath(runId, 'bootstrap');
  const response = await fetch(url, {
    headers: { 'X-Aharness-Ui-Token': uiToken },
  });
  if (!response.ok) {
    throw new ApiClientError(
      `GET ${url} failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      response.status,
    );
  }
  const json = await readJson(response);
  if (!isRunScopedBootstrap(json)) {
    throw new ApiClientError(`GET ${url} returned a malformed RunScopedBootstrap`, response.status);
  }
  return json;
}

export async function fetchVisitRows(options: {
  runId: string;
  visitId: string;
  uiToken: string;
  cursor?: string | null;
  limit?: number;
  fetch?: FetchLike;
}): Promise<RunScopedRowPage> {
  const runId = requireNonEmpty(options.runId, 'runId');
  const visitId = requireNonEmpty(options.visitId, 'visitId');
  const uiToken = requireNonEmpty(options.uiToken, 'UI token');
  const fetch = options.fetch ?? defaultFetch();
  const url = withRowQuery(
    `/api/runs/${encodeURIComponent(runId)}/visits/${encodeURIComponent(visitId)}/rows`,
    options,
  );
  const response = await fetch(url, {
    headers: { 'X-Aharness-Ui-Token': uiToken },
  });
  if (!response.ok) {
    throw new ApiClientError(
      `GET ${url} failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      response.status,
    );
  }
  const json = await readJson(response);
  if (!isRunScopedRowPage(json)) {
    throw new ApiClientError(`GET ${url} returned malformed run-scoped rows`, response.status);
  }
  return json;
}

export async function fetchRecentRows(options: {
  runId: string;
  uiToken: string;
  cursor?: string | null;
  limit?: number;
  fetch?: FetchLike;
}): Promise<RunScopedRowPage> {
  const runId = requireNonEmpty(options.runId, 'runId');
  const uiToken = requireNonEmpty(options.uiToken, 'UI token');
  const fetch = options.fetch ?? defaultFetch();
  const url = withRowQuery(`/api/runs/${encodeURIComponent(runId)}/rows/recent`, options);
  const response = await fetch(url, {
    headers: { 'X-Aharness-Ui-Token': uiToken },
  });
  if (!response.ok) {
    throw new ApiClientError(
      `GET ${url} failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      response.status,
    );
  }
  const json = await readJson(response);
  if (!isRunScopedRowPage(json)) {
    throw new ApiClientError(`GET ${url} returned malformed recent rows`, response.status);
  }
  return json;
}

export function subscribeToEvents(options: SubscribeOptions): () => void {
  const runId = requireNonEmpty(options.runId, 'runId');
  const uiToken = requireNonEmpty(options.uiToken, 'UI token');
  const EventSourceCtor = options.EventSourceCtor ?? defaultEventSourceCtor();
  const source = new EventSourceCtor(streamUrl(runId, uiToken, options.afterEventId));
  const listeners = new Map<string, (event: StreamMessageEvent) => void>();
  let closed = false;

  for (const type of RUN_EVENT_TYPES) {
    const listener = (message: StreamMessageEvent) => {
      try {
        if (message.lastEventId !== undefined && message.lastEventId === options.afterEventId) {
          return;
        }
        const event = parseStreamPayload(type, message.data);
        if (isRunScopedResyncRequired(event)) {
          void Promise.resolve(options.onResyncRequired(event)).catch(() => {
            if (!closed) options.onConnectionLost();
          });
          return;
        }
        options.onConnectionLive?.();
        options.onRunEvent(event);
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
  const bootstrap = await options.fetchBootstrap();
  options.hydrate(bootstrap);
  options.reopen(bootstrap.latestEventId);
}

export async function postReply(
  payload: ReplyPayload,
  options: { runId: string; uiToken: string; fetch?: FetchLike },
): Promise<void> {
  const runId = requireNonEmpty(options.runId, 'runId');
  const uiToken = requireNonEmpty(options.uiToken, 'UI token');
  const fetch = options.fetch ?? defaultFetch();
  const url = runPath(runId, 'reply');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': uiToken },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new ApiClientError(
      `POST ${url} failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      response.status,
    );
  }
}

function parseStreamPayload(
  listenerType: (typeof RUN_EVENT_TYPES)[number],
  data: string,
): RunScopedApiEvent | RunScopedResyncRequired {
  const parsed = JSON.parse(data) as unknown;
  if (listenerType === 'runEvent.resyncRequired') {
    if (!isRunScopedResyncRequired(parsed)) {
      throw new ApiClientError('SSE resync payload was malformed');
    }
    return parsed;
  }
  if (!isRunScopedApiEvent(parsed)) {
    throw new ApiClientError('SSE run event payload was malformed');
  }
  if (listenerType !== 'runEvent' && parsed.type !== listenerType) {
    throw new ApiClientError(`SSE ${listenerType} payload type mismatch`);
  }
  return parsed;
}

function runPath(runId: string, leaf: 'bootstrap' | 'reply'): string {
  return `/api/runs/${encodeURIComponent(runId)}/${leaf}`;
}

function streamUrl(
  runId: string,
  uiToken: string,
  afterEventId: string | null | undefined,
): string {
  const params = new URLSearchParams({ token: uiToken });
  if (afterEventId !== undefined && afterEventId !== null) {
    params.set('after', afterEventId);
  }
  return `/api/runs/${encodeURIComponent(runId)}/stream?${params.toString()}`;
}

function withRowQuery(path: string, options: { cursor?: string | null; limit?: number }): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined && options.cursor !== null) {
    params.set('cursor', options.cursor);
  }
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

export function retainStateAfterReplyFailure(state: UiState): UiState {
  return state;
}
