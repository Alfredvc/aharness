/**
 * `waitForState` — polling helper for tests that need to wait until a
 * caller-supplied `getState()` reading satisfies a predicate.
 *
 * Per R17 of the codex-migration plan: e2e tests (Task 21+) drive the daemon
 * by polling its current state and asserting transitions, but the polling
 * loop itself is generic — any caller that has a `() => string` snapshot
 * accessor can reuse this helper. Keeping it small and free of `AppHandle`
 * coupling means the same primitive serves the daemon-aware
 * `waitForTransition` (phase 4) and other state-machine fixtures alike.
 *
 * Behaviour:
 *
 * - Polls every 10ms, returning the first state that satisfies the predicate.
 * - Throws after `timeoutMs` (default 2s) including the most recently
 *   observed state in the error message — this turns flaky polls into
 *   diagnosable failures rather than silent hangs.
 */
export async function waitForState(
  getState: () => string,
  predicate: (s: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = getState();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitForState: timed out, last state=${getState()}`);
}
