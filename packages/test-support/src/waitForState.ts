/**
 * `waitForState` — polling helper for tests that need to wait until a
 * caller-supplied `getState()` reading satisfies a predicate.
 *
 * The polling loop itself is generic: any caller that has a `() => string`
 * snapshot accessor can reuse this helper. Keeping it small and free of
 * `AppHandle` coupling lets it serve state-machine fixtures without
 * depending on an app-server handle shape.
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
