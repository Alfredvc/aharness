/**
 * Best-effort canonical JSONL writer.
 *
 * A writer assigns monotonic per-run sequence numbers, builds deterministic
 * `${runId}:${seq}` ids, and appends exactly one JSON object plus `\n`.
 * It does not fsync, rename, or write companion index/cache files. Write and
 * serialization failures are reported as structured warnings and never throw
 * through normal callers.
 */
import { appendFileSync, statSync, truncateSync } from 'node:fs';

import {
  RUN_EVENT_SCHEMA,
  type RunEventAppendInput,
  type RunEventCorrelationFields,
  type RunEventEnvelope,
} from './types.js';

export type RunEventWriterClock = () => Date | string;
export type RunEventAppendIo = (path: string, line: string) => void;
export type RunEventTruncateIo = (path: string, length: number) => void;

export interface RunEventWriterWarning {
  readonly code: 'serialize-failed' | 'truncate-failed' | 'append-failed';
  readonly message: string;
  readonly eventsPath: string;
  readonly envelope: RunEventEnvelope;
  readonly offset: number;
}

export type RunEventAppendResult =
  | {
      readonly ok: true;
      readonly envelope: RunEventEnvelope;
      readonly offset: number;
      readonly lineBytes: number;
    }
  | {
      readonly ok: false;
      readonly warning: RunEventWriterWarning;
    };

export interface RunEventAppendOptions {
  readonly onWarning?: (warning: RunEventWriterWarning) => void;
}

export interface RunEventWriterOptions {
  readonly runId: string;
  readonly eventsPath: string;
  readonly nextSeq?: number;
  readonly initialOffset?: number;
  readonly clock?: RunEventWriterClock;
  readonly append?: RunEventAppendIo;
  readonly truncate?: RunEventTruncateIo;
  readonly onWarning?: (warning: RunEventWriterWarning) => void;
}

export interface RunEventWriter {
  readonly append: (
    input: RunEventAppendInput,
    options?: RunEventAppendOptions,
  ) => RunEventAppendResult;
  readonly nextSeq: () => number;
  readonly offset: () => number;
}

function defaultAppend(path: string, line: string): void {
  appendFileSync(path, line);
}

function defaultTruncate(path: string, length: number): void {
  truncateSync(path, length);
}

function defaultClock(): Date {
  return new Date();
}

function readFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function normalizeNextSeq(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return value;
}

function normalizeOffset(value: number | undefined, eventsPath: string): number {
  if (value !== undefined) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  return readFileSize(eventsPath);
}

function timestamp(clock: RunEventWriterClock): string {
  const value = clock();
  return typeof value === 'string' ? value : value.toISOString();
}

function correlationFromInput(input: RunEventAppendInput): RunEventCorrelationFields {
  const fields: Record<string, string> = {};
  if (input.threadId !== undefined) fields['threadId'] = input.threadId;
  if (input.turnId !== undefined) fields['turnId'] = input.turnId;
  if (input.stateVisitId !== undefined) fields['stateVisitId'] = input.stateVisitId;
  if (input.itemId !== undefined) fields['itemId'] = input.itemId;
  if (input.requestId !== undefined) fields['requestId'] = input.requestId;
  return fields;
}

function buildEnvelope(
  runId: string,
  seq: number,
  time: string,
  input: RunEventAppendInput,
): RunEventEnvelope {
  const base: RunEventEnvelope = {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq,
    id: `${runId}:${seq}`,
    time,
    type: input.type,
    ...correlationFromInput(input),
  };

  return {
    ...base,
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

function warning(
  code: RunEventWriterWarning['code'],
  eventsPath: string,
  envelope: RunEventEnvelope,
  offset: number,
  err: unknown,
): RunEventWriterWarning {
  return {
    code,
    eventsPath,
    envelope,
    offset,
    message: err instanceof Error ? err.message : String(err),
  };
}

function reportWarning(
  reporter: ((warning: RunEventWriterWarning) => void) | undefined,
  warning: RunEventWriterWarning,
): void {
  try {
    reporter?.(warning);
  } catch {
    // Warning hooks are observability only. They must not turn a best-effort
    // append failure into a thrown runtime error.
  }
}

export function createRunEventWriter(options: RunEventWriterOptions): RunEventWriter {
  const append = options.append ?? defaultAppend;
  const truncate = options.truncate ?? defaultTruncate;
  const clock = options.clock ?? defaultClock;
  let nextSeq = normalizeNextSeq(options.nextSeq);
  let offset = normalizeOffset(options.initialOffset, options.eventsPath);

  return {
    append(input, appendOptions) {
      const reporter = appendOptions?.onWarning ?? options.onWarning;
      const envelope = buildEnvelope(options.runId, nextSeq, timestamp(clock), input);
      let line: string;
      try {
        line = `${JSON.stringify(envelope)}\n`;
      } catch (err) {
        const w = warning('serialize-failed', options.eventsPath, envelope, offset, err);
        reportWarning(reporter, w);
        return { ok: false, warning: w };
      }

      const lineBytes = Buffer.byteLength(line, 'utf8');
      const currentSize = readFileSize(options.eventsPath);
      if (currentSize > offset) {
        try {
          truncate(options.eventsPath, offset);
        } catch (err) {
          const w = warning('truncate-failed', options.eventsPath, envelope, offset, err);
          reportWarning(reporter, w);
          return { ok: false, warning: w };
        }
      } else if (currentSize < offset) {
        offset = currentSize;
      }

      try {
        append(options.eventsPath, line);
      } catch (err) {
        const w = warning('append-failed', options.eventsPath, envelope, offset, err);
        reportWarning(reporter, w);
        return { ok: false, warning: w };
      }

      const acceptedOffset = offset;
      offset += lineBytes;
      nextSeq += 1;
      return {
        ok: true,
        envelope,
        offset: acceptedOffset,
        lineBytes,
      };
    },
    nextSeq() {
      return nextSeq;
    },
    offset() {
      return offset;
    },
  };
}
