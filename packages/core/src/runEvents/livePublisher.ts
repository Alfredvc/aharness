import type { RunDir } from '../types.js';
import type { AppEvent, FrameworkNote, ReplayableAppEvent, RunMeta } from '../ui/events.js';
import type { UiEventLog } from '../ui/sse.js';
import { appEventToRunEventAppendInput } from './adapter.js';
import { appendRunEvent, type RunEventRecorder } from './recorder.js';
import type { RunEventAppendInput, RunEventEnvelope } from './types.js';
import type { RunEventAppendResult, RunEventWriterWarning } from './writer.js';

export interface LiveRunEventPublisherOptions {
  readonly runDir: RunDir;
  readonly runMeta: RunMeta;
  readonly uiEventLog: UiEventLog;
  readonly stderr: NodeJS.WritableStream;
  readonly onUiEvent?: (event: ReplayableAppEvent) => void;
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
  readonly publish: (event: AppEvent) => ReplayableAppEvent;
  readonly publishNonRecording: (event: AppEvent) => ReplayableAppEvent;
}

function warningMessage(warning: RunEventWriterWarning): string {
  return `aharness: events.jsonl append failed (${warning.code}) for ${warning.envelope.type}: ${warning.message}\n`;
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

export function createLiveRunEventPublisher(
  options: LiveRunEventPublisherOptions,
): LiveRunEventPublisher {
  let warningSeq = 0;

  function reportWarning(warning: RunEventWriterWarning): void {
    warningSeq += 1;
    options.stderr.write(warningMessage(warning));
    directPublish(options.uiEventLog, options.onUiEvent, warningNote(warning.envelope, warningSeq));
  }

  function append(input: RunEventAppendInput): void {
    let reported = false;
    const result = appendWithRecorder(options, input, (warning) => {
      reported = true;
      reportWarning(warning);
    });
    if (!result.ok && !reported) {
      reportWarning(result.warning);
    }
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
        },
      });
    },
    publishRunFailed(message) {
      append({
        type: 'run.failed',
        data: {
          status: 'failed',
          message,
        },
      });
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
