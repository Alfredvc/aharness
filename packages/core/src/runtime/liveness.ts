/**
 * Daemon liveness heartbeat file.
 *
 * The daemon touches a file (`daemon.alive` by convention) on a fixed
 * interval so external supervisors — including the aharness CLI's own
 * stale-run detector — can decide whether a run directory's daemon is
 * still alive by reading the file's `mtime` and comparing it to the
 * configured tick interval.
 *
 * `close()` clears the timer and removes the file so a clean shutdown
 * leaves no false-positive heartbeat behind.
 *
 * Note: `setInterval`'s `.unref()` keeps the timer from holding the
 * Node event loop open, but it does not survive vitest's fake timers.
 * Tests that mock timers must call `handle.close()` explicitly in an
 * `afterEach` to avoid leaking the interval into other tests.
 */
import { unlinkSync, utimesSync, writeFileSync } from 'node:fs';

export interface LivenessOpts {
  readonly path: string;
  readonly intervalMs?: number;
}

export interface LivenessHandle {
  close(): void;
}

export function startLiveness(o: LivenessOpts): LivenessHandle {
  const interval = o.intervalMs ?? 5_000;
  writeFileSync(o.path, '');
  const t = setInterval(() => {
    try {
      const now = Date.now() / 1000;
      utimesSync(o.path, now, now);
    } catch {
      /* ignore — file may have been removed by close() racing the tick */
    }
  }, interval);
  t.unref?.();
  return {
    close() {
      clearInterval(t);
      try {
        unlinkSync(o.path);
      } catch {
        /* ignore — file may already be gone */
      }
    },
  };
}
