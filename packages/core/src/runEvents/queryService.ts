import { buildRunEventIndex, type RunEventIndex, type RowPageQuery } from './indexer.js';
import { replayRunEvents } from './replay.js';
import type {
  RunEventAggregateStats,
  RunEventCompactRow,
  RunEventEnvelope,
  RunEventPendingRequestSummary,
  RunEventPayload,
  RunEventPosture,
  RunEventReplayDiagnostic,
  RunEventStateVisit,
  RunEventWithOffset,
} from './types.js';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;

export interface CreateRunEventQueryServiceOptions {
  readonly runId: string;
  readonly eventsPath: string;
}

export interface ApiSafeRunEvent {
  readonly schema: RunEventEnvelope['schema'];
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
  readonly data?: RunEventPayload;
  readonly meta?: RunEventPayload;
  readonly offset: number;
  readonly lineBytes: number;
}

export interface ApiRunCurrentStateExit {
  readonly name: string;
  readonly kind: string;
  readonly branchCount?: number;
}

export interface ApiRunCurrentState {
  readonly path: string;
  readonly leaf?: string;
  readonly kind?: string;
  readonly visitCount?: number;
  readonly exits?: ReadonlyArray<ApiRunCurrentStateExit>;
  readonly context?: Record<string, unknown>;
}

export interface ApiRunBootstrap<
  TRunMeta extends object = Record<string, unknown>,
  TTopology = unknown,
> {
  readonly run: TRunMeta;
  readonly topology: TTopology | null;
  readonly latestEventId: string | null;
  readonly currentState: ApiRunCurrentState | null;
  readonly posture: RunEventPosture;
  readonly currentStateVisit: RunEventStateVisit | null;
  readonly stateVisits: ReadonlyArray<RunEventStateVisit>;
  readonly statePathVisits: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly pending: ReadonlyArray<RunEventPendingRequestSummary>;
  readonly aggregateStats: RunEventAggregateStats;
  readonly recentRows: ReadonlyArray<RunEventCompactRow>;
  readonly diagnostics: ReadonlyArray<RunEventReplayDiagnostic>;
}

export interface RunEventQueryServiceUnavailable {
  readonly ok: false;
  readonly error: 'run-event-log-unavailable';
  readonly diagnostics: ReadonlyArray<RunEventReplayDiagnostic>;
}

export type ApiRunBootstrapResult<
  TRunMeta extends object = Record<string, unknown>,
  TTopology = unknown,
> =
  | { readonly ok: true; readonly bootstrap: ApiRunBootstrap<TRunMeta, TTopology> }
  | RunEventQueryServiceUnavailable;

export type ApiRunRowPageResult =
  | {
      readonly ok: true;
      readonly rows: ReadonlyArray<RunEventCompactRow>;
      readonly nextCursor: string | null;
    }
  | RunEventQueryServiceUnavailable;

export type ApiRunEventPageResult =
  | {
      readonly ok: true;
      readonly events: ReadonlyArray<ApiSafeRunEvent>;
      readonly nextCursor: string | null;
      readonly diagnostics: ReadonlyArray<RunEventReplayDiagnostic>;
    }
  | { readonly ok: false; readonly error: 'invalid-event-cursor' }
  | {
      readonly ok: false;
      readonly error: 'event-cursor-out-of-range';
      readonly latestEventId: string | null;
    }
  | RunEventQueryServiceUnavailable;

export type ApiRunEventsAfterResult =
  | { readonly ok: true; readonly events: ReadonlyArray<ApiSafeRunEvent> }
  | Exclude<ApiRunEventPageResult, { readonly ok: true }>;

export type RunEventQueryServiceUpdateResult =
  | { readonly ok: true; readonly latestEventId: string }
  | { readonly ok: false; readonly diagnostic: RunEventReplayDiagnostic };

export type RunEventQueryServiceListener = (entry: RunEventWithOffset) => void;

export interface RunEventQueryService {
  readonly runId: string;
  readonly available: boolean;
  readonly subscribe: (listener: RunEventQueryServiceListener) => () => void;
  readonly acceptAppend: (entry: RunEventWithOffset) => RunEventQueryServiceUpdateResult;
  readonly getLatestEventId: () => string | null;
  readonly getDiagnostics: () => ReadonlyArray<RunEventReplayDiagnostic>;
  readonly getBootstrap: <TRunMeta extends object, TTopology = unknown>(options: {
    readonly getRunMeta: () => TRunMeta;
    readonly topology?: TTopology;
    readonly recentLimit?: number;
  }) => ApiRunBootstrapResult<TRunMeta, TTopology>;
  readonly getStateVisitRows: (stateVisitId: string, query?: RowPageQuery) => ApiRunRowPageResult;
  readonly getRecentRows: (query?: RowPageQuery) => ApiRunRowPageResult;
  readonly getEventPage: (query?: {
    readonly after?: string | null;
    readonly limit?: number;
  }) => ApiRunEventPageResult;
  readonly eventsAfter: (
    afterEventId?: string | null,
    options?: { readonly pageLimit?: number },
  ) => ApiRunEventsAfterResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(limit, MAX_PAGE_LIMIT);
}

