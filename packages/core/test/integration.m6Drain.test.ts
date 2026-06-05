/**
 * Phase 2a integration test — M6 drain-then-interrupt port.
 *
 * Promotes `scripts/spikes/m6-turn-interrupt-ordering.mjs` mode
 * `drain-then-interrupt` into the vitest suite so the cross-state dance's
 * production wire shape is locked under CI, not only in the one-off spike
 * script. Per the spike, mode `interrupt-mid` is the wire-inverted failure
 * mode and is NOT what we port — only the drain-then-interrupt path is
 * production-equivalent and only that path passed 50/50 in the spike.
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-2a-cross-state.md` §Task 6.
 *
 * What this exercises:
 *   - Boots the full Phase 2a stack via `runCliForTest` against a real
 *     codex `app-server` + local mock-model HTTP server.
 *   - Mock-model queues two cross-state turns:
 *       Turn 1: `aharness_submit(a, next, {note})` — drives a → b; the
 *               dispatcher schedules the cross-state dance
 *               (`wait-for-item-completed → turn/interrupt →
 *               turn/start({input: <state-b nudge>})`).
 *       Turn 2: `aharness_submit(b, done, {ok})` — drives b → c; the
 *               dispatcher's terminal branch fires and the run exits 0.
 *
 * Assertions per iteration:
 *   (a) Zero stray `item/completed` ServerNotifications arrive between
 *       `turn/interrupt` resolving (= `TurnAborted` per CF-1 — the await
 *       IS the abort-confirmed signal) and the dance's `turn/start` send.
 *       The spike's settle-window framework is unnecessary here because
 *       the aharness's dance issues `turn/start` immediately after the
 *       interrupt resolves; any `item/completed` arriving in that gap is
 *       a stray from the aborted turn (M6 50/50 in the spike → 5/5 here).
 *   (b) Rollout JSONL inspection: every `function_call` is paired with a
 *       matching `function_call_output`. (M6 invariant (c).)
 *
 * Skip gate matches `cli.runCli.phase1.test.ts:54` — requires the
 * `codex` binary on PATH plus `AHARNESS_E2E_REAL_CODEX=1` so CI without
 * the binary skips cleanly. Loops 5× via `it.each`; the spike's 50×
 * stays in the one-off script for pre-merge manual verification.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCliForTest } from '../src/cli/runCli.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type { ThreadStartResponse } from '../src/protocol/types.js';
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

interface RequestRecord {
  readonly method: string;
  readonly params: unknown;
  readonly tSent: number;
  tResolved: number | null;
}

interface NotificationRecord {
  readonly method: string;
  readonly params: unknown;
  readonly tReceived: number;
}

/**
 * Find the rollout JSONL file matching `threadId` written after
 * `runStartEpochMs`. Codex writes to
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl`.
 * Mirror `scripts/spikes/m6-turn-interrupt-ordering.mjs::findRolloutFile`
 * — recursive walk + mtime filter, prefer filename match on threadId.
 */
function findRolloutForThread(threadId: string, runStartEpochMs: number): string | null {
  const root = join(homedir(), '.codex', 'sessions');
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const candidates: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let s;
        try {
          s = statSync(p);
        } catch {
          continue;
        }
        if (s.mtimeMs < runStartEpochMs) continue;
        candidates.push(p);
      }
    }
  }
  // Prefer filename containing the threadId.
  const named = candidates.filter((p) => p.includes(threadId));
  if (named.length > 0) return named[0]!;
  // Fall back to content match on the threadId in the first 4 KiB.
  for (const p of candidates) {
    try {
      const head = readFileSync(p, 'utf8').slice(0, 4096);
      if (head.includes(threadId)) return p;
    } catch {
      /* unreadable, skip */
    }
  }
  return null;
}

