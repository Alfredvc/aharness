/**
 * Phase 2a end-to-end integration test for the cross-state turn-end dance.
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-2a-cross-state.md` §Task 5.
 *
 * Drives the full Phase 2a stack via `runCliForTest` against a real
 * codex `app-server` + a local mock-model HTTP server (no
 * `startHeadlessApp` shortcut — that helper does not install the
 * `item/tool/call` dispatcher and would not exercise the 2a wiring).
 *
 * Topology under test:
 *
 *   a (stateful) ──next→ b (stateful) ──done→ c (terminal:'success')
 *
 * Mock-model script:
 *   - Turn 1: `aharness_submit({state: "a", exit: "next", data: {note}})`
 *   - Turn 2: `aharness_submit({state: "b", exit: "done", data: {ok}})`
 *
 * Assertions:
 *   1. `runCliForTest` exits 0.
 *   2. The second model POST's `input` array carries the state-b
 *      composed nudge — `[aharness] Now in state "b"` header AND the
 *      rendered `done` exit. (Asserts the full composed nudge lands
 *      via the cross-state dance's `turn/start({input})`, not just the
 *      raw `entryPrompt`.)
 *   3. `turn/interrupt` was issued exactly once between turn 1 and
 *      turn 2 (capture via a `connectHeadlessWsImpl` wrapper that
 *      delegates to real `connectHeadlessWs` then wraps the returned
 *      `client.request` method).
 *
 * Skip gate matches `cli.runCli.phase1.test.ts:54` — requires the
 * `codex` binary on PATH plus `AHARNESS_E2E_REAL_CODEX=1` so CI without
 * the binary skips cleanly. A single run is sufficient; race coverage
 * is owned by Task 6's M6 port at 5×.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectHeadlessWs } from '../src/transport/wsClient.js';
import { runCliForTest } from '../src/cli/runCli.js';
import { METHOD } from '../src/protocol/methodNames.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

describe.skipIf(!E2E_ENABLED)('runCli — Phase 2a cross-state walk (end-to-end)', () => {
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

  it('walks a → b (cross-state dance) → c (terminal) and exits 0', async () => {
    // Deferred imports — same pattern as `cli.runCli.phase1.test.ts`'s
    // type-only import note: keep the @aharness/test-support barrel
    // out of file-load (its `pty.ts` may fail on systems without
    // node-pty native bindings).
    const { startMockModel, CROSS_STATE_WALK_FSM_SOURCE, buildCrossStateSubmitTurn } =
      await import('@aharness/test-support');

    const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-csw-'));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));

    // Write the FSM source as a real `.fsm.ts` file in the synthetic
    // repoRoot so `loadFsm` can esbuild + dynamic-import it. The fixture
    // uses bare `@aharness/core` imports (externalised by the loader),
    // not relative paths, so the synthetic dir does not need a
    // `node_modules` link.
    const fsmPath = join(repoRoot, 'crossStateWalk.fsm.ts');
    writeFileSync(fsmPath, CROSS_STATE_WALK_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());

    // Register two `awaitNextRequest()` observers BEFORE booting the
    // CLI so we capture the body of both POSTs. The mock model's
    // waiter queue is FIFO (`mockModel.ts:85-86`): the first POST
    // resolves `firstPost`, the second resolves `secondPost`. We need
    // both observers in place because registering only `secondPost`
    // would let the first POST consume the slot and leave us reading
    // the wrong body. We discard `firstPost` (the kickoff turn for
    // state a) and only assert on `secondPost` (the cross-state
    // re-orientation for state b).
    const firstPost = mock.awaitNextRequest();
    const secondPost = mock.awaitNextRequest();

    // Queue both model turns before booting the CLI. The mock model
    // serves them in FIFO order as each `POST /v1/responses` arrives.
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

    // Spy on every outbound JSON-RPC `request(method, params)` issued
    // by the aharness CLI via the client's first-class observer hook.
    // Delegates to the real `connectHeadlessWs` then registers the
    // observer on the returned client. Note: `initialize` (sent inside
    // `connectHeadlessWs` before return) is NOT observed by this hook;
    // none of these tests assert on it.
    interface RequestRecord {
      readonly method: string;
      readonly params: unknown;
    }
    const recorded: RequestRecord[] = [];
    const connectWithSpy: typeof connectHeadlessWs = async (opts) => {
      const handle = await connectHeadlessWs(opts);
      handle.client.onOutboundRequest((method, params) => {
        recorded.push({ method, params });
      });
      return handle;
    };

    const result = await runCliForTest({
      fsmPath: 'crossStateWalk.fsm.ts',
      cwd: repoRoot,
      stderr,
      stdout,
      // Stub the verifier — verification semantics are exercised in
      // `verify.test.ts`. This test focuses on the boot + cross-state
      // dance sequence.
      verify: async () => ({ exitCode: 0 }),
      // Real codex on PATH; version-gate semantics covered in
      // `appServer.version.test.ts`.
      versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
      // The synthetic repoRoot has no `~/.codex/auth.json`; stub the
      // precheck (the mock provider does not hit the auth path).
      authJsonExists: () => true,
      _testMockModelBaseUrl: mock.baseUrl,
      connectHeadlessWsImpl: connectWithSpy,
    });

    expect(
      result.exitCode,
      `stderr: ${stderrChunks.join('')}\nstdout: ${stdoutChunks.join('')}`,
    ).toBe(0);

    // The mock model received both queued turns.
    expect(mock.requestCount).toBeGreaterThanOrEqual(2);

    // Assertion 2 — the second model POST's `input` array contains a
    // user message whose `input_text` carries the state-b composed
    // nudge. The cross-state dance issues
    // `turn/start({input: [{type:'text', text: <nudge>}]})`; codex
    // translates that into a `{type: 'message', role: 'user',
    // content: [{type: 'input_text', text: ...}]}` rollout entry
    // (M14, see codex `protocol/src/models.rs:697-743` shapes also
    // documented in `runtime/injectNudge.ts:20-30`), which then rides
    // the next Responses API POST as part of the `input` array.
    const second = await secondPost;
    const body = second.body as {
      readonly input?: ReadonlyArray<{
        readonly role?: string;
        readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
      }>;
    };
    expect(Array.isArray(body.input), 'mock model second POST has no input array').toBe(true);
    const userMessages = (body.input ?? []).filter((m) => m.role === 'user');
    const matchingTexts = userMessages
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === 'input_text')
      .map((c) => c.text ?? '');
    const stateBNudge = matchingTexts.find((t) => t.includes('[aharness] Now in state "b"'));
    expect(
      stateBNudge,
      `expected a user input_text containing the state-b nudge in the second POST; saw: ${JSON.stringify(matchingTexts)}`,
    ).toBeDefined();
    // The full composed nudge renders each exit's name; asserting on
    // `done` verifies the exits block landed (not just the raw
    // `entryPrompt`).
    expect(stateBNudge).toContain('done');

    // Confirm the first POST arrived (kickoff turn for state a). The
    // promise resolved at line 178 (`secondPost`) implies the first
    // already resolved; this `await` is a no-op, kept so the
    // `firstPost` variable is consumed without a dangling-promise
    // lint warning.
    await firstPost;

    // Assertion 3 — `turn/interrupt` was issued exactly once between
    // turn 1 and turn 2 via the JsonRpcClient spy.
    const interruptCalls = recorded.filter((r) => r.method === METHOD.turnInterrupt);
    expect(
      interruptCalls.length,
      `expected exactly one turn/interrupt; saw ${interruptCalls.length}`,
    ).toBe(1);
  }, 30_000);
});
