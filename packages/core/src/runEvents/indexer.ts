/**
 * Disposable in-memory run-event index.
 *
 * The index is built entirely from replayed canonical events. It stores byte
 * offsets from replay for diagnostic event pages, compact rows derived only
 * from normalized `data.row`, request lifecycle summaries, correlation
 * ranges, state visits, and aggregate stats. It never writes a derived cache
 * or snapshot file; callers can rebuild it from JSONL at any time.
 */
import type {
  RunEventAggregateStats,
  RunEventCompactRow,
  RunEventEnvelope,
  RunEventPage,
  RunEventPendingRequestSummary,
  RunEventRange,
  RunEventRowPage,
  RunEventStateVisit,
  RunEventWithOffset,
} from './types.js';

export interface BuildRunEventIndexOptions {
  readonly events: ReadonlyArray<RunEventWithOffset>;
}

export interface RunEventIndex {
  readonly events: ReadonlyArray<RunEventWithOffset>;
  readonly currentState: RunEventStateVisit | null;
  readonly stateVisits: ReadonlyArray<RunEventStateVisit>;
  readonly aggregateStats: RunEventAggregateStats;
  readonly getEventPage: (query?: EventPageQuery) => RunEventPage;
  readonly getRecentRows: (query?: RowPageQuery) => RunEventRowPage;
  readonly getStateVisitRows: (stateVisitId: string, query?: RowPageQuery) => RunEventRowPage;
  readonly getStateVisitsByPath: (path: string) => ReadonlyArray<string>;
  readonly getPendingRequests: () => ReadonlyArray<RunEventPendingRequestSummary>;
  readonly getTurnRange: (turnId: string) => RunEventRange | null;
  readonly getItemRange: (itemId: string) => RunEventRange | null;
  readonly getRequestRange: (requestId: string) => RunEventRange | null;
}

export interface EventPageQuery {
  readonly after?: string | number | null;
  readonly limit?: number;
}

export interface RowPageQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
}

interface MutableRange {
  firstSeq: number;
  lastSeq: number;
  eventIds: string[];
}

type MutableAggregateStats = {
  status?: string;
  startedAt?: string;
  endedAt?: string;
  turnCount: number;
  activeTurnId?: string;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  modelContextWindow?: number;
};

type MutablePending = {
  requestId: string;
  status: 'pending' | 'submitted';
  kind?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  stateVisitId?: string;
  turnId?: string;
  itemId?: string;
  lastEventId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dataOf(event: RunEventEnvelope): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function readRequestId(event: RunEventEnvelope): string | undefined {
  return event.requestId ?? readString(dataOf(event)['requestId']);
}

function readTurnId(event: RunEventEnvelope): string | undefined {
  return event.turnId ?? readString(dataOf(event)['turnId']);
}

function readItemId(event: RunEventEnvelope): string | undefined {
  return event.itemId ?? readString(dataOf(event)['itemId']);
}

function readStateVisitId(event: RunEventEnvelope): string | undefined {
  return event.stateVisitId ?? readString(dataOf(event)['stateVisitId']);
}

function rangeFromMutable(range: MutableRange | undefined): RunEventRange | null {
  if (range === undefined) return null;
  return {
    firstSeq: range.firstSeq,
    lastSeq: range.lastSeq,
    eventIds: [...range.eventIds],
  };
}

function addRange(
  map: Map<string, MutableRange>,
  key: string | undefined,
  event: RunEventEnvelope,
): void {
  if (key === undefined) return;
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, {
      firstSeq: event.seq,
      lastSeq: event.seq,
      eventIds: [event.id],
    });
    return;
  }
  existing.lastSeq = event.seq;
  existing.eventIds.push(event.id);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 1_000);
}

function afterSeq(after: string | number | null | undefined): number {
  if (after === null || after === undefined) return 0;
  if (typeof after === 'number') return Number.isSafeInteger(after) && after > 0 ? after : 0;
  const suffix = after.includes(':') ? after.split(':').at(-1) : after;
  if (suffix === undefined || !/^[1-9]\d*$/.test(suffix)) return 0;
  const parsed = Number(suffix);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function eventPage(
  events: ReadonlyArray<RunEventWithOffset>,
  query?: EventPageQuery,
): RunEventPage {
  const limit = normalizeLimit(query?.limit);
  const seq = afterSeq(query?.after);
  const candidates = events.filter((entry) => entry.event.seq > seq);
  const page = candidates.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page,
    nextCursor: last !== undefined && candidates.length > page.length ? last.event.id : null,
  };
}

function rowPage(rows: ReadonlyArray<RunEventCompactRow>, query?: RowPageQuery): RunEventRowPage {
  const limit = normalizeLimit(query?.limit);
  const cursor = query?.cursor ?? null;
  const start =
    cursor === null
      ? 0
      : Math.max(0, rows.findIndex((row) => row.id === cursor || row.eventId === cursor) + 1);
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: last !== undefined && start + page.length < rows.length ? last.id : null,
  };
}

