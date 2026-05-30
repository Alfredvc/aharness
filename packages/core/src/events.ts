/**
 * Canonical event-log compatibility writer.
 *
 * `<runDir>/events.jsonl` is best-effort canonical `aharness.event.v1`
 * storage for new runtime writes, **not a durability primitive**.
 * Lines are atomic per-write under POSIX `O_APPEND` only when ≤PIPE_BUF
 * (typically 4 KiB on Linux, 512 B on macOS for pipes; for regular files
 * most kernels still serialize append-mode writes, but this is filesystem-
 * dependent). Readers should tolerate truncated tails. The writer does
 * not fsync; lost trailing entries on hard crash are acceptable for an
 * append-only transcript. New-run UI/history/replay rebuilds from
 * canonical JSONL, not `snapshot.json`.
 *
 * `appendEventEntry` keeps the legacy public input union callable while
 * mapping every input to a canonical envelope before it lands on disk:
 *
 *   - `hook`        — compatibility input for hook dispatchers and hook
 *                     clients.
 *                     The raw payload is hashed (SHA-256) rather than
 *                     stored, so secrets in hook inputs do not leak into
 *                     the log.
 *   - `submit`      — compatibility input for `aharness_submit`
 *                     dynamic-tool handling. Payload is **not** logged
 *                     (may contain owner prose); only `accepted` and an
 *                     optional `error` summary (capped at 1024 bytes
 *                     UTF-8) are written.
 *   - `transition`  — reserved variant; no @aharness/core caller currently
 *                     emits it. (The CC-era inspector-driven persister
 *                     was the only emitter.)
 *   - `artifact`    — emitted by `writeArtifact` as `artifact.written`.
 *   - `terminal`    — compatibility input for terminal completion; the
 *                     live runtime path writes terminal/run completion
 *                     through the canonical live publisher.
 *   - `abandonedThreadResidue`
 *                   — emitted when an old thread produces post-clear
 *                     residue. The entry records only a thread id, source,
 *                     and capped summary message.
 *
 * The SDK provides a write-only surface; downstream tooling reads it
 * directly.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from './internal/canonicalJson.js';
import {
  appendRunEvent,
  legacyEventInputToRunEventAppendInput,
  type RunEventEnvelope,
  type RunEventWriterWarning,
} from './runEvents/index.js';
import { log as runLog } from './runLog.js';
import type { RunDir } from './types.js';

/** Legacy public input union. New persisted lines are canonical envelopes. */
export type EventLogEntryInput =
  | { kind: 'hook'; name: string; payloadDigest: string }
  | { kind: 'submit'; stateId: string; accepted: boolean; error?: string }
  | { kind: 'transition'; from: string; to: string; eventType: string }
  | { kind: 'artifact'; relPath: string; bytes: number }
  | { kind: 'terminal'; state: string; terminal: string }
  | { kind: 'abandonedThreadResidue'; threadId: string; source: string; message: string };

/** @deprecated New writes persist `RunEventEnvelope` lines, not `{ts, kind}` audit entries. */
export type EventLogEntry = RunEventEnvelope;

/** Maximum UTF-8 byte length for the `error` field on a `submit` entry. */
const SUBMIT_ERROR_MAX_BYTES = 1024;
const ABANDONED_THREAD_RESIDUE_SOURCE_MAX_BYTES = 128;
const ABANDONED_THREAD_RESIDUE_MESSAGE_MAX_BYTES = 512;
/** Suffix appended when the error string is truncated. ASCII-safe. */
const TRUNCATION_MARKER = '…[truncated]';

/**
 * Truncate `s` to at most `maxBytes` of UTF-8, appending
 * `TRUNCATION_MARKER` when truncation actually occurs. Cuts on a Unicode
 * code-point boundary (no half-emoji), not necessarily a grapheme
 * boundary — we just need a valid UTF-8 string that fits the byte cap.
 *
 * Uses `TextDecoder` in `fatal: true` mode and steps the slice back one
 * byte at a time until decoding succeeds, so we never inspect U+FFFD —
 * which could be a legitimate character in `s`.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  const markerBytes = enc.encode(TRUNCATION_MARKER).length;
  const headCap = Math.max(0, maxBytes - markerBytes);
  const fatalDec = new TextDecoder('utf-8', { fatal: true });
  // Shrink one byte at a time until the slice is valid UTF-8. UTF-8
  // continuation bytes are 10xxxxxx; at most three steps are needed for
  // a 4-byte code point, but we keep it generic.
  let take = headCap;
  while (take > 0) {
    try {
      return fatalDec.decode(bytes.slice(0, take)) + TRUNCATION_MARKER;
    } catch {
      take -= 1;
    }
  }
  return TRUNCATION_MARKER;
}

/**
 * Append one legacy compatibility input to `<runDir>/events.jsonl` as a
 * canonical `aharness.event.v1` envelope. Synchronous — the accepted line
 * lands before the function returns. We use synchronous I/O here on purpose:
 * callers want the log to outlive a crash that comes immediately after the
 * operation they're recording.
 *
 * For `submit` entries, the optional `error` string is capped at 1024
 * UTF-8 bytes; over-cap inputs are sliced and suffixed with
 * `…[truncated]` so a runaway ajv message cannot blow up the event log.
 */
export function appendEventEntry(runDir: RunDir, entryInput: EventLogEntryInput): void {
  let normalized: EventLogEntryInput = entryInput;
  if (entryInput.kind === 'submit' && typeof entryInput.error === 'string') {
    normalized = {
      ...entryInput,
      error: truncateUtf8(entryInput.error, SUBMIT_ERROR_MAX_BYTES),
    };
  } else if (entryInput.kind === 'abandonedThreadResidue') {
    normalized = {
      ...entryInput,
      source: truncateUtf8(entryInput.source, ABANDONED_THREAD_RESIDUE_SOURCE_MAX_BYTES),
      message: truncateUtf8(entryInput.message, ABANDONED_THREAD_RESIDUE_MESSAGE_MAX_BYTES),
    };
  }

  let reported = false;
  const result = appendRunEvent(runDir, legacyEventInputToRunEventAppendInput(normalized), {
    onWarning: (warning) => {
      reported = true;
      reportAppendWarning(warning);
    },
  });
  if (!result.ok && !reported) {
    reportAppendWarning(result.warning);
  }
}

function reportAppendWarning(warning: RunEventWriterWarning): void {
  runLog('events.append-failed', {
    code: warning.code,
    err: warning.message,
    eventType: warning.envelope.type,
  });
}

/**
 * SHA-256 of the canonical JSON encoding of a hook payload. Used by
 * the hook dispatcher: rather than logging the raw payload (which may
 * contain prompts, file contents, or owner prose), we log a stable
 * digest so a replay tool can match a recorded event against a live
 * one without exposing its contents.
 *
 * Canonicalisation: `JSON.stringify` with sorted object keys, recursive.
 * Arrays preserve their order. Non-finite numbers and `undefined` are
 * omitted (matching `JSON.stringify` semantics).
 */
export function digestHookPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
