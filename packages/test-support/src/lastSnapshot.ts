/**
 * `lastSnapshot` — return the most recently persisted XState snapshot for
 * the daemon driving this app handle. Phase-4 wiring required; stubbed
 * here so the barrel exports are stable.
 */

import type { AppHandle } from './startApp.js';

export function lastSnapshot(_app: AppHandle): unknown {
  throw new Error('lastSnapshot: requires phase-4 daemon wiring');
}