function latestEventId(events: ReadonlyArray<RunEventWithOffset>): string | null {
  return events.at(-1)?.event.id ?? null;
}

function unavailable(
  diagnostics: ReadonlyArray<RunEventReplayDiagnostic>,
): RunEventQueryServiceUnavailable {
  return { ok: false, error: 'run-event-log-unavailable', diagnostics };
}

function parseEventCursor(
  runId: string,
  after: string | null | undefined,
): { readonly ok: true; readonly seq: number } | { readonly ok: false } {
  if (after === undefined || after === null) return { ok: true, seq: 0 };
  const prefix = `${runId}:`;
  if (!after.startsWith(prefix)) return { ok: false };
  const seqText = after.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(seqText)) return { ok: false };
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) return { ok: false };
  return { ok: true, seq };
}

function apiSafeEvent(entry: RunEventWithOffset): ApiSafeRunEvent {
  const event = entry.event;
  return {
    schema: event.schema,
    runId: event.runId,
    seq: event.seq,
    id: event.id,
    time: event.time,
    type: event.type,
    ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.stateVisitId !== undefined ? { stateVisitId: event.stateVisitId } : {}),
    ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
    ...(event.meta !== undefined ? { meta: event.meta } : {}),
    offset: entry.offset,
    lineBytes: entry.lineBytes,
  };
}

function currentStateExit(value: unknown): ApiRunCurrentStateExit | null {
  if (!isRecord(value)) return null;
  const name = readString(value['name']);
  const kind = readString(value['kind']);
  if (name === undefined || kind === undefined) return null;
  const branchCount = readNumber(value['branchCount']);
  return {
    name,
    kind,
    ...(branchCount !== undefined ? { branchCount } : {}),
  };
}

function currentStateFromEvent(event: RunEventEnvelope): ApiRunCurrentState | null {
  if (event.type !== 'state.changed' || !isRecord(event.data)) return null;
  const path = readString(event.data['path']);
  if (path === undefined) return null;
  const leaf = readString(event.data['leaf']);
  const kind = readString(event.data['kind']);
  const visitCount = readNumber(event.data['visitCount']);
  const rawExits = Array.isArray(event.data['exits']) ? event.data['exits'] : undefined;
  const exits = rawExits
    ?.map((exit) => currentStateExit(exit))
    .filter((exit): exit is ApiRunCurrentStateExit => exit !== null);
  return {
    path,
    ...(leaf !== undefined ? { leaf } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(visitCount !== undefined ? { visitCount } : {}),
    ...(exits !== undefined ? { exits } : {}),
  };
}

function currentStateFromEvents(
  events: ReadonlyArray<RunEventWithOffset>,
): ApiRunCurrentState | null {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const entry = events[idx];
    if (entry === undefined) continue;
    const state = currentStateFromEvent(entry.event);
    if (state !== null) return state;
  }
  return null;
}

function contextFromEvent(event: RunEventEnvelope): Record<string, unknown> | null {
  if (event.type !== 'context.initialized' && event.type !== 'context.changed') {
    return null;
  }
  const context = isRecord(event.data?.['context']) ? event.data['context'] : null;
  return context;
}

function currentContextFromEvents(
  events: ReadonlyArray<RunEventWithOffset>,
): Record<string, unknown> | undefined {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const entry = events[idx];
    if (entry === undefined) continue;
    const context = contextFromEvent(entry.event);
    if (context !== null) return context;
  }
  return undefined;
}

function attachContextToCurrentState(
  state: ApiRunCurrentState | null,
  context: Record<string, unknown> | undefined,
): ApiRunCurrentState | null {
  if (state === null) return null;
  return context === undefined ? state : { ...state, context };
}

function statePathVisits(
  visits: ReadonlyArray<RunEventStateVisit>,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const byPath: Record<string, string[]> = {};
  for (const visit of visits) {
    byPath[visit.path] ??= [];
    byPath[visit.path]?.push(visit.id);
  }
  return byPath;
}

function liveAppendDiagnostic(
  code: RunEventReplayDiagnostic['code'],
  message: string,
  entry: RunEventWithOffset,
): RunEventReplayDiagnostic {
  return {
    severity: 'corruption',
    code,
    message,
    offset: entry.offset,
    seq: entry.event.seq,
    id: entry.event.id,
  };
}