/**
 * Mirror `scripts/spikes/m6-turn-interrupt-ordering.mjs::inspectRollout`:
 * recursively walk every JSON value in the rollout, collecting `call_id`s
 * for `function_call` and `function_call_output` ResponseItems. The
 * rollout wraps items under varying outer keys (codex internal vs. the
 * Responses-API wire shape); we only care about the inner discriminator.
 */
function inspectRollout(path: string): {
  fnCallIds: string[];
  fnOutputIds: string[];
  dangling: string[];
} {
  const txt = readFileSync(path, 'utf8');
  const fnCallIds = new Set<string>();
  const fnOutputIds = new Set<string>();
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (typeof obj['type'] === 'string' && typeof obj['call_id'] === 'string') {
      if (obj['type'] === 'function_call') fnCallIds.add(obj['call_id']);
      else if (obj['type'] === 'function_call_output') fnOutputIds.add(obj['call_id']);
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    visit(obj);
  }
  const dangling: string[] = [];
  for (const id of fnCallIds) {
    if (!fnOutputIds.has(id)) dangling.push(id);
  }
  return { fnCallIds: [...fnCallIds], fnOutputIds: [...fnOutputIds], dangling };
}

describe.skipIf(!E2E_ENABLED)('runCli — Phase 2a M6 drain-then-interrupt port', () => {
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

  it.each([1, 2, 3, 4, 5])(
    'iteration %d — no stray item/completed between TurnAborted and dance turn/start; rollout function_call ↔ function_call_output paired',
    async () => {
      // Deferred imports — mirror `integration.crossStateWalk.test.ts`:
      // keep test-support helper initialization out of file-load for
      // skipped real-Codex E2E tests.
      const { startMockModel, CROSS_STATE_WALK_FSM_SOURCE, buildCrossStateSubmitTurn } =
        await import('@aharness/test-support');

      const runStartEpochMs = Date.now() - 1_000; // 1s margin for clock skew.

      const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-m6-'));
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));

      const fsmPath = join(repoRoot, 'crossStateWalk.fsm.ts');
      writeFileSync(fsmPath, CROSS_STATE_WALK_FSM_SOURCE);

      const mock = await startMockModel();
      cleanups.push(() => mock.close());
      mock.queueTurn(buildCrossStateSubmitTurn('a', 'next', { note: 'hi' }));
      mock.queueTurn(buildCrossStateSubmitTurn('b', 'done', { ok: true }));

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

      // Spy on outbound `request(method, params)` calls AND inbound
      // notifications. We need outbound timestamps (`turn/interrupt`
      // resolved time, `turn/start` send time) and inbound timestamps
      // (`item/completed`) on the same monotonic clock to assert the
      // no-stray ordering invariant.
      const requests: RequestRecord[] = [];
      const notifications: NotificationRecord[] = [];
      let capturedThreadId: string | null = null;

      const connectWithSpy: typeof connectHeadlessWs = async (opts) => {
        const handle = await connectHeadlessWs(opts);
        // Note: `initialize` (sent inside `connectHeadlessWs` before
        // return) is NOT observed by these hooks; none of these tests
        // assert on it.
        handle.client.onOutboundRequest((method, params) => {
          requests.push({ method, params, tSent: Date.now(), tResolved: null });
        });
        handle.client.onOutboundResponse((method, _params, outcome) => {
          // Stamp the most-recent matching unresolved `requests` entry
          // (FIFO degenerate here — each method we time is issued at
          // most once per relevant window).
          for (let i = requests.length - 1; i >= 0; i--) {
            const rec = requests[i]!;
            if (rec.method === method && rec.tResolved === null) {
              rec.tResolved = Date.now();
              break;
            }
          }
          // `thread/start` response carries the parent threadId we
          // need for rollout lookup. Reading from the same response
          // object the production code consumes avoids any reliance
          // on `thread/started`-notification ordering vs the response.
          if (
            method === METHOD.threadStart &&
            outcome.ok &&
            capturedThreadId === null &&
            outcome.result !== null &&
            typeof outcome.result === 'object'
          ) {
            const r = outcome.result as ThreadStartResponse;
            if (r.thread && typeof r.thread.id === 'string') {
              capturedThreadId = r.thread.id;
            }
          }
        });

        // Subscribe to inbound notifications on the SAME client. The
        // JsonRpcClient supports multiple subscribers per method (see
        // `jsonrpc/client.ts:82-87`), so adding our handler does not
        // interfere with the production `notificationRouter`'s.
        handle.client.onNotification(METHOD.itemCompleted, (params) => {
          notifications.push({
            method: METHOD.itemCompleted,
            params,
            tReceived: Date.now(),
          });
        });
        return handle;
      };

      const result = await runCliForTest({
        fsmPath: 'crossStateWalk.fsm.ts',
        cwd: repoRoot,
        stderr,
        stdout,
        verify: async () => ({ exitCode: 0 }),
        versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
        authJsonExists: () => true,
        _testMockModelBaseUrl: mock.baseUrl,
        connectHeadlessWsImpl: connectWithSpy,
      });

      expect(
        result.exitCode,
        `stderr: ${stderrChunks.join('')}\nstdout: ${stdoutChunks.join('')}`,
      ).toBe(0);

      // ---- Assertion (a): no stray item/completed between
      // turn/interrupt's resolve and the dance's turn/start send ----
      const interrupts = requests.filter((r) => r.method === METHOD.turnInterrupt);
      expect(
        interrupts.length,
        `expected exactly one turn/interrupt across the a→b transition; saw ${interrupts.length}`,
      ).toBe(1);
      const interrupt = interrupts[0]!;
      expect(interrupt.tResolved, 'turn/interrupt did not resolve').not.toBeNull();

      // The cross-state dance's `turn/start` is the FIRST `turn/start`
      // request issued AFTER `turn/interrupt`'s send time. The kickoff
      // `turn/start` from boot runs before `turn/interrupt`; only the
      // dance's `turn/start` lands after.
      const danceTurnStart = requests.find(
        (r) => r.method === METHOD.turnStart && r.tSent > interrupt.tSent,
      );
      expect(
        danceTurnStart,
        `expected a turn/start after turn/interrupt; saw turn/start requests at: ${requests
          .filter((r) => r.method === METHOD.turnStart)
          .map((r) => r.tSent)
          .join(',')}`,
      ).toBeDefined();

      const strayCompleted = notifications.filter(
        (n) =>
          n.method === METHOD.itemCompleted &&
          n.tReceived > interrupt.tResolved! &&
          n.tReceived < danceTurnStart!.tSent,
      );
      expect(
        strayCompleted.length,
        `expected zero item/completed between turn/interrupt resolve (${interrupt.tResolved}) and dance turn/start (${danceTurnStart!.tSent}); saw ${strayCompleted.length}: ${JSON.stringify(strayCompleted.map((n) => n.tReceived))}`,
      ).toBe(0);

      // ---- Assertion (b): rollout function_call ↔ function_call_output paired ----
      expect(capturedThreadId, 'no threadId captured from thread/start').not.toBeNull();
      const rolloutPath = findRolloutForThread(capturedThreadId!, runStartEpochMs);
      expect(
        rolloutPath,
        `no rollout JSONL found for threadId=${capturedThreadId} under ~/.codex/sessions/ (mtime > ${runStartEpochMs})`,
      ).not.toBeNull();
      const { fnCallIds, dangling } = inspectRollout(rolloutPath!);
      expect(
        fnCallIds.length,
        `expected at least one function_call in rollout ${rolloutPath}`,
      ).toBeGreaterThan(0);
      expect(
        dangling,
        `dangling function_call ids (no matching function_call_output) in rollout ${rolloutPath}: ${JSON.stringify(dangling)}`,
      ).toEqual([]);
    },
    45_000,
  );
});
