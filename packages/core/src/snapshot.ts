/**
 * Legacy snapshot load helper.
 *
 * `loadSnapshot(runDir)` reads and parses `<runDir>/snapshot.json`,
 * returning `{ xstate, injectedSkills }` or `null` if the file does not
 * exist. Runtime startup and UI/history/replay do not call this helper
 * for new runs; `events.jsonl` is the source of truth.
 *
 * The legacy write side lives in `runtime/snapshotFlush.ts:flushSnapshot`
 * (tmp + fsync + rename, synchronous). On-disk envelope shape:
 *   `{ xstate: <persistedSnapshot>, injectedSkills?: string[] }`
 *
 * Legacy shape (pre-envelope, on-disk only):
 *   `<persistedSnapshot>` — no enclosing object. Detected by the
 *   absence of an `xstate` key on a plain object root, in which case
 *   the whole parsed value is treated as the XState slice. New writes
 *   always emit the envelope, so a single round-trip migrates the file.
 */
import { existsSync, readFileSync } from 'node:fs';

import { log as runLog } from './runLog.js';
import type { RunDir } from './types.js';

/**
 * Parsed snapshot returned by `loadSnapshot`. The `xstate` slice is
 * opaque (it's the JSON-parsed `actor.getPersistedSnapshot()` value).
 */
export interface Snapshot {
  readonly xstate: unknown;
  /**
   * Run-level set of skill keys that have already been injected into
   * the model's context this run. Each entry is a stable
   * `name:<n>` / `path:<absPath>` key. Persisted in the snapshot
   * envelope so in-run snapshot inspection can show what has already
   * been sent to the model context. Absent ⇒ empty set.
   */
  readonly injectedSkills: ReadonlyArray<string>;
}

export function loadSnapshot(runDir: RunDir): Snapshot | null {
  if (!existsSync(runDir.snapshotPath)) return null;
  let parsed: unknown;
  try {
    const raw = readFileSync(runDir.snapshotPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    runLog('snapshot.load-failed', err instanceof Error ? err.message : String(err));
    return null;
  }
  if (isEnvelope(parsed)) {
    const rawInjected = parsed.injectedSkills;
    const injectedSkills =
      Array.isArray(rawInjected) && rawInjected.every((k) => typeof k === 'string')
        ? (rawInjected as ReadonlyArray<string>)
        : [];
    return {
      xstate: parsed.xstate,
      injectedSkills,
    };
  }
  // Legacy: the whole file is the XState slice (no envelope).
  return { xstate: parsed, injectedSkills: [] };
}

function isEnvelope(value: unknown): value is {
  xstate: unknown;
  injectedSkills?: unknown;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'xstate')
  );
}