export function createRunEventQueryService(
  options: CreateRunEventQueryServiceOptions,
): RunEventQueryService {
  const replay = replayRunEvents(options);
  let events = [...replay.events];
  let diagnostics = [...replay.diagnostics];
  let index: RunEventIndex = buildRunEventIndex({ events });
  let available = replay.ok;
  const listeners = new Set<RunEventQueryServiceListener>();

  function rebuildIndex(): void {
    index = buildRunEventIndex({ events });
  }

  function rejectAppend(
    code: RunEventReplayDiagnostic['code'],
    message: string,
    entry: RunEventWithOffset,
  ): RunEventQueryServiceUpdateResult {
    const diagnostic = liveAppendDiagnostic(code, message, entry);
    diagnostics = [...diagnostics, diagnostic];
    return { ok: false, diagnostic };
  }

  function notify(entry: RunEventWithOffset): void {
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Live stream observation must not make the query service unusable.
      }
    }
  }

  const service: RunEventQueryService = {
    runId: options.runId,
    get available() {
      return available;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acceptAppend(entry) {
      if (!available) {
        return {
          ok: false,
          diagnostic: diagnostics.find((item) => item.severity === 'corruption') ?? {
            severity: 'corruption',
            code: 'invalid-json-object',
            message: 'run event log is unavailable',
            offset: entry.offset,
            seq: entry.event.seq,
            id: entry.event.id,
          },
        };
      }
      if (entry.event.runId !== options.runId) {
        return rejectAppend(
          'wrong-run-id',
          'live append runId does not match query service run',
          entry,
        );
      }
      const expectedSeq = (events.at(-1)?.event.seq ?? 0) + 1;
      if (entry.event.seq !== expectedSeq) {
        return rejectAppend(
          entry.event.seq < expectedSeq ? 'non-increasing-seq' : 'invalid-seq',
          'live append seq must be the next canonical sequence for this run',
          entry,
        );
      }
      if (entry.event.id !== `${options.runId}:${entry.event.seq}`) {
        return rejectAppend(
          'id-seq-mismatch',
          'live append id must equal `${runId}:${seq}`',
          entry,
        );
      }

      events = [...events, entry];
      rebuildIndex();
      available = true;
      notify(entry);
      return { ok: true, latestEventId: entry.event.id };
    },
    getLatestEventId() {
      return latestEventId(events);
    },
    getDiagnostics() {
      return diagnostics;
    },
    getBootstrap(bootstrapOptions) {
      if (!available) return unavailable(diagnostics);
      const currentState = currentStateFromEvents(events);
      const currentContext = currentContextFromEvents(events);
      return {
        ok: true,
        bootstrap: {
          run: bootstrapOptions.getRunMeta(),
          topology: bootstrapOptions.topology ?? null,
          latestEventId: latestEventId(events),
          currentState: attachContextToCurrentState(currentState, currentContext),
          posture: index.posture,
          currentStateVisit: index.currentState,
          stateVisits: index.stateVisits,
          statePathVisits: statePathVisits(index.stateVisits),
          pending: index.getPendingRequests(),
          aggregateStats: index.aggregateStats,
          recentRows: index.getRecentRows(
            bootstrapOptions.recentLimit === undefined
              ? undefined
              : { limit: bootstrapOptions.recentLimit },
          ).rows,
          diagnostics,
        },
      };
    },
    getStateVisitRows(stateVisitId, query) {
      if (!available) return unavailable(diagnostics);
      const page = index.getStateVisitRows(stateVisitId, query);
      return { ok: true, rows: page.rows, nextCursor: page.nextCursor };
    },
    getRecentRows(query) {
      if (!available) return unavailable(diagnostics);
      const page = index.getRecentRows(query);
      return { ok: true, rows: page.rows, nextCursor: page.nextCursor };
    },
    getEventPage(query) {
      if (!available) return unavailable(diagnostics);
      const parsed = parseEventCursor(options.runId, query?.after);
      if (!parsed.ok) return { ok: false, error: 'invalid-event-cursor' };
      const latestSeq = events.at(-1)?.event.seq ?? 0;
      if (parsed.seq > latestSeq) {
        return {
          ok: false,
          error: 'event-cursor-out-of-range',
          latestEventId: latestEventId(events),
        };
      }
      const page = index.getEventPage({
        after: parsed.seq === 0 ? null : `${options.runId}:${parsed.seq}`,
        limit: normalizeLimit(query?.limit),
      });
      return {
        ok: true,
        events: page.events.map((entry) => apiSafeEvent(entry)),
        nextCursor: page.nextCursor,
        diagnostics,
      };
    },
    eventsAfter(afterEventId, drainOptions) {
      const drained: ApiSafeRunEvent[] = [];
      let cursor = afterEventId ?? null;
      for (;;) {
        const page = service.getEventPage(
          drainOptions?.pageLimit === undefined
            ? { after: cursor }
            : { after: cursor, limit: drainOptions.pageLimit },
        );
        if (!page.ok) return page;
        drained.push(...page.events);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return { ok: true, events: drained };
    },
  };

  return service;
}
