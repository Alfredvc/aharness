/**
 * Phase 2b end-to-end integration test for cross-state-into-`awaitsOwnerText`.
 *
 * Spec: `docs/plans/2026-05-13-headless-phase-2b-owner-yield.md` §Task 7.
 *
 * Drives the full Phase 2b stack via `runCliForTest` against a real
 * codex `app-server` + a local mock-model HTTP server. Three-turn
 * model script:
 *
 *   1. Turn 1: `harness_submit({state: "a", exit: "next", data: {note: "go"}})`
 *      — cross-state dance fires a→b (state b declares `awaitsOwnerText`).
 *   2. Turn 2: `request_user_input({questions: [{id:"owner", header:"",
 *      question:"what is your name?", isOther:false, isSecret:false}]})`
 *      — CLI parks the ServerRequest; `MockOwnerInputProvider` resolves
 *      with `{answers: {owner: {answers: ["alice"]}}}`; codex returns
 *      the answer to the model on its next turn.
 *   3. Turn 3: `harness_submit({state: "b", exit: "done", data:
 *      {greeting: "hello alice"}})` — terminal transition; run exits 0.
 *
 * Topology under test:
 *
 *   a (stateful) ──next→ b (stateful, awaitsOwnerText + submit `done`) ──done→ c (terminal:'success')
 *
 * Assertions:
 *   1. `runCliForTest` exits 0.
 *   2. The `MockOwnerInputProvider` received exactly one
 *      `provideAnswers(params)` call; the question text is verbatim
 *      `"what is your name?"` and the qid is `"owner"`.
 *   3. The mock-model's THIRD POST (turn 3) carries a
 *      `function_call_output` for `request_user_input` whose `output`
 *      substring contains `"alice"` (proving the CLI's
 *      `{answers: {owner: {answers: ["alice"]}}}` reply landed as the
 *      model-side tool result).
 *   4. `MockOwnerInputProvider.closeCallCount === 1` after the run —
 *      `runShutdown` invoked `provider.close()` exactly once on the
 *      clean-exit path.
 *   5. (Regression gate) `Phase 2 not implemented: target state` no
 *      longer appears in `packages/core/src/` (already true
 *      after T6; verified inline so this test fails loudly if the throw
 *      is ever reintroduced).
 *
 * Skip gate matches `integration.crossStateWalk.test.ts:54` — requires
 * the `codex` binary on PATH plus `HARNESS_E2E_REAL_CODEX=1` so CI
 * without the binary skips cleanly. A single run is sufficient.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCliForTest } from '../src/cli/runCli.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['HARNESS_E2E_REAL_CODEX'] === '1';

describe.skipIf(!E2E_ENABLED)('runCli — Phase 2b owner-yield walk (end-to-end)', () => {
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

  it('walks a → b (awaitsOwnerText, owner reply) → c (terminal) and exits 0', async () => {
    // Deferred imports — same pattern as `integration.crossStateWalk.test.ts`.
    // Keeps `pty.ts` (node-pty native bindings) out of file-load on systems
    // without that binary.
    const {
      startMockModel,
      createMockOwnerInputProvider,
      OWNER_YIELD_WALK_FSM_SOURCE,
      buildCrossStateSubmitTurn,
      buildRequestUserInputTurn,
    } = await import('@aharness/test-support');

    const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-oyw-'));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));

    // Write the FSM source as a real `.fsm.ts` file in the synthetic
    // repoRoot so `loadFsm` can esbuild + dynamic-import it. The fixture
    // uses bare `@aharness/core` imports (externalised by the loader), so
    // the synthetic dir does not need a `node_modules` link.
    const fsmPath = join(repoRoot, 'ownerYieldWalk.fsm.ts');
    writeFileSync(fsmPath, OWNER_YIELD_WALK_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());

    // Pre-load the mock-owner-input provider with the queued answer.
    // The CLI's `item/tool/requestUserInput` handler dequeues this when
    // codex parks the ServerRequest after the model's turn-2
    // `request_user_input` call.
    const mockOwnerInput = createMockOwnerInputProvider();
    mockOwnerInput.queueAnswers({ owner: ['alice'] });

    // Queue all three model turns before booting the CLI. The mock
    // model serves them in FIFO order as each `POST /v1/responses`
    // arrives.
    //   Turn 1: cross-state submit a → b.
    //   Turn 2: request_user_input call (no harness_submit).
    //   Turn 3: terminal submit b → c, carrying the user's answer.
    mock.queueTurn(buildCrossStateSubmitTurn('a', 'next', { note: 'go' }));
    mock.queueTurn(
      buildRequestUserInputTurn('call-rui-1', [
        { id: 'owner', header: '', question: 'what is your name?' },
      ]),
    );
    mock.queueTurn(buildCrossStateSubmitTurn('b', 'done', { greeting: 'hello alice' }));

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

    const result = await runCliForTest({
      fsmPath: 'ownerYieldWalk.fsm.ts',
      cwd: repoRoot,
      stderr,
      stdout,
      // Stub the verifier — verification semantics are exercised in
      // `verify.test.ts`. This test focuses on the boot + cross-state
      // dance + owner-yield ServerRequest reply path.
      verify: async () => ({ exitCode: 0 }),
      // Real codex on PATH; version-gate semantics covered in
      // `appServer.version.test.ts`.
      versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
      // The synthetic repoRoot has no `~/.codex/auth.json`; stub the
      // precheck (the mock provider does not hit the auth path).
      authJsonExists: () => true,
      _testMockModelBaseUrl: mock.baseUrl,
      ownerInputProvider: mockOwnerInput,
    });

    expect(
      result.exitCode,
      `stderr: ${stderrChunks.join('')}\nstdout: ${stdoutChunks.join('')}`,
    ).toBe(0);

    // The mock model received all three queued turns.
    expect(mock.requestCount).toBeGreaterThanOrEqual(3);

    // Assertion 2 — the provider observed exactly one ServerRequest
    // with the expected question shape (CF-3 wire shape verified via
    // the provider seam rather than wrapping `onServerRequest`, which
    // `JsonRpcClient` rejects on duplicate registration per
    // `jsonrpc/client.ts:118`).
    const received = mockOwnerInput.getReceivedRequests();
    expect(received.length).toBe(1);
    const firstQuestion = received[0]?.questions[0];
    expect(firstQuestion?.question).toBe('what is your name?');
    expect(firstQuestion?.id).toBe('owner');

    // Assertion 3 — turn 3's POST input array carries the
    // `function_call_output` for `request_user_input` whose `output`
    // substring contains `"alice"`. This proves the CLI's reply landed
    // as the model-side tool result on the next turn.
    const turn3 = mock.recordedRequests[2];
    expect(turn3, 'mockModel.recordedRequests[2] missing (turn 3 never POSTed)').toBeDefined();
    const turn3Body = turn3?.body as {
      readonly input?: ReadonlyArray<{
        readonly type?: string;
        readonly name?: string;
        readonly output?: string;
        readonly call_id?: string;
      }>;
    };
    expect(Array.isArray(turn3Body.input), 'turn 3 body has no input array').toBe(true);
    const fco = (turn3Body.input ?? []).find(
      (m) => m.type === 'function_call_output' && m.name === 'request_user_input',
    );
    // Some codex protocol shapes omit `name` on function_call_output
    // (the name is carried on the preceding `function_call` entry).
    // Fall back to scanning all function_call_output items if the
    // name-matched lookup missed; the same POST can also carry the
    // preceding harness_submit output.
    const fcoFallbacks = (turn3Body.input ?? []).filter((m) => m.type === 'function_call_output');
    const fcoFallback =
      fco ?? fcoFallbacks.find((m) => typeof m.output === 'string' && m.output.includes('alice'));
    expect(
      fcoFallback,
      `expected an alice-bearing function_call_output in turn 3's input; saw types: ${(
        turn3Body.input ?? []
      )
        .map((m) => m.type)
        .join(', ')} outputs: ${JSON.stringify(fcoFallbacks.map((m) => m.output))}`,
    ).toBeDefined();
    expect(
      typeof fcoFallback?.output === 'string' && fcoFallback.output.includes('alice'),
      `expected turn 3's request_user_input function_call_output to contain "alice"; saw: ${JSON.stringify(fcoFallback?.output)}`,
    ).toBe(true);

    // Assertion 4 — provider's `close()` ran exactly once on the
    // clean-exit path (`runShutdown` close-lifecycle gate).
    expect(mockOwnerInput.closeCallCount).toBe(1);

    // Assertion 5 (regression gate) — the awaitsOwnerText-target throw
    // removed in T6 is still absent. The grep walks the production
    // sources synchronously so the test fails loudly if anyone
    // re-introduces the stub.
    const srcDir = join(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && full.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          if (text.includes('Phase 2 not implemented: target state')) {
            hits.push(full);
          }
        }
      }
    };
    walk(srcDir);
    expect(
      hits,
      `unexpected hits for 'Phase 2 not implemented: target state' (T6 stub regression): ${hits.join(', ')}`,
    ).toEqual([]);
  }, 30_000);
});
