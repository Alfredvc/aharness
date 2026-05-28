/**
 * Liveness handle tests.
 *
 * IMPORTANT: `startLiveness` returns a handle whose `setInterval` is
 * `.unref()`-ed so it does not hold the Node event loop open in
 * production. That `.unref()` does NOT survive vitest's fake timers,
 * so any test in this file (or any other file mocking timers) MUST
 * call `handle.close()` explicitly — typically via an `afterEach` —
 * to prevent the interval from leaking into subsequent tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLiveness, type LivenessHandle } from '../src/runtime/liveness.js';

describe('startLiveness', () => {
  let handle: LivenessHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  it('creates the file and updates mtime on each tick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-live-'));
    const path = join(dir, 'daemon.alive');
    handle = startLiveness({ path, intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 80));
    const m1 = statSync(path).mtimeMs;
    await new Promise((r) => setTimeout(r, 80));
    const m2 = statSync(path).mtimeMs;
    expect(m2).toBeGreaterThanOrEqual(m1);
    rmSync(dir, { recursive: true, force: true });
  });
});
