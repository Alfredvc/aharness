/**
 * Phase 2b unit-level `AWAIT__` integration test.
 *
 * Plan: `docs/plans/2026-05-13-headless-phase-2b-owner-yield.md` §Task 8.
 *
 * Topology under test:
 *
 *   a (stateful, `await` exit `reply`) ──reply→ b (stateful, submit `done`) ──done→ c (terminal:'success')
 *
 * Covers the wiring boundary that the pure-unit `runtime.awaitResolver.test.ts`
 * does not exercise: notification-router → `dispatchRawResponseItem` →
 * await resolver → actor-host `commitAwait` → snapshot flush → drive-forward
 * default-branch `turn/start` for the new state. The test pumps a
 * synthetic WS transport (mirrors `cli.runCli.phase1.test.ts`'s Phase 2a
 * stub) — no real codex process and no mock-model HTTP server.
 *
 * Flow:
 *
 *   1. boot: thread/start → kickoff turn/start (state a's nudge) → turn/started
 *   2. await: push function_call(request_user_input) + function_call_output
 *      via `rawResponseItem/completed` notifications. The resolver fires
 *      `AWAIT__a__reply`; the host advances a→b; `onAfterTransition`
 *      flushes the post-AWAIT snapshot (test sees `value: 'b'`).
 *   3. drive-forward: push turn/completed for the kickoff turn → drive-
 *      forward's default branch issues a fresh turn/start carrying state
 *      b's nudge (assertion target).
 *   4. terminal submit: push `item/tool/call` for `state: 'b', exit:
 *      'done', data: {}` → dispatcher commits b→c; terminal exit code 0.
 *
 * Per plan §Task-8 the `_testOnSnapshotFlush` test seam (a new field on
 * `RunCliTestHooks`) is the only observation channel for the post-AWAIT
 * state sequence — codex's rollout file is never written because there
 * is no real codex process.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aharness, state, exit, terminal } from '../src/index.js';
import { runCliForTest, type RunCliTestHooks } from '../src/cli/runCli.js';
import type { AppServerHandle } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';

function makeStubAppServer(wsUrl = 'ws+unix:///nonexistent.sock'): AppServerHandle {
  return {
    wsUrl,
    port: null,
    sockPath: '/nonexistent.sock',
    async close(): Promise<void> {
      /* no-op */
    },
  } as unknown as AppServerHandle;
}

interface SyntheticTransportHandle {
  /** All outbound JSON-RPC envelopes the aharness CLI sent, in order. */
  readonly outbound: ReadonlyArray<{ id?: number; method?: string; result?: unknown }>;
  /** Inject an incoming JSON-RPC envelope from the synthetic peer. */
  push(envelope: unknown): void;
  /** Reply to the most-recent outbound request matching `method`. */
  replyTo(method: string, result: unknown): void;
}

/**
 * Build a synthetic JSON-RPC transport. Mirrors the pattern in
 * `cli.runCli.phase1.test.ts:makeSyntheticConnectStub`; kept inline here
 * to avoid cross-file fixture coupling.
 */
