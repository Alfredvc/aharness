/**
 * End-to-end coverage for `clearOnEntry` fresh-clear lowering.
 *
 * These cases follow the existing real-codex integration-test gate.
 * Unit-level CLI and runtime tests cover the deterministic clear-window
 * and resume atomicity paths; this file exercises the happy path against
 * a real codex app-server when explicitly enabled.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCliForTest } from '../src/cli/runCli.js';
import { METHOD } from '../src/protocol/methodNames.js';
import { fsmHash6 } from '../src/run.js';
import { connectHeadlessWs } from '../src/transport/wsClient.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

describe.skipIf(!E2E_ENABLED)('runCli - fresh clear clearWalk (end-to-end)', () => {
  let cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
    cleanups = [];
  });

  it('walks a -> b, replaces the parent thread, re-orients, and reaches terminal', async () => {
    const { startMockModel, CLEAR_WALK_FSM_SOURCE, buildClearWalkSubmitTurn } =
      await import('@aharness/test-support');

    const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-clear-'));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    writeFileSync(join(repoRoot, 'clearWalk.fsm.ts'), CLEAR_WALK_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    mock.queueTurn(buildClearWalkSubmitTurn('a', 'next', { note: 'go' }));
    mock.queueTurn(buildClearWalkSubmitTurn('b', 'done', { ok: true }));

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = {
      write(c: string | Uint8Array): boolean {
        stdoutChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stderr = {
      write(c: string | Uint8Array): boolean {
        stderrChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const recorded: Array<{ readonly method: string; readonly params: unknown }> = [];
    const connectWithSpy: typeof connectHeadlessWs = async (opts) => {
      const handle = await connectHeadlessWs(opts);
      handle.client.onOutboundRequest((method, params) => {
        recorded.push({ method, params });
      });
      return handle;
    };

    const result = await runCliForTest({
      fsmPath: 'clearWalk.fsm.ts',
      cwd: repoRoot,
      stderr,
      stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
      authJsonExists: () => true,
      _testMockModelBaseUrl: mock.baseUrl,
      connectHeadlessWsImpl: connectWithSpy,
    });

    expect(result.exitCode, `stderr: ${stderrChunks.join('')}`).toBe(0);

    const unsubscribeIndex = recorded.findIndex((r) => r.method === METHOD.threadUnsubscribe);
    const clearThreadStartIndex = recorded.findIndex(
      (r) =>
        r.method === METHOD.threadStart &&
        JSON.stringify(r.params).includes('"sessionStartSource":"clear"'),
    );
    const postClearTurnStartIndex = recorded.findIndex(
      (r, i) =>
        i > clearThreadStartIndex &&
        r.method === METHOD.turnStart &&
        JSON.stringify(r.params).includes('CLEAR_WALK_STATE_B_MARKER'),
    );
    expect(unsubscribeIndex).toBeGreaterThanOrEqual(0);
    expect(clearThreadStartIndex).toBeGreaterThan(unsubscribeIndex);
    expect(postClearTurnStartIndex).toBeGreaterThan(clearThreadStartIndex);
    expect(recorded[unsubscribeIndex]?.params).toMatchObject({
      threadId: expect.any(String),
    });

    const runRoot = join(repoRoot, '.aharness', 'runs');
    const runPrefix = `${fsmHash6(join(repoRoot, 'clearWalk.fsm.ts'))}-`;
    const runId = readdirSync(runRoot).find((entry) => entry.startsWith(runPrefix));
    expect(runId).toBeDefined();
    const snapshot = JSON.parse(
      readFileSync(join(runRoot, runId!, 'snapshot.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(snapshot.pendingClear).toBeUndefined();
    expect(snapshot.turnsSinceLastClear).toBeUndefined();
    expect(snapshot.clearWindowEntries).toBeUndefined();
  }, 30_000);
});
