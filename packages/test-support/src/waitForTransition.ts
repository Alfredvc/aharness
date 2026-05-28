/**
 * `waitForTransition` — block until the daemon's FSM enters a state that
 * satisfies `predicate`. Phase-4 wiring (the daemon plug-in) is required
 * before this helper can read live state; the stub here keeps the surface
 * stable for tests that compile against the barrel today.
 */

import type { AppHandle } from './startApp.js';

export function waitForTransition(
  _app: AppHandle,
  _predicate: (state: string) => boolean,
): Promise<string> {
  return Promise.reject(new Error('waitForTransition: requires phase-4 daemon wiring'));
}