function compactRow(event: RunEventEnvelope): RunEventCompactRow | null {
  const row = dataOf(event)['row'];
  if (!isRecord(row)) return null;

  const kind = readString(row['kind']);
  if (kind === undefined) return null;

  const label = readString(row['label']);
  const text = readString(row['text']);
  const status = readString(row['status']);
  const summary = readString(row['summary']);
  if (label === undefined && text === undefined && status === undefined && summary === undefined) {
    return null;
  }

  const stateVisitId = event.stateVisitId ?? readString(row['stateVisitId']);
  const turnId = event.turnId ?? readString(row['turnId']);
  const itemId = event.itemId ?? readString(row['itemId']);
  const requestId = event.requestId ?? readString(row['requestId']);
  const data = isRecord(row['data']) ? row['data'] : undefined;
  const elapsedMs = readNumber(row['elapsedMs']);

  return {
    id: readString(row['id']) ?? `${event.id}:row`,
    eventId: event.id,
    seq: event.seq,
    time: event.time,
    type: event.type,
    kind,
    ...(stateVisitId !== undefined ? { stateVisitId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(itemId !== undefined ? { itemId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

function stateVisit(event: RunEventEnvelope): RunEventStateVisit | null {
  if (event.type !== 'state.changed') return null;
  const data = dataOf(event);
  const path = readString(data['path']) ?? readString(data['to']) ?? event.stateVisitId;
  const to = readString(data['to']) ?? path;
  if (path === undefined || to === undefined) return null;

  const id = event.stateVisitId ?? readString(data['stateVisitId']) ?? `${path}#${event.seq}`;
  const from = readNullableString(data['from']);
  const cause = readString(data['cause']);
  return {
    id,
    path,
    seq: event.seq,
    time: event.time,
    to,
    ...(from !== undefined ? { from } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
}

function upsertPending(
  pending: Map<string, MutablePending>,
  event: RunEventEnvelope,
  requestId: string,
  status: 'pending' | 'submitted',
): void {
  const data = dataOf(event);
  const existing = pending.get(requestId);
  const kind = readString(data['kind']) ?? readString(data['requestKind']);
  const summary =
    readString(data['summary']) ?? readString(data['question']) ?? readString(data['command']);
  const stateVisitId = readStateVisitId(event);
  const turnId = readTurnId(event);
  const itemId = readItemId(event);

  if (existing === undefined) {
    pending.set(requestId, {
      requestId,
      status,
      createdAt: event.time,
      updatedAt: event.time,
      lastEventId: event.id,
      ...(kind !== undefined ? { kind } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(stateVisitId !== undefined ? { stateVisitId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(itemId !== undefined ? { itemId } : {}),
    });
    return;
  }

  existing.status = status;
  existing.updatedAt = event.time;
  existing.lastEventId = event.id;
  if (kind !== undefined) existing.kind = kind;
  if (summary !== undefined) existing.summary = summary;
  if (stateVisitId !== undefined) existing.stateVisitId = stateVisitId;
  if (turnId !== undefined) existing.turnId = turnId;
  if (itemId !== undefined) existing.itemId = itemId;
}

function isResolutionEvent(type: string): boolean {
  return (
    type === 'request.resolved' ||
    type === 'request.completed' ||
    type === 'request.cancelled' ||
    type === 'request.failed'
  );
}

function isAcceptedReplyResolution(event: RunEventEnvelope): boolean {
  if (event.type !== 'reply.resolved') return false;
  const data = dataOf(event);
  if (data['ok'] === true) return true;
  return readString(data['status']) === 'accepted';
}

function observePending(pending: Map<string, MutablePending>, event: RunEventEnvelope): void {
  const requestId = readRequestId(event);
  if (requestId === undefined) return;
  if (event.type === 'request.created') {
    upsertPending(pending, event, requestId, 'pending');
    return;
  }
  if (event.type === 'reply.submitted') {
    if (pending.has(requestId)) {
      upsertPending(pending, event, requestId, 'submitted');
    }
    return;
  }
  if (event.type === 'reply.resolved' && !isAcceptedReplyResolution(event)) {
    const existing = pending.get(requestId);
    if (existing !== undefined) {
      existing.status = 'pending';
      existing.updatedAt = event.time;
      existing.lastEventId = event.id;
    }
    return;
  }
  if (isResolutionEvent(event.type)) {
    pending.delete(requestId);
  }
  if (isAcceptedReplyResolution(event)) {
    pending.delete(requestId);
  }
}

function assignNumber(
  aggregate: MutableAggregateStats,
  key:
    | 'totalTokens'
    | 'inputTokens'
    | 'cachedInputTokens'
    | 'outputTokens'
    | 'reasoningOutputTokens'
    | 'modelContextWindow',
  value: unknown,
): void {
  const parsed = readNumber(value);
  if (parsed !== undefined) {
    aggregate[key] = parsed;
  }
}

function observeTokens(aggregate: MutableAggregateStats, event: RunEventEnvelope): void {
  if (event.type !== 'token.updated') return;
  const data = dataOf(event);
  const total = isRecord(data['total']) ? data['total'] : data;
  assignNumber(aggregate, 'totalTokens', total['totalTokens']);
  assignNumber(aggregate, 'inputTokens', total['inputTokens']);
  assignNumber(aggregate, 'cachedInputTokens', total['cachedInputTokens']);
  assignNumber(aggregate, 'outputTokens', total['outputTokens']);
  assignNumber(aggregate, 'reasoningOutputTokens', total['reasoningOutputTokens']);
  assignNumber(aggregate, 'modelContextWindow', data['modelContextWindow']);
}

function observeAggregate(aggregate: MutableAggregateStats, event: RunEventEnvelope): void {
  const data = dataOf(event);
  if (event.type === 'run.started') {
    aggregate.status = 'running';
    aggregate.startedAt = readString(data['startedAt']) ?? event.time;
  } else if (event.type === 'run.completed' || event.type === 'run.ended') {
    aggregate.status = readString(data['status']) ?? 'completed';
    aggregate.endedAt = readString(data['endedAt']) ?? event.time;
  } else if (event.type === 'run.failed') {
    aggregate.status = 'failed';
    aggregate.endedAt = readString(data['endedAt']) ?? event.time;
  } else if (event.type === 'turn.started') {
    aggregate.turnCount += 1;
    const turnId = readTurnId(event);
    if (turnId === undefined) {
      delete aggregate.activeTurnId;
    } else {
      aggregate.activeTurnId = turnId;
    }
  } else if (event.type === 'turn.completed') {
    const turnId = readTurnId(event);
    if (turnId === undefined || aggregate.activeTurnId === turnId) {
      delete aggregate.activeTurnId;
    }
  }

  observeTokens(aggregate, event);
}

function freezeAggregate(aggregate: MutableAggregateStats): RunEventAggregateStats {
  return { ...aggregate };
}

function freezePending(pending: Map<string, MutablePending>): RunEventPendingRequestSummary[] {
  return [...pending.values()].map((request) => ({ ...request }));
}

export function buildRunEventIndex(options: BuildRunEventIndexOptions): RunEventIndex {
  const indexedEvents = [...options.events];
  const turnRanges = new Map<string, MutableRange>();
  const itemRanges = new Map<string, MutableRange>();
  const requestRanges = new Map<string, MutableRange>();
  const stateVisits: RunEventStateVisit[] = [];
  const statePathVisits = new Map<string, string[]>();
  const stateVisitRows = new Map<string, RunEventCompactRow[]>();
  const recentRows: RunEventCompactRow[] = [];
  const pending = new Map<string, MutablePending>();
  const aggregate: MutableAggregateStats = { turnCount: 0 };
  let currentState: RunEventStateVisit | null = null;

  for (const entry of indexedEvents) {
    const event = entry.event;
    addRange(turnRanges, readTurnId(event), event);
    addRange(itemRanges, readItemId(event), event);
    addRange(requestRanges, readRequestId(event), event);

    const visit = stateVisit(event);
    if (visit !== null) {
      stateVisits.push(visit);
      currentState = visit;
      const pathVisits = statePathVisits.get(visit.path);
      if (pathVisits === undefined) {
        statePathVisits.set(visit.path, [visit.id]);
      } else {
        pathVisits.push(visit.id);
      }
    }

    const row = compactRow(event);
    if (row !== null) {
      recentRows.push(row);
      if (row.stateVisitId !== undefined) {
        const rows = stateVisitRows.get(row.stateVisitId);
        if (rows === undefined) {
          stateVisitRows.set(row.stateVisitId, [row]);
        } else {
          rows.push(row);
        }
      }
    }

    observePending(pending, event);
    observeAggregate(aggregate, event);
  }

  return {
    events: indexedEvents,
    currentState,
    stateVisits,
    aggregateStats: freezeAggregate(aggregate),
    getEventPage(query) {
      return eventPage(indexedEvents, query);
    },
    getRecentRows(query) {
      return rowPage(recentRows, query);
    },
    getStateVisitRows(stateVisitId, query) {
      return rowPage(stateVisitRows.get(stateVisitId) ?? [], query);
    },
    getStateVisitsByPath(path) {
      return [...(statePathVisits.get(path) ?? [])];
    },
    getPendingRequests() {
      return freezePending(pending);
    },
    getTurnRange(turnId) {
      return rangeFromMutable(turnRanges.get(turnId));
    },
    getItemRange(itemId) {
      return rangeFromMutable(itemRanges.get(itemId));
    },
    getRequestRange(requestId) {
      return rangeFromMutable(requestRanges.get(requestId));
    },
  };
}
