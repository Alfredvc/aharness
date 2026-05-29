/**
 * Internal canonical run-event module barrel.
 *
 * This surface groups the canonical storage, replay, memory-index, and live
 * runtime adapter primitives without exporting them from the public
 * `@aharness/core` author barrel.
 */
export {
  RUN_EVENT_SCHEMA,
  type RunEventAggregateStats,
  type RunEventAppendInput,
  type RunEventCompactRow,
  type RunEventCorrelationFields,
  type RunEventDiagnosticCode,
  type RunEventDiagnosticSeverity,
  type RunEventEnvelope,
  type RunEventPage,
  type RunEventPayload,
  type RunEventPendingRequestSummary,
  type RunEventRange,
  type RunEventReplayDiagnostic,
  type RunEventReplayResult,
  type RunEventRowPage,
  type RunEventStateVisit,
  type RunEventWithOffset,
} from './types.js';
export {
  createRunEventWriter,
  type RunEventAppendOptions,
  type RunEventAppendIo,
  type RunEventAppendResult,
  type RunEventTruncateIo,
  type RunEventWriter,
  type RunEventWriterClock,
  type RunEventWriterOptions,
  type RunEventWriterWarning,
} from './writer.js';
export { replayRunEvents, scanRunEvents, type ReplayRunEventsOptions } from './replay.js';
export {
  buildRunEventIndex,
  type BuildRunEventIndexOptions,
  type EventPageQuery,
  type RowPageQuery,
  type RunEventIndex,
} from './indexer.js';
export { appEventToRunEventAppendInput, legacyEventInputToRunEventAppendInput } from './adapter.js';
export {
  appendRunEvent,
  getRunEventRecorder,
  resetRunEventRecordersForTesting,
  setRunEventWriterFactoryForTesting,
  type AppendRunEventOptions,
  type GetRunEventRecorderOptions,
  type RunEventRecorder,
  type RunEventRecorderAppendOptions,
  type RunEventRecorderWarningSink,
  type RunEventWriterFactory,
} from './recorder.js';
export {
  createLiveRunEventPublisher,
  type LiveRunEventPublisher,
  type LiveRunEventPublisherOptions,
  type RunTerminalInput,
} from './livePublisher.js';