function makeSyntheticConnectStub(): {
  readonly handle: SyntheticTransportHandle;
  readonly connect: typeof import('../src/transport/wsClient.js').connectHeadlessWs;
} {
  const outbound: Array<{ id?: number; method?: string; result?: unknown }> = [];
  let transport!: Transport;

  const push = (envelope: unknown): void => {
    transport.onMessage?.(envelope);
  };

  const replyTo = (method: string, result: unknown): void => {
    for (let i = outbound.length - 1; i >= 0; i--) {
      const m = outbound[i];
      if (m?.method === method && typeof m.id === 'number') {
        push({ jsonrpc: '2.0', id: m.id, result });
        return;
      }
    }
    throw new Error(`replyTo: no pending request for method=${method}`);
  };

  const handle: SyntheticTransportHandle = {
    get outbound() {
      return outbound;
    },
    push,
    replyTo,
  };

  const connect = (async (opts: ConnectHeadlessWsOptions) => {
    transport = {
      send(msg: unknown) {
        outbound.push(msg as { id?: number; method?: string });
        const m = msg as { id?: number; method?: string };
        if (m.method === METHOD.initialize) {
          queueMicrotask(() =>
            push({
              jsonrpc: '2.0',
              id: m.id,
              result: { serverInfo: { name: 'stub', version: '0.0.0' } },
            }),
          );
        }
      },
      async close() {
        /* no-op */
      },
    };
    const client = new JsonRpcClient(transport);
    opts.registerHandlers?.(client);
    await client.request(METHOD.initialize, {
      clientInfo: opts.clientInfo,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  }) as typeof import('../src/transport/wsClient.js').connectHeadlessWs;

  return { handle, connect };
}

async function waitForOutbound(
  handle: SyntheticTransportHandle,
  predicate: (envelope: { method?: string }) => boolean,
  timeoutMs = 2_000,
): Promise<{ id?: number; method?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (let i = handle.outbound.length - 1; i >= 0; i--) {
      const m = handle.outbound[i];
      if (m && predicate(m)) return m;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitForOutbound: timeout after ${timeoutMs}ms; outbound methods: ` +
      handle.outbound.map((m) => m.method ?? '(reply)').join(', '),
  );
}

describe('runCliForTest — Phase 2b await-exit walk (synthetic transport)', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-await-exit-'));
    stderrBuf = [];
    stderrSink = {
      write(chunk: string | Uint8Array): boolean {
        stderrBuf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('await exit fires AWAIT__a__reply on function_call_output and drives a → b → c', async () => {
    interface DonePayload {
      _empty?: never;
    }
    // Author the machine in-process. The `loadFsmImpl` test hook skips
    // esbuild + dynamic-import so the on-disk file is a no-op stub.
    const machine = aharness.machine({
      id: 'await-exit-walk',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'ask the user a free-text question',
          exits: {
            reply: { kind: 'await', to: 'b' },
          },
        }),
        b: state({
          entryPrompt: 'got the reply',
          exits: { done: exit<DonePayload>({ to: 'c' }) },
        }),
        c: terminal('success'),
      },
    });
    // Sidecar for state b's `done` submit. State a's `reply` is an
    // `await` exit and carries no submit data, so it needs no sidecar
    // entry. Empty-object payload — the model emits `data: {}`.
    const sidecar = {
      b: {
        done: {
          jsonSchema: {
            type: 'object',
            properties: {},
          } as const,
          validate: (input: unknown) => {
            if (input !== null && typeof input === 'object') {
              return { ok: true as const, data: input };
            }
            return { ok: false as const, errors: [{ path: '/', message: 'must be object' }] };
          },
        },
      },
    };

    const fsmPath = join(repoRoot, 'awaitExit.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-await-exit';

    // Capture the post-flush XState snapshot's `value` (state id for
    // flat machines) on each `flushSnapshotFn` call. Production fires
    // the flush after every transition: post-AWAIT__ commit (a→b) and
    // post-`aharness_submit` commit (b→c). The kickoff turn does NOT
    // flush — only commits do — so the sequence is exactly two entries.
    const flushedStates: string[] = [];
    const onSnapshotFlush = (xs: unknown): void => {
      const v = (xs as { value?: unknown } | null)?.value;
      if (typeof v === 'string') flushedStates.push(v);
    };

    const driver = async (): Promise<void> => {
      // 1. Boot: reply to thread/start.
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      // 2. Kickoff turn/start (state a's nudge) — reply + synthesize
      //    turn/started for kickoff turn id `t-kick`.
      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // 3. Deliver the `function_call(request_user_input)` notification
      //    via `rawResponseItem/completed`. The resolver's
      //    `noteFunctionCall` records the call_id for later matching
      //    against the function_call_output.
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.rawResponseItemCompleted,
        params: {
          item: {
            type: 'function_call',
            call_id: 'call-await-1',
            name: 'request_user_input',
            arguments: JSON.stringify({
              questions: [
                {
                  id: 'q',
                  header: '',
                  question: 'What?',
                  isOther: false,
                  isSecret: false,
                },
              ],
            }),
          },
        },
      });

      // 4. Deliver the matching `function_call_output` notification.
      //    The resolver parses the answer JSON and calls
      //    `host.commitAwait('a', 'reply', 'the reply text')` →
      //    `onAfterTransition` flushes the post-AWAIT__ snapshot. The
      //    host is now in state `b`.
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.rawResponseItemCompleted,
        params: {
          item: {
            type: 'function_call_output',
            call_id: 'call-await-1',
            // The output is a JSON string (single InputText collapse
            // shape per `awaitResolver.ts:58-69`) wrapping the answers
            // map.
            output: JSON.stringify({
              answers: { q: { answers: ['the reply text'] } },
            }),
          },
        },
      });

      // 5. Push `turn/completed` for the kickoff turn so drive-forward
      //    fires. Posture chain:
      //      isAwaiting() === false (no parked ServerRequest — the
      //        request_user_input lifecycle here is a notification, not
      //        a ServerRequest the CLI parks),
      //      hasPendingClear() / isOpen() inert (Phase 2c/3),
      //      submittedThisTurn() === false (no SUBMIT this turn),
      //      isTerminal() === false (state b is stateful),
      //    so the default branch issues a fresh turn/start with state
      //    b's nudge.
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // 6. Wait for the post-AWAIT__ default-branch turn/start, reply
      //    and synthesize a turn/started for turn `t-b`. The
      //    `outbound.indexOf > 0` guard targets the second turn/start
      //    (the kickoff was the first).
      await waitForOutbound(
        handle,
        (m) => m.method === METHOD.turnStart && handle.outbound.indexOf(m) > 0,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-b' } },
      });

      // 7. Drive the terminal submit b→c via `item/tool/call`. The
      //    dispatcher commits + flushes + reports terminal; the run
      //    exits 0.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-b',
          callId: 'call-submit-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: {} }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'awaitExit.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/awaitExit.mjs',
        issues: [],
        cacheHit: false,
        hash: 'await-exit-walk',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      _testOnSnapshotFlush: onSnapshotFlush,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Snapshot-flush sequence: the AWAIT__ commit advances a→b (first
    // flush from `onAfterTransition`), the following turn/completed
    // pre-decision Phase-2c counter flush persists b again, then the
    // submit b→c flushes from `dispatchSubmit` post-commit.
    expect(flushedStates).toEqual(['b', 'b', 'c']);

    // The post-AWAIT__ default-branch turn/start carries state b's
    // composed nudge — same `[aharness] Now in state "b"` marker the
    // Phase-2a cross-state tests assert. This proves drive-forward
    // (NOT the dispatcher) issued the turn/start AFTER the AWAIT__
    // transition moved the host to state b.
    const turnStarts = handle.outbound.filter((m) => m.method === METHOD.turnStart) as Array<{
      method?: string;
      params?: { input?: Array<{ text?: string }> };
    }>;
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    const secondTurnStart = turnStarts[1];
    expect(secondTurnStart?.params?.input?.[0]?.text).toContain('[aharness] Now in state "b"');
  }, 10_000);
});
