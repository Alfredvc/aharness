/**
 * Integration smoke test for `startHeadlessApp` (Phase 1b Task 15).
 *
 * Boots a real codex `app-server` against a temp `CODEX_HOME`, opens
 * the WS-over-Unix client via `connectHeadlessWs`, sends `initialize`
 * (with `PHASE1_OPT_OUT_METHODS`) and `thread/start` (with
 * `dynamic_tools: [SUBMIT_TOOL]`), and confirms a follow-up JSON-RPC
 * round-trip (`mcpServerStatus/list`) succeeds against the live thread.
 *
 * Skip conditions: requires a `codex` binary on PATH; CI configurations
 * that build codex first set `AHARNESS_E2E_REAL_CODEX=1` (parity with
 * `cli.runCli.phase1.test.ts`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHeadlessApp } from '../src/index.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

describe.skipIf(!E2E_ENABLED)('startHeadlessApp', () => {
  let cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups = [];
  });

  it('boots, returns a threadId, and lets `mcpServerStatus/list` round-trip', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h-fx-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const app = await startHeadlessApp({ sockPath: join(tmp, 'app-server.sock') });
    cleanups.push(() => app.close());
    expect(typeof app.threadId).toBe('string');
    const res = await app.client.request('mcpServerStatus/list', {});
    expect(res).toBeTypeOf('object');
  });
});
