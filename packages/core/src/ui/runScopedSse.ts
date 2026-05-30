import type http from 'node:http';

export const RUN_SCOPED_SSE_FALLBACK_EVENT_NAME = 'runEvent';
export const RUN_SCOPED_SSE_RESYNC_EVENT_NAME = 'runEvent.resyncRequired';

export type RunScopedSseResyncReason =
  | 'invalid-event-cursor'
  | 'wrong-run-event-cursor'
  | 'future-event-cursor'
  | 'run-event-log-unavailable';

export interface RunScopedSseResyncControlFrame {
  readonly kind: 'RunScopedResyncRequired';
  readonly control: true;
  readonly requestedEventId: string | null;
  readonly latestEventId: string | null;
  readonly reason: RunScopedSseResyncReason;
}

export interface RunScopedSseEvent {
  readonly schema: string;
  readonly runId: string;
  readonly seq: number;
  readonly id: string;
  readonly time: string;
  readonly type: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly stateVisitId?: string;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly offset: number;
  readonly lineBytes: number;
}

export type RunScopedSseEventsAfterResult =
  | { readonly ok: true; readonly events: ReadonlyArray<RunScopedSseEvent> }
  | {
      readonly ok: false;
      readonly error: 'invalid-event-cursor';
    }
  | {
      readonly ok: false;
      readonly error: 'event-cursor-out-of-range';
      readonly latestEventId: string | null;
    }
  | {
      readonly ok: false;
      readonly error: 'run-event-log-unavailable';
      readonly diagnostics: ReadonlyArray<unknown>;
    };

export interface RunScopedSseQueryService {
  readonly runId: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getLatestEventId: () => string | null;
  readonly eventsAfter: (
    afterEventId?: string | null,
    options?: { readonly pageLimit?: number },
  ) => RunScopedSseEventsAfterResult;
}

export type RunScopedSseWrite = (frame: string) => void;

export interface DrainRunScopedSseEventsOptions {
  readonly queryService: RunScopedSseQueryService;
  readonly afterEventId: string | null;
  readonly write: RunScopedSseWrite;
  readonly pageLimit?: number;
}

export interface DrainRunScopedSseEventsResult {
  readonly lastSentId: string | null;
  readonly framesWritten: number;
  readonly resync: RunScopedSseResyncControlFrame | null;
}

export interface StreamRunScopedSseEventsOptions {
  readonly queryService: RunScopedSseQueryService;
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly url: URL;
  readonly activeStreams?: Set<() => void>;
  readonly pageLimit?: number;
}

const SAFE_EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

export function safeRunScopedSseEventName(eventType: string): string {
  return SAFE_EVENT_NAME_PATTERN.test(eventType) ? eventType : RUN_SCOPED_SSE_FALLBACK_EVENT_NAME;
}

export function serializeRunScopedSseEvent(event: RunScopedSseEvent): string {
  return serializeRunScopedSseFrame({
    id: event.id,
    eventName: safeRunScopedSseEventName(event.type),
    data: event,
  });
}

export function serializeRunScopedSseResyncControlFrame(
  frame: RunScopedSseResyncControlFrame,
): string {
  return serializeRunScopedSseFrame({
    id: frame.latestEventId,
    eventName: RUN_SCOPED_SSE_RESYNC_EVENT_NAME,
    data: frame,
  });
}

export function readRunScopedSseCursor(request: http.IncomingMessage, url: URL): string | null {
  return readLastEventId(request) ?? url.searchParams.get('after');
}

export function drainRunScopedSseEvents(
  options: DrainRunScopedSseEventsOptions,
): DrainRunScopedSseEventsResult {
  const parsedCursor = parseRunScopedSseCursor(options.queryService.runId, options.afterEventId);
  if (!parsedCursor.ok) {
    return writeResyncFrame({
      queryService: options.queryService,
      requestedEventId: parsedCursor.requestedEventId,
      reason: parsedCursor.reason,
      write: options.write,
    });
  }

  const drainResult = options.queryService.eventsAfter(parsedCursor.afterEventId, {
    ...(options.pageLimit !== undefined ? { pageLimit: options.pageLimit } : {}),
  });
  if (!drainResult.ok) {
    if (drainResult.error === 'event-cursor-out-of-range') {
      return writeResyncFrame({
        latestEventId: drainResult.latestEventId,
        queryService: options.queryService,
        requestedEventId: options.afterEventId,
        reason: 'future-event-cursor',
        write: options.write,
      });
    }

    return writeResyncFrame({
      queryService: options.queryService,
      requestedEventId: options.afterEventId,
      reason:
        drainResult.error === 'run-event-log-unavailable'
          ? 'run-event-log-unavailable'
          : 'invalid-event-cursor',
      write: options.write,
    });
  }

  let lastSentId = parsedCursor.afterEventId;
  let framesWritten = 0;
  for (const event of drainResult.events) {
    options.write(serializeRunScopedSseEvent(event));
    lastSentId = event.id;
    framesWritten += 1;
  }

  return { lastSentId, framesWritten, resync: null };
}

