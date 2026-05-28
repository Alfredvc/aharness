/**
 * `currentState` — synchronous snapshot of the daemon's FSM state id.
 * Phase-4 wiring required; stubbed for now so the test-support barrel can
 * be consumed by downstream tasks that depend on the type signature.
 */

import type { AppHandle } from './startApp.js';

export function currentState(_app: AppHandle): string {
  throw new Error('currentState: requires phase-4 daemon wiring');
}
