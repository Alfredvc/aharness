import { resolve } from 'node:path';

import { createRunEventWriter, type RunEventWriter, type RunEventWriterOptions } from './writer.js';
import { scanRunEvents } from './replay.js';
import { RUN_EVENT_SCHEMA, type RunEventAppendInput, type RunEventEnvelope } from './types.js';
import type { RunEventAppendResult, RunEventWriterWarning } from './writer.js';
import type { RunDir } from '../types.js';

export type RunEventRecorderWarningSink = NonNullable<RunEventWriterOptions['onWarning']>;
export type RunEventWriterFactory = (options: RunEventWriterOptions) => RunEventWriter;
type RunEventAppendFailure = Extract<RunEventAppendResult, { readonly ok: false }>;

export interface RunEventRecorderAppendOptions {
  readonly onWarning?: RunEventRecorderWarningSink;
}

export interface RunEventRecorder {
  readonly append: (
    input: RunEventAppendInput,
    options?: RunEventRecorderAppendOptions,
  ) => ReturnType<RunEventWriter['append']>;
  readonly nextSeq: () => number;
  readonly offset: () => number;
}

export interface GetRunEventRecorderOptions {
  readonly runId: string;
  readonly eventsPath: string;
  readonly writerFactory?: RunEventWriterFactory;
}

export interface AppendRunEventOptions extends RunEventRecorderAppendOptions {
  readonly writerFactory?: RunEventWriterFactory;
}

const recorders = new Map<string, RunEventRecorder>();
let writerFactoryForTesting: RunEventWriterFactory | undefined;

function recorderKey(runId: string, eventsPath: string): string {
  return `${runId}\0${resolve(eventsPath)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportWarning(
  reporter: RunEventRecorderWarningSink | undefined,
  warning: RunEventWriterWarning,
): void {
  try {
    reporter?.(warning);
  } catch {
    // Warning hooks are observability only and must not throw into runtime paths.
  }
}

function envelopeForWarning(
  runId: string,
  seq: number,
  input: RunEventAppendInput,
): RunEventEnvelope {
  return {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq,
    id: `${runId}:${seq}`,
    time: new Date().toISOString(),
    type: input.type,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.stateVisitId !== undefined ? { stateVisitId: input.stateVisitId } : {}),
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

function warningResult(
  runId: string,
  eventsPath: string,
  seq: number,
  offset: number,
  input: RunEventAppendInput,
  err: unknown,
): RunEventAppendFailure {
  return {
    ok: false,
    warning: {
      code: 'append-failed',
      message: `events.jsonl recorder unavailable: ${message(err)}`,
      eventsPath,
      offset,
      envelope: envelopeForWarning(runId, seq, input),
    },
  };
}

function formatReplayCorruption(scan: ReturnType<typeof scanRunEvents>): string {
  const diagnostic = scan.diagnostics.find((entry) => entry.severity === 'corruption');
  if (diagnostic === undefined) {
    return 'events.jsonl replay reported corruption';
  }
  const location = diagnostic.line !== undefined ? ` at line ${diagnostic.line}` : '';
  return `events.jsonl replay corruption${location}: ${diagnostic.code}: ${diagnostic.message}`;
}

function failedRecorder(
  options: GetRunEventRecorderOptions,
  err: unknown,
  state: { readonly nextSeq: number; readonly offset: number } = { nextSeq: 1, offset: 0 },
): RunEventRecorder {
  return {
    append(input, appendOptions) {
      const result = warningResult(
        options.runId,
        options.eventsPath,
        state.nextSeq,
        state.offset,
        input,
        err,
      );
      reportWarning(appendOptions?.onWarning, result.warning);
      return result;
    },
    nextSeq() {
      return state.nextSeq;
    },
    offset() {
      return state.offset;
    },
  };
}

function createRecorder(options: GetRunEventRecorderOptions): RunEventRecorder {
  let writer: RunEventWriter;
  try {
    const scan = scanRunEvents({ runId: options.runId, eventsPath: options.eventsPath });
    if (!scan.ok) {
      return failedRecorder(options, new Error(formatReplayCorruption(scan)), {
        nextSeq: scan.nextSeq,
        offset: scan.appendOffset,
      });
    }
    const factory = options.writerFactory ?? writerFactoryForTesting ?? createRunEventWriter;
    writer = factory({
      runId: options.runId,
      eventsPath: options.eventsPath,
      nextSeq: scan.nextSeq,
      initialOffset: scan.appendOffset,
    });
  } catch (err) {
    return failedRecorder(options, err);
  }

  return {
    append(input, appendOptions) {
      try {
        return writer.append(
          input,
          appendOptions?.onWarning !== undefined ? { onWarning: appendOptions.onWarning } : {},
        );
      } catch (err) {
        const result = warningResult(
          options.runId,
          options.eventsPath,
          writer.nextSeq(),
          writer.offset(),
          input,
          err,
        );
        reportWarning(appendOptions?.onWarning, result.warning);
        return result;
      }
    },
    nextSeq() {
      return writer.nextSeq();
    },
    offset() {
      return writer.offset();
    },
  };
}

export function getRunEventRecorder(options: GetRunEventRecorderOptions): RunEventRecorder {
  const key = recorderKey(options.runId, options.eventsPath);
  const existing = recorders.get(key);
  if (existing !== undefined) return existing;
  const recorder = createRecorder(options);
  recorders.set(key, recorder);
  return recorder;
}

export function appendRunEvent(
  runDir: RunDir,
  input: RunEventAppendInput,
  options: AppendRunEventOptions = {},
): ReturnType<RunEventWriter['append']> {
  return getRunEventRecorder({
    runId: runDir.runId,
    eventsPath: runDir.eventsPath,
    ...(options.writerFactory !== undefined ? { writerFactory: options.writerFactory } : {}),
  }).append(input, options);
}

/** @internal */
export function resetRunEventRecordersForTesting(): void {
  recorders.clear();
}

/** @internal */
export function setRunEventWriterFactoryForTesting(
  factory: RunEventWriterFactory | undefined,
): void {
  writerFactoryForTesting = factory;
  resetRunEventRecordersForTesting();
}
