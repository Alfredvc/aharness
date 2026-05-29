/**
 * Canonical JSONL replay reader and startup scanner.
 *
 * Replay reads UTF-8 bytes, treats each non-empty line as one canonical
 * JSON object, validates the envelope, and returns byte offsets for every
 * accepted event. A malformed final non-empty line is ignored with a warning
 * so crash-truncated tails do not prevent startup. Malformed or invalid
 * non-final lines are corruption: callers get `ok: false` and must not build
 * a normal index from the partial result.
 */
import { existsSync, readFileSync } from 'node:fs';

import {
  RUN_EVENT_SCHEMA,
  type RunEventDiagnosticCode,
  type RunEventEnvelope,
  type RunEventPayload,
  type RunEventReplayDiagnostic,
  type RunEventReplayResult,
  type RunEventWithOffset,
} from './types.js';

export interface ReplayRunEventsOptions {
  readonly runId: string;
  readonly eventsPath: string;
}

interface LineRecord {
  readonly text: string;
  readonly offset: number;
  readonly lineBytes: number;
  readonly line: number;
  readonly terminated: boolean;
}

type ValidatedEnvelope =
  | { readonly ok: true; readonly event: RunEventEnvelope }
  | { readonly ok: false; readonly diagnostic: RunEventReplayDiagnostic };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  code: RunEventDiagnosticCode,
  message: string,
  lineRecord: LineRecord,
): RunEventReplayDiagnostic {
  return {
    severity: code === 'malformed-final-line' ? 'warning' : 'corruption',
    code,
    message,
    line: lineRecord.line,
    offset: lineRecord.offset,
  };
}

function splitNonEmptyLines(bytes: Buffer): LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  let line = 1;

  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const terminated = newline !== -1;
    const end = newline === -1 ? bytes.length : newline + 1;
    const lineBytes = end - start;
    const contentEnd = newline === -1 ? end : end - 1;
    const text = bytes.subarray(start, contentEnd).toString('utf8');
    if (text.trim().length > 0) {
      lines.push({
        text,
        offset: start,
        lineBytes,
        line,
        terminated,
      });
    }

    start = end;
    line += 1;
  }

  return lines;
}

function missing(value: Record<string, unknown>, key: string): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined;
}

function hasLegacyAuditShape(value: Record<string, unknown>): boolean {
  return typeof value['kind'] === 'string' || typeof value['ts'] === 'string';
}

function validatePayloadField(
  value: Record<string, unknown>,
  key: 'data' | 'meta' | 'raw',
  lineRecord: LineRecord,
): RunEventReplayDiagnostic | null {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    return null;
  }
  if (!isRecord(value[key])) {
    return diagnostic(
      'invalid-payload-field',
      `canonical event ${key} field must be an object when present`,
      lineRecord,
    );
  }
  return null;
}

function validateCorrelationField(
  value: Record<string, unknown>,
  key: 'threadId' | 'turnId' | 'stateVisitId' | 'itemId' | 'requestId',
  lineRecord: LineRecord,
): RunEventReplayDiagnostic | null {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    return null;
  }
  if (typeof value[key] !== 'string') {
    return diagnostic(
      'invalid-correlation-field',
      `canonical event ${key} field must be a string when present`,
      lineRecord,
    );
  }
  return null;
}

