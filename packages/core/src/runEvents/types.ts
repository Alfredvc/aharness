/**
 * Canonical run-event contracts.
 *
 * Slice 0 defines the stable JSONL envelope and the in-memory projection
 * shapes used by replay/index tests. These types are internal to core for
 * now: live runtime writers still use the legacy audit writer in
 * `events.ts`, and later slices will wire these contracts into the runtime
 * once every `events.jsonl` writer has a canonical mapping.
 */

export const RUN_EVENT_SCHEMA = 'aharness.event.v1' as const;

export type RunEventPayload = Readonly<Record<string, unknown>>;

export interface RunEventCorrelationFields {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly stateVisitId?: string;
  readonly itemId?: string;
  readonly requestId?: string;
}

export interface RunEventEnvelope extends RunEventCorrelationFields {
  readonly schema: typeof RUN_EVENT_SCHEMA;
  readonly runId: string;
  readonly seq: number;
  readonly id: string;
  readonly time: string;
  readonly type: string;
  readonly data?: RunEventPayload;
  readonly meta?: RunEventPayload;
  readonly raw?: RunEventPayload;
}

export interface RunEventAppendInput extends RunEventCorrelationFields {
  readonly type: string;
  readonly data?: RunEventPayload;
  readonly meta?: RunEventPayload;
  readonly raw?: RunEventPayload;
}

export interface RunEventWithOffset {
  readonly event: RunEventEnvelope;
  readonly offset: number;
  readonly lineBytes: number;
}

export type RunEventDiagnosticSeverity = 'warning' | 'corruption';

export type RunEventDiagnosticCode =
  | 'empty-line'
  | 'malformed-final-line'
  | 'malformed-non-final-line'
  | 'invalid-json-object'
  | 'legacy-audit-entry'
  | 'wrong-schema'
  | 'wrong-run-id'
  | 'missing-required-field'
  | 'invalid-seq'
  | 'id-seq-mismatch'
  | 'invalid-time'
  | 'invalid-type'
  | 'invalid-correlation-field'
  | 'invalid-payload-field'
  | 'non-increasing-seq';

export interface RunEventReplayDiagnostic {
  readonly severity: RunEventDiagnosticSeverity;
  readonly code: RunEventDiagnosticCode;
  readonly message: string;
  readonly line?: number;
  readonly offset?: number;
  readonly seq?: number;
  readonly id?: string;
}

export type RunEventReplayResult =
  | {
      readonly ok: true;
      readonly events: ReadonlyArray<RunEventWithOffset>;
      readonly diagnostics: ReadonlyArray<RunEventReplayDiagnostic>;
      readonly latestSeq: number;
      readonly nextSeq: number;
      readonly appendOffset: number;
    }
  | {
      readonly ok: false;
      readonly events: ReadonlyArray<RunEventWithOffset>;
      readonly diagnostics: ReadonlyArray<RunEventReplayDiagnostic>;
      readonly latestSeq: number;
      readonly nextSeq: number;
      readonly appendOffset: number;
    };

export interface RunEventCompactRow {
  readonly id: string;
  readonly eventId: string;
  readonly seq: number;
  readonly time: string;
  readonly type: string;
  readonly stateVisitId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly kind: string;
  readonly label?: string;
  readonly text?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly elapsedMs?: number;
  readonly data?: RunEventPayload;
}

export interface RunEventStateVisit {
  readonly id: string;
  readonly path: string;
  readonly seq: number;
  readonly time: string;
  readonly from?: string | null;
  readonly to: string;
  readonly cause?: string;
}

export interface RunEventRange {
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly eventIds: ReadonlyArray<string>;
}

export interface RunEventPendingRequestSummary {
  readonly requestId: string;
  readonly status: 'pending' | 'submitted';
  readonly kind?: string;
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateVisitId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly lastEventId: string;
}

export interface RunEventAggregateStats {
  readonly status?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly turnCount: number;
  readonly activeTurnId?: string;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly modelContextWindow?: number;
}

export interface RunEventPage {
  readonly events: ReadonlyArray<RunEventWithOffset>;
  readonly nextCursor: string | null;
}

export interface RunEventRowPage {
  readonly rows: ReadonlyArray<RunEventCompactRow>;
  readonly nextCursor: string | null;
}
