/**
 * Phase 2a integration test — M14 `turn/start.input` rollout-visibility port.
 *
 * Promotes `scripts/spikes/m14-turn-start-rollout-usermessage.mjs` into
 * the vitest suite so the rollout-visibility invariant (turn/start.input
 * text persists as a `ResponseItem::UserMessage` in the session JSONL)
 * is locked under CI.
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-2a-cross-state.md` §Task 6.
 *
 * What this exercises:
 *   - Boots the full Phase 2a stack via `runCliForTest` against a real
 *     codex `app-server` + local mock-model HTTP server.
 *   - Reuses the `crossStateWalk` fixture from Task 5 so this port also
 *     functions as a sanity check that the 2a wiring places the new-state
 *     nudge into the rollout via `turn/start({input})` rather than the
 *     legacy invisible `inject_items` path.
 *
 * Assertions (single run):
 *   - Both `turn/start.input` texts land in the rollout JSONL as
 *     `response_item.message.role === "user"` entries with
 *     `content[0].type === "input_text"` and matching `text`:
 *       (1) The fresh-boot first-state nudge from `runCli.ts:474-487`
 *           (header `[harness] Now in state "a".`).
 *       (2) The cross-state second-state nudge from `scheduleCrossStateDance`
 *           (header `[harness] Now in state "b".`).
 *   - Both texts are captured from the outbound `turn/start.input.text`
 *     payload (via the `connectHeadlessWsImpl` spy) and the test asserts
 *     byte-for-byte equality with the rollout user-message text — that
 *     verifies the dance's wire shape and that codex persists it
 *     verbatim, NOT a textual heuristic over the rendered nudge.
 *
 * Skip gate matches `cli.runCli.phase1.test.ts:54` — requires the
 * `codex` binary on PATH plus `HARNESS_E2E_REAL_CODEX=1` so CI without
 * the binary skips cleanly.
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

const E2E_ENABLED = hasCodex() && process.env['HARNESS_E2E_REAL_CODEX'] === '1';

/**
 * Find the rollout JSONL file matching `threadId` written after
 * `runStartEpochMs`. Codex writes to
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl`.
 * Mirrors `scripts/spikes/m14-turn-start-rollout-usermessage.mjs::findRolloutForThread`
 * — walk recursively, match by filename suffix.
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

  // Walk recursively. Prefer filename match (`...-<threadId>.jsonl`) to
  // avoid false hits in older sessions whose contents reference unrelated
  // thread ids.
  const stack: string[] = [root];
  const candidates: string[] = [];
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
      } else if (e.isFile() && e.name.endsWith(`-${threadId}.jsonl`)) {
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
  return candidates.length > 0 ? candidates[0]! : null;
}

/**
 * Collect every user-message text in the rollout JSONL. Codex persists
 * `turn/start.input.text` as a `response_item` whose payload is
 * `{type: 'message', role: 'user', content: [{type: 'input_text', text}]}`
 * (M14 finding; matches the spike's `collectUserMessageTexts`).
 */
function collectUserMessageTexts(rolloutPath: string): string[] {
  const lines = readFileSync(rolloutPath, 'utf8').trim().split('\n');
  const texts: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec === null || typeof rec !== 'object') continue;
    const r = rec as {
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        content?: ReadonlyArray<{ type?: unknown; text?: unknown }>;
      };
    };
    if (r.type !== 'response_item') continue;
    const payload = r.payload;
    if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;
    if (!Array.isArray(payload.content)) continue;
    for (const c of payload.content) {
      if (c && typeof c === 'object' && c.type === 'input_text' && typeof c.text === 'string') {
        texts.push(c.text);
      }
    }
  }
  return texts;
}

describe.skipIf(!E2E_ENABLED)(
  'runCli — Phase 2a M14 turn/start.input rollout-visibility port',
  () => {
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

    it('persists both turn/start.input texts (first-state kickoff + cross-state dance) as rollout user messages', async () => {
      const { startMockModel, CROSS_STATE_WALK_FSM_SOURCE, buildCrossStateSubmitTurn } =
        await import('@aharness/test-support');

      const runStartEpochMs = Date.now() - 1_000;

      const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-m14-'));
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

      // Capture every outbound `turn/start` `input.text` value and the
      // parent threadId (from `thread/start`'s response). The two
      // `turn/start` requests we care about are: (1) the kickoff at
      // `runCli.ts:474-487` for the first-state nudge; (2) the
      // cross-state dance's `turn/start({input: <state-b nudge>})`.
      const turnStartTexts: string[] = [];
      let capturedThreadId: string | null = null;

      const connectWithSpy: typeof connectHeadlessWs = async (opts) => {
        const handle = await connectHeadlessWs(opts);
        // Note: `initialize` (sent inside `connectHeadlessWs` before
        // return) is NOT observed by these hooks; this test does not
        // assert on it.
        handle.client.onOutboundRequest((method, params) => {
          if (method === METHOD.turnStart && params && typeof params === 'object') {
            const p = params as { input?: ReadonlyArray<{ type?: unknown; text?: unknown }> };
            if (Array.isArray(p.input)) {
              for (const item of p.input) {
                if (
                  item &&
                  typeof item === 'object' &&
                  item.type === 'text' &&
                  typeof item.text === 'string'
                ) {
                  turnStartTexts.push(item.text);
                }
              }
            }
          }
        });
        handle.client.onOutboundResponse((method, _params, outcome) => {
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

      // We expect at least two `turn/start` requests with text input —
      // the first-state kickoff for `a` and the cross-state dance's
      // re-orientation to `b`.
      const stateANudge = turnStartTexts.find((t) => t.includes('[harness] Now in state "a"'));
      const stateBNudge = turnStartTexts.find((t) => t.includes('[harness] Now in state "b"'));
      expect(
        stateANudge,
        `expected a turn/start.input.text containing the state-a kickoff nudge; saw: ${JSON.stringify(turnStartTexts)}`,
      ).toBeDefined();
      expect(
        stateBNudge,
        `expected a turn/start.input.text containing the state-b dance nudge; saw: ${JSON.stringify(turnStartTexts)}`,
      ).toBeDefined();

      // Locate the rollout JSONL and assert both nudges landed as
      // `response_item.message.role === "user"` entries verbatim.
      expect(capturedThreadId, 'no threadId captured from thread/start').not.toBeNull();
      const rolloutPath = findRolloutForThread(capturedThreadId!, runStartEpochMs);
      expect(
        rolloutPath,
        `no rollout JSONL found for threadId=${capturedThreadId} under ~/.codex/sessions/ (mtime > ${runStartEpochMs})`,
      ).not.toBeNull();
      const userTexts = collectUserMessageTexts(rolloutPath!);

      // Byte-for-byte equality: the rollout must contain a user-message
      // text equal to each captured `turn/start.input.text` value. This
      // is the strict M14 invariant — codex persists the text verbatim
      // as a `ResponseItem::UserMessage`.
      expect(
        userTexts.includes(stateANudge!),
        `state-a nudge not present verbatim in rollout user messages.\nlooking for: ${JSON.stringify(stateANudge)}\nsaw: ${JSON.stringify(userTexts)}`,
      ).toBe(true);
      expect(
        userTexts.includes(stateBNudge!),
        `state-b dance nudge not present verbatim in rollout user messages.\nlooking for: ${JSON.stringify(stateBNudge)}\nsaw: ${JSON.stringify(userTexts)}`,
      ).toBe(true);
    }, 45_000);
  },
);
