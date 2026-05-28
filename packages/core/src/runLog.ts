/**
 * Plain-text run log — `<runDir>/run.log`.
 *
 * One line per observable runtime event so a human can `tail -f` the file
 * and follow what the daemon, hook pipe, submit dispatcher, and await
 * dispatcher are doing without parsing `events.jsonl` or the Chrome trace.
 *
 * The path is set once at daemon startup via `setRunLogPath`. Until set
 * (e.g. in tests that exercise these modules without a daemon), `log` is
 * a no-op so call sites can be unconditional. `resetRunLogForTesting`
 * resets the module-level slot between cases.
 *
 * Append is synchronous (`appendFileSync`) for the same reason as
 * `events.jsonl`: callers want the line on disk before they return, in
 * case the next thing they do crashes.
 */
import { appendFileSync } from 'node:fs';

/**
 * Module-level mutable state — this is intentional.
 *
 * Each daemon process runs a single Aharness run, so a process-global
 * slot is the right scope for the run log path. Threading a handle
 * through every call site (snapshot persister, hook pipe, submit
 * dispatcher, await dispatcher, artifact writer) would add noise
 * without buying anything: there is no second consumer in the same
 * process to disambiguate from.
 *
 * Tests that exercise these modules without a daemon must call
 * `resetRunLogForTesting()` between cases to avoid leaking state across
 * runs.
 *
 * @internal
 */
let runLogPath: string | null = null;

export function setRunLogPath(path: string): void {
  runLogPath = path;
}

/**
 * Test-only escape hatch. Resets the module-level path slot. Production
 * code should not call this; the daemon's lifecycle owns the slot from
 * `setRunLogPath` at boot through process exit.
 *
 * @internal
 */
export function resetRunLogForTesting(): void {
  runLogPath = null;
}

/**
 * Append one line. `parts` are stringified loosely:
 *   - strings pass through
 *   - everything else `JSON.stringify`'d, then truncated to 100 chars
 *     (with a `…` marker if cropped) so a giant payload preview cannot
 *     blow up the log line
 *
 * Output: `<ISO timestamp> <part1> <part2> ...\n`.
 */
export function log(...parts: unknown[]): void {
  if (runLogPath === null) return;
  const ts = new Date().toISOString();
  const line = ts + ' ' + parts.map(formatPart).join(' ') + '\n';
  try {
    appendFileSync(runLogPath, line);
  } catch {
    // Log writing must never throw into the runtime. If the file is
    // unwritable we silently drop — events.jsonl + trace remain.
  }
}

const PREVIEW_MAX = 100;

function formatPart(p: unknown): string {
  if (typeof p === 'string') return p;
  let s: string;
  try {
    s = JSON.stringify(p) ?? 'undefined';
  } catch {
    s = String(p);
  }
  if (s.length <= PREVIEW_MAX) return s;
  return s.slice(0, PREVIEW_MAX - 1) + '…';
}
