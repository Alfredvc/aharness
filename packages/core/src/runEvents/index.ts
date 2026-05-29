/**
 * Internal canonical run-event module barrel.
 *
 * This surface groups the Slice 0 storage, replay, and memory-index
 * primitives without exporting them from the public `@aharness/core` author
 * barrel. Later slices may import from this internal path when they cut the
 * runtime over to canonical JSONL, but current runtime behavior remains on the
 * legacy audit writer.
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
