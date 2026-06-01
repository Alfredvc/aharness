import type { RunDir } from '../types.js';
import type { AppEvent, FrameworkNote, ReplayableAppEvent, RunMeta } from '../ui/events.js';
import type { UiEventLog } from '../ui/sse.js';
import { appEventToRunEventAppendInput, runLifecycleRow } from './adapter.js';
import { appendRunEvent, type RunEventRecorder } from './recorder.js';
import type { RunEventAppendInput, RunEventEnvelope, RunEventWithOffset } from './types.js';
import type { RunEventAppendResult, RunEventWriterWarning } from './writer.js';

export type LiveRunEventCanonicalAppendHook = (entry: RunEventWithOffset) => void | Promise<void>;

export interface LiveRunEventPublisherOptions {
  readonly runDir: RunDir;
  readonly runMeta: RunMeta;
  readonly uiEventLog: UiEventLog;
  readonly stderr: NodeJS.WritableStream;
  readonly onUiEvent?: (event: ReplayableAppEvent) => void;
  readonly onCanonicalAppend?: LiveRunEventCanonicalAppendHook;
  readonly recorder?: RunEventRecorder;
}

export interface RunTerminalInput {
  readonly state: string;
  readonly terminal: string;
}

export interface LiveRunEventPublisher {
  readonly publishRunStarted: () => void;
  readonly publishRunTerminal: (input: RunTerminalInput) => void;
  readonly publishRunFailed: (message: string) => void;
  readonly record: (input: RunEventAppendInput) => RunEventAppendResult;
  readonly publish: (event: AppEvent) => ReplayableAppEvent;
  readonly publishNonRecording: (event: AppEvent) => ReplayableAppEvent;
}

function warningMessage(warning: RunEventWriterWarning): string {
  return `aharness: events.jsonl append failed (${warning.code}) for ${warning.envelope.type}: ${warning.message}\n`;
}

function hookFailureMessage(entry: RunEventWithOffset, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `aharness: live run-event hook failed for ${entry.event.type}: ${message}\n`;
}

function appendWithRecorder(
  options: LiveRunEventPublisherOptions,
  input: RunEventAppendInput,
  onWarning: (warning: RunEventWriterWarning) => void,
): RunEventAppendResult {
  if (options.recorder !== undefined) {
    return options.recorder.append(input, { onWarning });
  }
  return appendRunEvent(options.runDir, input, { onWarning });
}

function directPublish(
  uiEventLog: UiEventLog,
  onUiEvent: ((event: ReplayableAppEvent) => void) | undefined,
  event: AppEvent,
): ReplayableAppEvent {
  const published = uiEventLog.publish(event);
  onUiEvent?.(published);
  return published;
}

function warningNote(envelope: RunEventEnvelope, warningSeq: number): FrameworkNote {
  return {
    kind: 'FrameworkNote',
    id: `run-event-warning-${warningSeq}`,
    text: `events.jsonl append failed for ${envelope.type}; live browser state may include events absent from replay.`,
    variant: 'warn',
  };
}

function notifyCanonicalAppend(
  options: LiveRunEventPublisherOptions,
  result: Extract<RunEventAppendResult, { readonly ok: true }>,
): void {
  const hook = options.onCanonicalAppend;
  if (hook === undefined) return;

  const entry: RunEventWithOffset = {
    event: result.envelope,
    offset: result.offset,
    lineBytes: result.lineBytes,
  };

  try {
    const maybePromise = hook(entry);
    if (maybePromise !== undefined) {
      void Promise.resolve(maybePromise).catch((err: unknown) => {
        options.stderr.write(hookFailureMessage(entry, err));
      });
    }
  } catch (err) {
    options.stderr.write(hookFailureMessage(entry, err));
  }
}

export function createLiveRunEventPublisher(
  options: LiveRunEventPublisherOptions,
): LiveRunEventPublisher {
  let warningSeq = 0;

  function reportWarning(warning: RunEventWriterWarning): void {
    warningSeq += 1;
    options.stderr.write(warningMessage(warning));
    directPublish(options.uiEventLog, options.onUiEvent, warningNote(warning.envelope, warningSeq));
  }

  function append(input: RunEventAppendInput): RunEventAppendResult {
    let reported = false;
    const result = appendWithRecorder(options, input, (warning) => {
      reported = true;
      reportWarning(warning);
    });
    if (!result.ok && !reported) {
      reportWarning(result.warning);
    }
    if (result.ok) {
      notifyCanonicalAppend(options, result);
    }
    return result;
  }

  return {
    publishRunStarted() {
      append({
        type: 'run.started',
        ...(options.runMeta.threadId ? { threadId: options.runMeta.threadId } : {}),
        data: {
          runId: options.runMeta.runId,
          threadId: options.runMeta.threadId,
          repoRoot: options.runMeta.repoRoot,
          fsmFile: options.runMeta.fsmFile,
          fsmHash6: options.runMeta.fsmHash6,
          codexPin: options.runMeta.codexPin,
          startedAt: options.runMeta.startedAt,
          row: runLifecycleRow({
            event: 'run.started',
            status: 'started',
            summary: 'Run started',
          }),
        },
      });
    },
    publishRunTerminal(input) {
      append({
        type: input.terminal === 'failure' ? 'run.failed' : 'run.completed',
        data: {
          state: input.state,
          terminal: input.terminal,
          status: input.terminal,
          row: runLifecycleRow({
            event: input.terminal === 'failure' ? 'run.failed' : 'run.completed',
            status: input.terminal === 'failure' ? 'failed' : 'completed',
            summary: `Run ${input.terminal === 'failure' ? 'failed' : 'completed'} at ${input.state}`,
          }),
        },
      });
    },
    publishRunFailed(message) {
      append({
        type: 'run.failed',
        data: {
          status: 'failed',
          message,
          row: runLifecycleRow({
            event: 'run.failed',
            status: 'failed',
            summary: 'Run failed',
          }),
        },
      });
    },
    record(input) {
      return append(input);
    },
    publish(event) {
      const input = appEventToRunEventAppendInput(event);
      if (input !== null) append(input);
      return directPublish(options.uiEventLog, options.onUiEvent, event);
    },
    publishNonRecording(event) {
      return directPublish(options.uiEventLog, options.onUiEvent, event);
    },
  };
}