function validateEnvelope(
  parsed: unknown,
  runId: string,
  lineRecord: LineRecord,
): ValidatedEnvelope {
  if (!isRecord(parsed)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'invalid-json-object',
        'canonical event line must be an object',
        lineRecord,
      ),
    };
  }

  if (parsed['schema'] === undefined && hasLegacyAuditShape(parsed)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'legacy-audit-entry',
        'event line is a legacy audit entry, not an aharness.event.v1 canonical envelope',
        lineRecord,
      ),
    };
  }

  for (const key of ['schema', 'runId', 'seq', 'id', 'time', 'type']) {
    if (missing(parsed, key)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          'missing-required-field',
          `canonical event is missing required field ${key}`,
          lineRecord,
        ),
      };
    }
  }

  if (parsed['schema'] !== RUN_EVENT_SCHEMA) {
    return {
      ok: false,
      diagnostic: diagnostic(
        hasLegacyAuditShape(parsed) ? 'legacy-audit-entry' : 'wrong-schema',
        'event line is not an aharness.event.v1 canonical envelope',
        lineRecord,
      ),
    };
  }

  if (parsed['runId'] !== runId) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'wrong-run-id',
        'canonical event runId does not match replay run',
        lineRecord,
      ),
    };
  }

  const seq = parsed['seq'];
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'invalid-seq',
        'canonical event seq must be a positive safe integer',
        lineRecord,
      ),
    };
  }
  const numericSeq = seq as number;

  const id = parsed['id'];
  if (typeof id !== 'string' || id !== `${runId}:${numericSeq}`) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'id-seq-mismatch',
        'canonical event id must equal `${runId}:${seq}`',
        lineRecord,
      ),
    };
  }

  const time = parsed['time'];
  if (typeof time !== 'string' || time.length === 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'invalid-time',
        'canonical event time must be a non-empty string',
        lineRecord,
      ),
    };
  }

  const type = parsed['type'];
  if (typeof type !== 'string' || type.length === 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'invalid-type',
        'canonical event type must be a non-empty string',
        lineRecord,
      ),
    };
  }

  for (const key of ['threadId', 'turnId', 'stateVisitId', 'itemId', 'requestId'] as const) {
    const invalid = validateCorrelationField(parsed, key, lineRecord);
    if (invalid !== null) return { ok: false, diagnostic: invalid };
  }

  for (const key of ['data', 'meta', 'raw'] as const) {
    const invalid = validatePayloadField(parsed, key, lineRecord);
    if (invalid !== null) return { ok: false, diagnostic: invalid };
  }

  const event: RunEventEnvelope = {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq: numericSeq,
    id,
    time,
    type,
    ...(parsed['threadId'] !== undefined ? { threadId: parsed['threadId'] as string } : {}),
    ...(parsed['turnId'] !== undefined ? { turnId: parsed['turnId'] as string } : {}),
    ...(parsed['stateVisitId'] !== undefined
      ? { stateVisitId: parsed['stateVisitId'] as string }
      : {}),
    ...(parsed['itemId'] !== undefined ? { itemId: parsed['itemId'] as string } : {}),
    ...(parsed['requestId'] !== undefined ? { requestId: parsed['requestId'] as string } : {}),
    ...(parsed['data'] !== undefined ? { data: parsed['data'] as RunEventPayload } : {}),
    ...(parsed['meta'] !== undefined ? { meta: parsed['meta'] as RunEventPayload } : {}),
    ...(parsed['raw'] !== undefined ? { raw: parsed['raw'] as RunEventPayload } : {}),
  };

  return { ok: true, event };
}

function result(
  ok: boolean,
  events: RunEventWithOffset[],
  diagnostics: RunEventReplayDiagnostic[],
  appendOffset: number,
): RunEventReplayResult {
  const latestSeq = events.length === 0 ? 0 : (events[events.length - 1]?.event.seq ?? 0);
  const payload = {
    events,
    diagnostics,
    latestSeq,
    nextSeq: latestSeq + 1,
    appendOffset,
  };
  return ok ? { ok: true, ...payload } : { ok: false, ...payload };
}

function validAppendOffset(events: ReadonlyArray<RunEventWithOffset>, fallback: number): number {
  const last = events.at(-1);
  return last === undefined ? fallback : last.offset + last.lineBytes;
}

export function replayRunEvents(options: ReplayRunEventsOptions): RunEventReplayResult {
  if (!existsSync(options.eventsPath)) {
    return result(true, [], [], 0);
  }

  const bytes = readFileSync(options.eventsPath);
  if (bytes.length === 0) {
    return result(true, [], [], 0);
  }

  const lines = splitNonEmptyLines(bytes);
  const events: RunEventWithOffset[] = [];
  const diagnostics: RunEventReplayDiagnostic[] = [];
  let previousSeq = 0;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line === undefined) continue;
    const isFinalNonEmptyLine = idx === lines.length - 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch (err) {
      const code =
        isFinalNonEmptyLine && !line.terminated
          ? 'malformed-final-line'
          : 'malformed-non-final-line';
      diagnostics.push(
        diagnostic(
          code,
          `event line is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          line,
        ),
      );
      const appendOffset =
        code === 'malformed-final-line' ? line.offset : validAppendOffset(events, 0);
      return result(code === 'malformed-final-line', events, diagnostics, appendOffset);
    }

    const validated = validateEnvelope(parsed, options.runId, line);
    if (!validated.ok) {
      diagnostics.push(validated.diagnostic);
      return result(false, events, diagnostics, validAppendOffset(events, 0));
    }

    if (isFinalNonEmptyLine && !line.terminated) {
      diagnostics.push(
        diagnostic(
          'malformed-final-line',
          'final canonical event line is missing its newline terminator',
          line,
        ),
      );
      return result(true, events, diagnostics, line.offset);
    }

    const event = validated.event;
    if (event.seq <= previousSeq) {
      diagnostics.push({
        severity: 'corruption',
        code: 'non-increasing-seq',
        message: 'canonical event seq values must be strictly increasing in file order',
        line: line.line,
        offset: line.offset,
        seq: event.seq,
        id: event.id,
      });
      return result(false, events, diagnostics, validAppendOffset(events, 0));
    }

    events.push({
      event,
      offset: line.offset,
      lineBytes: line.lineBytes,
    });
    previousSeq = event.seq;
  }

  return result(true, events, diagnostics, bytes.length);
}

export function scanRunEvents(options: ReplayRunEventsOptions): RunEventReplayResult {
  return replayRunEvents(options);
}