export function streamRunScopedSseEvents(options: StreamRunScopedSseEventsOptions): () => void {
  options.response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  });
  options.response.flushHeaders();

  let lastSentId = readRunScopedSseCursor(options.request, options.url);
  let closed = false;

  const writePendingEvents = () => {
    if (closed) return;

    const result = drainRunScopedSseEvents({
      queryService: options.queryService,
      afterEventId: lastSentId,
      write: (frame) => {
        options.response.write(frame);
      },
      ...(options.pageLimit !== undefined ? { pageLimit: options.pageLimit } : {}),
    });
    lastSentId = result.lastSentId;
  };

  const unsubscribe = options.queryService.subscribe(writePendingEvents);
  const cleanup = () => {
    if (closed) return;

    closed = true;
    unsubscribe();
    options.request.off('close', cleanup);
    options.activeStreams?.delete(cleanup);
    if (!options.response.destroyed && !options.response.writableEnded) {
      options.response.end();
    }
  };

  options.activeStreams?.add(cleanup);
  options.request.on('close', cleanup);
  writePendingEvents();

  return cleanup;
}

function serializeRunScopedSseFrame(options: {
  readonly id: string | null;
  readonly eventName: string;
  readonly data: unknown;
}): string {
  const fields = [
    ...(options.id === null ? [] : [`id: ${options.id}`]),
    `event: ${options.eventName}`,
    ...JSON.stringify(options.data, null, 2)
      .split('\n')
      .map((line) => `data: ${line}`),
    '',
    '',
  ];
  return fields.join('\n');
}

function readLastEventId(request: http.IncomingMessage): string | null {
  const header = request.headers['last-event-id'];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }

  return header ?? null;
}

function parseRunScopedSseCursor(
  runId: string,
  eventId: string | null,
):
  | { readonly ok: true; readonly afterEventId: string | null }
  | {
      readonly ok: false;
      readonly requestedEventId: string;
      readonly reason: 'invalid-event-cursor' | 'wrong-run-event-cursor';
    } {
  if (eventId === null) {
    return { ok: true, afterEventId: null };
  }

  const separatorIndex = eventId.lastIndexOf(':');
  const seqText = separatorIndex === -1 ? eventId : eventId.slice(separatorIndex + 1);
  if (!isPositiveSafeIntegerText(seqText)) {
    return { ok: false, requestedEventId: eventId, reason: 'invalid-event-cursor' };
  }

  const expectedPrefix = `${runId}:`;
  if (!eventId.startsWith(expectedPrefix)) {
    return { ok: false, requestedEventId: eventId, reason: 'wrong-run-event-cursor' };
  }

  return { ok: true, afterEventId: eventId };
}

function isPositiveSafeIntegerText(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) {
    return false;
  }

  return Number.isSafeInteger(Number(value));
}

function writeResyncFrame(options: {
  readonly queryService: RunScopedSseQueryService;
  readonly requestedEventId: string | null;
  readonly reason: RunScopedSseResyncReason;
  readonly write: RunScopedSseWrite;
  readonly latestEventId?: string | null;
}): DrainRunScopedSseEventsResult {
  const latestEventId = options.latestEventId ?? options.queryService.getLatestEventId();
  const resync: RunScopedSseResyncControlFrame = {
    kind: 'RunScopedResyncRequired',
    control: true,
    requestedEventId: options.requestedEventId,
    latestEventId,
    reason: options.reason,
  };

  options.write(serializeRunScopedSseResyncControlFrame(resync));
  return { lastSentId: latestEventId, framesWritten: 1, resync };
}
