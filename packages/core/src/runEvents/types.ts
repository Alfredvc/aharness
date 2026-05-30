/**
 * Canonical run-event contracts.
 *
 * These types define the stable JSONL envelope and the in-memory projection
 * shapes used by replay/index tests and the live runtime publisher.
 * `events.ts` still exposes the legacy public input union, but new writes
 * map through these canonical contracts before landing in `events.jsonl`.
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
  // UI-visible tool result fields for compact tool rows; raw envelopes stay out
  // of bootstrap/row-page projections.
  readonly output?: string;
  readonly ok?: boolean;
  readonly resultId?: string;
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

export interface RunEventOwnerInputPendingCardQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly choices?: ReadonlyArray<string>;
}

export type RunEventPendingCard =
  | {
      readonly kind: 'owner-input';
      readonly id: string;
      readonly requestId: string;
      readonly method: 'item/tool/requestUserInput';
      readonly questions: ReadonlyArray<RunEventOwnerInputPendingCardQuestion>;
    }
  | {
      readonly kind: 'file-approval';
      readonly id: string;
      readonly requestId: string;
      readonly method: 'item/fileChange/requestApproval';
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly reason?: string;
      readonly grantRoot?: string;
      readonly changes: ReadonlyArray<unknown>;
    }
  | {
      readonly kind: 'command-approval';
      readonly id: string;
      readonly requestId: string;
      readonly method: 'item/commandExecution/requestApproval';
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly approvalId?: string;
      readonly command?: string;
      readonly cwd?: string;
      readonly reason?: string;
      readonly commandActions?: ReadonlyArray<unknown>;
      readonly networkApprovalContext?: unknown;
    }
  | {
      readonly kind: 'permission-approval';
      readonly id: string;
      readonly requestId: string;
      readonly method: 'item/permissions/requestApproval';
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly cwd: string;
      readonly permissions: unknown;
      readonly reason?: string;
    }
  | {
      readonly kind: 'elicitation';
      readonly id: string;
      readonly requestId: string;
      readonly method: 'mcpServer/elicitation/request';
      readonly threadId: string;
      readonly turnId: string | null;
      readonly serverName: string;
      readonly mode: 'form' | 'url';
      readonly message: string;
      readonly requestedSchema?: unknown;
      readonly url?: string;
      readonly elicitationId?: string;
    };

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
  readonly pendingCard?: RunEventPendingCard;
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

export interface RunEventPosture {
  readonly isTerminal: boolean;
  readonly isAwaiting: boolean;
  readonly submittedThisTurn: boolean;
  readonly open: boolean;
}

export interface RunEventPage {
  readonly events: ReadonlyArray<RunEventWithOffset>;
  readonly nextCursor: string | null;
}

export interface RunEventRowPage {
  readonly rows: ReadonlyArray<RunEventCompactRow>;
  readonly nextCursor: string | null;
}
