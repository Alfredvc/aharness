/**
 * Phase 1 end-to-end CLI smoke test (Task 17) + Phase 2a cross-state
 * mocked-transport cases (Task 4).
 *
 * The first `describe` block boots the full Phase 1 single-process
 * pipeline against a real codex `app-server` + a local mock-model HTTP
 * server: verify → app-server spawn → WS connect → `thread/start` with
 * `dynamic_tools` → first-state `turn/start` kickoff → model issues a
 * single `aharness_submit` tool call → dispatcher commits + flushes +
 * signals terminal → `runCli` exits 0. The fixture FSM is
 * `hello.fsm.ts`. Skip conditions: requires a `codex` binary on PATH
 * and `AHARNESS_E2E_REAL_CODEX=1`.
 *
 * The second `describe` block adds Phase 2a cross-state cases that
 * run without real codex by stubbing `connectHeadlessWsImpl` with a
 * synthetic transport (same pattern as `cli.runCli.test.ts` case 8).
 * Those cases assert: (1) cross-state submit drives the dance —
 * `thread/start` → kickoff `turn/start` → `turn/interrupt` → cross-
 * state `turn/start` — in order; (2) two consecutive cross-state
 * submits both fire `turn/interrupt`, proving the
 * `submittedThisTurnFlag` clears on the intermediate `turn/started`.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Type-only import so skipped real-Codex E2E test-file evaluation does
// not initialize test-support helper modules at file-load time. Runtime
// imports stay inside the `it` body, which only runs when the test is
// not skipped.
import type { MockModelHandle } from '@aharness/test-support';

import { aharness, createFsm, state, exit, terminal, DECLINED_ANSWER_TEXT } from '../src/index.js';
import { runCliForTest, type RunCliTestHooks } from '../src/cli/runCli.js';
import type { OwnerInputProvider } from '../src/cli/ownerInputProvider.js';
import type { AppServerHandle } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type { ActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import type { ReplayableAppEvent } from '../src/ui/events.js';
import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../src/protocol/types.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';

const AUTO_REVIEW_OVERRIDES = [
  ['approval_policy', '"on-request"'],
  ['approvals_reviewer', '"auto_review"'],
] as const;

const EMPTY_SKILL_ORIGIN_MANIFEST = {
  rootSourceDir: '/tmp',
  sourceDirPrefixes: [],
  availableSkills: [],
} as const;

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

describe.skipIf(!E2E_ENABLED)('runCli — Phase 1 end-to-end', () => {
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

  it('runs hello.fsm.ts to terminal and exits 0', async () => {
    // Deferred imports — see file-header note on the type-only import.
    const { sseFunctionCall, sseResponseCreated, sseTurnComplete, startMockModel } =
      await import('@aharness/test-support');

    const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-phase1-'));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));

    // Copy the canonical hello fixture into the synthetic repo root so
    // `loadFsm` resolves it normally (the .aharness/cache/ tree lands
    // under repoRoot too).
    const fixtureSource = resolve(__dirname, 'fixtures/hello.fsm.ts');
    const fsmPath = join(repoRoot, 'hello.fsm.ts');
    copyFileSync(fixtureSource, fsmPath);

    const mock: MockModelHandle = await startMockModel();
    cleanups.push(() => mock.close());

    // Queue the model's only turn: a single `aharness_submit` function
    // call that drives the FSM into its terminal state. The dispatcher
    // recognises the terminal projection and resolves `terminalPromise`.
    mock.queueTurn([
      sseResponseCreated(),
      sseFunctionCall('aharness_submit', {
        state: 'greet',
        exit: 'finish',
        data: {},
      }),
      sseTurnComplete(),
    ]);

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
      fsmPath: 'hello.fsm.ts',
      cwd: repoRoot,
      stderr,
      stdout,
      // Stub the verifier — the real path would re-load the fixture and
      // run all checks, which is exercised in `verify.test.ts`. This
      // test focuses on the boot sequence, not verification.
      verify: async () => ({ exitCode: 0 }),
      // Real codex on PATH; the version gate is exercised by
      // `appServer.version.test.ts`.
      versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
      // The synthetic repo root has no `~/.codex/auth.json`; the real
      // user's home dir does. Real codex with `--enable
      // default_mode_request_user_input` and the mock provider does not
      // hit the auth path. Stub the precheck so we don't bail.
      authJsonExists: () => true,
      _testMockModelBaseUrl: mock.baseUrl,
    });

    expect(result.exitCode, `stderr: ${stderrChunks.join('')}`).toBe(0);
  }, 30_000);
});

describe('runCliForTest — Phase 2d zero-hook regression', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-zero-hook-'));
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

  it('does not add hook overrides or open a hook socket for machines with no declared hooks', async () => {
    const machine = aharness.machine({
      id: 'zero-hook',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'no hooks here',
          exits: {
            done: exit<{ _empty?: never }>({ to: 'done' }),
          },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      a: {
        done: {
          jsonSchema: { type: 'object' as const, properties: {} },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };
    writeFileSync(join(repoRoot, 'zero.fsm.ts'), '// stub fsm\n');

    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const result = await runCliForTest({
      fsmPath: 'zero.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/zero.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'zero',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async (opts) => {
        capturedOverrides = opts.cliOverrides;
        throw new Error('stop after spawn options are observable');
      }) as RunCliTestHooks['spawnAppServer'],
    });

    expect(result.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('app-server failed');
    expect(capturedOverrides ?? []).toEqual(AUTO_REVIEW_OVERRIDES);
    expect((capturedOverrides ?? []).filter(([key]) => key.startsWith('hooks.'))).toEqual([]);
    expect(existsSync(join(onlyRunRootForCliRegression(repoRoot), 'hook.sock'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 2a cross-state cases — mocked transport, no real codex.
// ---------------------------------------------------------------------------

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

function replyToSkillPreflightIfNeeded(
  transport: Transport,
  envelope: { id?: number; method?: string; params?: unknown },
): boolean {
  if (envelope.method === METHOD.skillsExtraRootsSet) {
    queueMicrotask(() =>
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: envelope.id,
        result: {},
      }),
    );
    return true;
  }
  if (envelope.method === METHOD.skillsList) {
    const params = envelope.params as { cwds?: readonly string[] } | undefined;
    const cwd = params?.cwds?.[0] ?? '/tmp/project';
    queueMicrotask(() =>
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: envelope.id,
        result: { data: [{ cwd, skills: [], errors: [] }] },
      }),
    );
    return true;
  }
  return false;
}

function onlyRunRootForCliRegression(repoRoot: string): string {
  const runsRoot = join(repoRoot, '.aharness', 'runs');
  const dirs = readdirSync(runsRoot)
    .map((name) => join(runsRoot, name))
    .filter((path) => statSync(path).isDirectory());
  expect(dirs).toHaveLength(1);
  return dirs[0]!;
}

interface SyntheticTransportHandle {
  /** All outbound JSON-RPC envelopes the aharness CLI sent, in order. */
  readonly outbound: ReadonlyArray<{
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
  }>;
  /** Inject an incoming JSON-RPC envelope from the synthetic peer. */
  push(envelope: unknown): void;
  /** Reply to the most-recent outbound request matching `method`. */
  replyTo(method: string, result: unknown): void;
}

/**
 * Build a synthetic JSON-RPC transport that records outbound traffic
 * and lets the test push inbound envelopes (server-request, notification,
 * or response). Returns a `connectHeadlessWsImpl` stub matching the
 * production signature.
 */
function makeSyntheticConnectStub(): {
  readonly handle: SyntheticTransportHandle;
  readonly connect: typeof import('../src/transport/wsClient.js').connectHeadlessWs;
} {
  const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> = [];
  let transport!: Transport;

  const push = (envelope: unknown): void => {
    transport.onMessage?.(envelope);
  };

  const replyTo = (method: string, result: unknown): void => {
    // Find the most-recent outbound request matching `method` that
    // hasn't been replied to yet. (`outbound` contains every send;
    // replies are tracked implicitly via the pending-set inside
    // JsonRpcClient.)
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
        // Auto-respond to `initialize` so the handshake inside
        // `connectHeadlessWs` resolves; the test controls every other
        // wire exchange via explicit `replyTo`/`push`.
        if (m.method === METHOD.initialize) {
          queueMicrotask(() =>
            push({
              jsonrpc: '2.0',
              id: m.id,
              result: { serverInfo: { name: 'stub', version: '0.0.0' } },
            }),
          );
        }
        replyToSkillPreflightIfNeeded(
          transport,
          msg as { id?: number; method?: string; params?: unknown },
        );
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

/**
 * Wait until the most-recent outbound request matches `predicate`. Used
 * to synchronize the test with the aharness CLI's async send queue.
 */
async function waitForOutbound(
  handle: SyntheticTransportHandle,
  predicate: (envelope: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
  }) => boolean,
  timeoutMs = 2_000,
): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> {
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

describe('runCliForTest — Phase 2a cross-state (mocked transport)', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-phase2a-'));
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

  it('cross-state submit fires watcher dispatch and turn/interrupt + turn/start in order', async () => {
    interface Ctx {
      n: number;
    }
    interface NextPayload {
      note: string;
    }
    interface DonePayload {
      ok: boolean;
    }
    const machine = aharness.machine({
      id: 'cs1',
      initial: 'a',
      context: (): Ctx => ({ n: 0 }),
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { next: exit<NextPayload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          exits: { done: exit<DonePayload>({ to: 'c' }) },
        }),
        c: terminal('success'),
      },
    });
    const sidecar = {
      a: {
        next: {
          jsonSchema: {
            type: 'object',
            required: ['note'],
            properties: { note: { type: 'string' } },
          } as const,
          validate: (input: unknown) => {
            const v = input as { note?: unknown } | null;
            if (v && typeof v === 'object' && typeof v.note === 'string') {
              return { ok: true as const, data: input };
            }
            return { ok: false as const, errors: [{ path: '/note', message: 'must be string' }] };
          },
        },
      },
      b: {
        done: {
          jsonSchema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          } as const,
          validate: (input: unknown) => {
            const v = input as { ok?: unknown } | null;
            if (v && typeof v === 'object' && typeof v.ok === 'boolean') {
              return { ok: true as const, data: input };
            }
            return { ok: false as const, errors: [{ path: '/ok', message: 'must be boolean' }] };
          },
        },
      },
    };

    const fsmPath = join(repoRoot, 'cs1.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-cs1';

    const driver = async (): Promise<void> => {
      // 1. Reply to `thread/start` so the boot path resumes.
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      // 2. Wait for the kickoff `turn/start`, reply, then synthesize a
      //    `turn/started` notification (kickoff turn id `t-kick`).
      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // 3. Deliver a cross-state `item/tool/call` ServerRequest. The
      //    dispatcher commits + flushes + composes + schedules the dance.
      //    Watcher registration completes synchronously inside the dance
      //    BEFORE the dispatcher returns its `'ok'` reply.
      handle.push({
        jsonrpc: '2.0',
        id: 9001, // server-issued request id (distinct from client ids)
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'next', data: { note: 'hi' } }),
        },
      });

      // 4. Deliver the matching `item/completed` so the watcher resolves
      //    and the dance proceeds to `turn/interrupt`. (Order — `item/
      //    completed` then `turn/completed` — mirrors codex's wire shape.)
      //    We need to wait for the dispatcher to have replied to the
      //    server-request first; do that by waiting for an outbound
      //    response with id=9001.
      await waitForOutbound(handle, (m) => m.id === 9001 && m.result !== undefined);
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          item: { type: 'dynamicToolCall', id: 'call-1' },
        },
      });

      // 5. Reply to `turn/interrupt`.
      await waitForOutbound(handle, (m) => m.method === METHOD.turnInterrupt);
      handle.replyTo(METHOD.turnInterrupt, {});

      // 6. Reply to the cross-state `turn/start`. (Same method name as
      //    the kickoff — `replyTo` targets the most-recent pending.)
      await waitForOutbound(
        handle,
        (m) => m.method === METHOD.turnStart && handle.outbound.indexOf(m) > 0,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-cross' } },
      });

      // 7. Drive the terminal submit from state `b` so the run ends.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-cross',
          callId: 'call-2',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'cs1.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/cs1.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'cs1',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Assert call order: skill preflight → thread/start → turn/start
    // (kickoff) → turn/interrupt → turn/start (cross-state).
    const orderedMethods = handle.outbound
      .filter(
        (m) =>
          typeof m.method === 'string' &&
          typeof m.id === 'number' &&
          // Drop the initialize handshake; the boot-sequence call order
          // begins with skill preflight.
          m.method !== METHOD.initialize,
      )
      .map((m) => m.method as string);
    expect(orderedMethods.slice(0, 6)).toEqual([
      METHOD.skillsExtraRootsSet,
      METHOD.skillsList,
      METHOD.threadStart,
      METHOD.turnStart,
      METHOD.turnInterrupt,
      METHOD.turnStart,
    ]);

    // The cross-state `turn/start` carries the new state's full
    // composed nudge — assert the `[aharness] Now in state "b"` marker
    // is present in its input payload.
    const crossStart = handle.outbound.filter((m) => m.method === METHOD.turnStart)[1] as
      | { params?: { input?: Array<{ text?: string }> } }
      | undefined;
    expect(crossStart?.params?.input?.[0]?.text).toContain('[aharness] Now in state "b"');
  }, 10_000);

  it('submittedThisTurnFlag clears on next turn/started so drive-forward issues its default-branch turn/start after a cross-state hop', async () => {
    // Direct check: a cross-state submit a→b sets the flag and the dance
    // owns the next `turn/start`. Then a `turn/completed` arrives for
    // the cross-state-aborted turn while the flag is still true — drive-
    // forward must short-circuit (NOT emit its own `turn/start`).
    // Once a fresh `turn/started` for the dance's new turn lands, the
    // flag clears. A subsequent `turn/completed` (no submit) lets
    // drive-forward fall through to the default branch, which issues a
    // third `turn/start` carrying state b's composed nudge.
    //
    // If the flag did NOT clear on `turn/started`, that third
    // `turn/start` would never be sent — drive-forward would short-
    // circuit forever. The test asserts that third envelope is emitted.
    interface Ctx {
      n: number;
    }
    interface OnlyPayload {
      ok: boolean;
    }
    const machine = aharness.machine({
      id: 'cs2',
      initial: 'a',
      context: (): Ctx => ({ n: 0 }),
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { go: exit<OnlyPayload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          exits: { done: exit<OnlyPayload>({ to: 'c' }) },
        }),
        c: terminal('success'),
      },
    });
    const mkValidator = () => ({
      jsonSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      } as const,
      validate: (input: unknown) => {
        const v = input as { ok?: unknown } | null;
        if (v && typeof v === 'object' && typeof v.ok === 'boolean') {
          return { ok: true as const, data: input };
        }
        return { ok: false as const, errors: [{ path: '/ok', message: 'must be boolean' }] };
      },
    });
    const sidecar = {
      a: { go: mkValidator() },
      b: { done: mkValidator() },
    };

    const fsmPath = join(repoRoot, 'cs2.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-cs2';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      // Kickoff turn: outbound `turn/start` #1; emit `turn/started` for
      // turn `t-kick`.
      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // Cross-state submit a → b. Dance sets flag and schedules
      // `turn/interrupt` + `turn/start` (#2, cross-state).
      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } }),
        },
      });
      await waitForOutbound(handle, (m) => m.id === 9001 && m.result !== undefined);
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: { threadId, item: { type: 'dynamicToolCall', id: 'call-1' } },
      });
      await waitForOutbound(handle, (m) => m.method === METHOD.turnInterrupt);
      handle.replyTo(METHOD.turnInterrupt, {});

      // Cross-state `turn/start` (#2) lands. BEFORE replying, push a
      // `turn/completed` for the aborted kickoff turn — this is the
      // load-bearing flag check: drive-forward fires while the flag is
      // still true, and MUST short-circuit (no third `turn/start`).
      await waitForOutbound(
        handle,
        (m) => m.method === METHOD.turnStart && handle.outbound.indexOf(m) > 0,
      );
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId, turn: { id: 't-kick' } },
      });
      // Yield to the event loop so the router's `onTurnCompleted`
      // (which would erroneously emit a `turn/start` if the flag check
      // failed) has a chance to run before we proceed.
      await new Promise((r) => setTimeout(r, 20));
      handle.replyTo(METHOD.turnStart, {});
      // Fresh `turn/started` for the cross-state turn — this clears
      // `submittedThisTurnFlag`.
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-cross' } },
      });

      // Now emit a `turn/completed` for the cross-state turn with NO
      // submit. Drive-forward should fall through to the default branch
      // (flag is false) and issue `turn/start` #3 with state b's nudge.
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId, turn: { id: 't-cross' } },
      });

      // Wait for `turn/start` #3 (the drive-forward default branch).
      await waitForOutbound(
        handle,
        (m) =>
          m.method === METHOD.turnStart &&
          handle.outbound
            .slice(0, handle.outbound.indexOf(m) + 1)
            .filter((x) => x.method === METHOD.turnStart).length >= 3,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-restart' } },
      });

      // Drive terminal submit b → c to end the run.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-restart',
          callId: 'call-2',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'cs2.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/cs2.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'cs2',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Three `turn/start` envelopes total:
    //   #1: kickoff (active state = a)
    //   #2: cross-state dance (active state = b)
    //   #3: drive-forward default branch AFTER the flag cleared (active
    //       state = b — same as #2 since we didn't change state)
    // If the flag had NOT cleared on `t-cross`'s `turn/started`,
    // envelope #3 would never have been emitted (drive-forward would
    // have short-circuited on the second `turn/completed`).
    const turnStarts = handle.outbound.filter((m) => m.method === METHOD.turnStart);
    expect(turnStarts.length).toBe(3);

    // Envelope #3's input is state b's composed nudge — same `[aharness]
    // Now in state "b"` marker as #2. This is what confirms drive-
    // forward (NOT the dance) issued envelope #3 with the active state.
    const third = turnStarts[2] as { params?: { input?: Array<{ text?: string }> } };
    expect(third?.params?.input?.[0]?.text).toContain('[aharness] Now in state "b"');
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Request-user-input owner-input cases — mocked transport, no real codex.
//
// Covers the `item/tool/requestUserInput` ServerRequest handler that
// parks each inbound request, forwards to the `OwnerInputProvider`,
// replies with the double-nested `{answers: {...}}` shape, and bumps a
// `pendingOwnerInputRequestCount` cell observable through the
// `isAwaiting` predicate via the `_testObserveIsAwaiting` test seam.
// ---------------------------------------------------------------------------

describe('runCliForTest — request-user-input ServerRequest handler', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-phase2b-'));
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

  /**
   * Build a single-state FSM with a normal submit exit. These tests
   * drive model-originated `request_user_input` ServerRequests through
   * the live owner-input handler; no retired FSM metadata is
   * involved.
   */
  function buildRequestUserInputMachineAndSidecar(): {
    machine: ReturnType<typeof aharness.machine>;
    sidecar: Record<string, Record<string, unknown>>;
  } {
    interface Ctx {
      n: number;
    }
    interface DonePayload {
      ok: boolean;
    }
    const machine = aharness.machine({
      id: 'request-user-input-handler',
      initial: 'a',
      context: (): Ctx => ({ n: 0 }),
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { done: exit<DonePayload>({ to: 'b' }) },
        }),
        b: terminal('success'),
      },
    });
    const sidecar = {
      a: {
        done: {
          jsonSchema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          } as const,
          validate: (input: unknown) => {
            const v = input as { ok?: unknown } | null;
            if (v && typeof v === 'object' && typeof v.ok === 'boolean') {
              return { ok: true as const, data: input };
            }
            return { ok: false as const, errors: [{ path: '/ok', message: 'must be boolean' }] };
          },
        },
      },
    };
    return { machine, sidecar };
  }

  /**
   * Wait until an outbound response envelope (no `method` field, has
   * `id` and `result`) for the given server-request id is recorded.
   * Used to gate on "the ServerRequest handler has replied" so the test
   * can inspect the reply body and the count state after release.
   */
  async function waitForServerReply(
    handle: SyntheticTransportHandle,
    serverRequestId: number,
    timeoutMs = 2_000,
  ): Promise<{ id?: number; method?: string; result?: unknown }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (let i = handle.outbound.length - 1; i >= 0; i--) {
        const m = handle.outbound[i];
        if (m && m.id === serverRequestId && m.method === undefined && 'result' in m) {
          return m;
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`waitForServerReply: timeout waiting for reply id=${serverRequestId}`);
  }

  it('abandoned item/tool/requestUserInput returns declined answers without parking or calling the provider', async () => {
    const { machine, sidecar } = buildRequestUserInputMachineAndSidecar();
    const fsmPath = join(repoRoot, 'rui-abandoned.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const startupThreadId = 'thread-rui-abandoned-startup';
    const replacementThreadId = 'thread-rui-abandoned-replacement';
    let activeBinding: ActiveThreadBinding | undefined;
    let readCount: (() => number) | null = null;
    const events: ReplayableAppEvent[] = [];
    let providerCallCount = 0;
    const provider: OwnerInputProvider = {
      provideAnswers: async () => {
        providerCallCount += 1;
        throw new Error('provider should not be called for abandoned owner input');
      },
    };

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: startupThreadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      if (activeBinding === undefined) throw new Error('active binding was not captured');
      activeBinding.set(replacementThreadId);

      handle.push({
        jsonrpc: '2.0',
        id: 9101,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId: startupThreadId,
          turnId: 't-old',
          itemId: 'item-old-rui',
          questions: [
            {
              id: 'owner',
              header: '',
              question: 'old question?',
              isOther: false,
              isSecret: false,
            },
          ],
        } satisfies ToolRequestUserInputParams,
      });
      const oldReply = await waitForServerReply(handle, 9101);
      expect(oldReply.result).toEqual({
        answers: { owner: { answers: [DECLINED_ANSWER_TEXT] } },
      });
      expect(readCount?.()).toBe(0);

      handle.push({
        jsonrpc: '2.0',
        id: 9102,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId: startupThreadId,
          turnId: 't-old',
          itemId: 'item-old-rui-malformed',
        },
      });
      const malformedReply = await waitForServerReply(handle, 9102);
      expect(malformedReply.result).toEqual({ answers: {} });
      expect(readCount?.()).toBe(0);

      handle.push({
        jsonrpc: '2.0',
        id: 9104,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId: startupThreadId,
          turnId: 't-old',
          itemId: 'item-old-rui-malformed-question',
          questions: [{}],
        },
      });
      const malformedQuestionReply = await waitForServerReply(handle, 9104);
      expect(malformedQuestionReply.result).toEqual({ answers: {} });
      expect(readCount?.()).toBe(0);

      handle.push({
        jsonrpc: '2.0',
        id: 9103,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: replacementThreadId,
          turnId: 't-active',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'rui-abandoned.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/rui-abandoned.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'rui-abandoned',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      ownerInputProvider: provider,
      _testOnActiveThreadBinding: (binding) => {
        activeBinding = binding;
      },
      _testReadPendingOwnerInputRequestCount: (read) => {
        readCount = read;
      },
      _testOnUiEvent: (event) => events.push(event),
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;
    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    expect(providerCallCount).toBe(0);
    expect(events.map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        kind: 'AbandonedThreadDiagnostic',
        threadId: startupThreadId,
        source: 'ownerInput',
      }),
    );
  }, 10_000);

  it('replies to item/tool/requestUserInput with the queued mock answer', async () => {
    const { machine, sidecar } = buildRequestUserInputMachineAndSidecar();
    const fsmPath = join(repoRoot, 'rui1.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-rui1';
    const receivedRequests: ToolRequestUserInputParams[] = [];
    const mockOwnerInput: OwnerInputProvider = {
      async provideAnswers(params): Promise<ToolRequestUserInputResponse> {
        receivedRequests.push(params);
        return { answers: { owner: { answers: ['alice'] } } };
      },
    };

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      // Kickoff turn/start for the active state.
      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // Deliver the request_user_input ServerRequest.
      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId,
          turnId: 't-kick',
          itemId: 'item-rui-1',
          questions: [
            {
              id: 'owner',
              header: '',
              question: 'what is your name?',
              isOther: false,
              isSecret: false,
            },
          ],
        } satisfies ToolRequestUserInputParams,
      });
      await waitForServerReply(handle, 9001);

      // Drive the terminal submit so the run ends.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'rui1.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/rui1.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'rui1',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      ownerInputProvider: mockOwnerInput,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Reply body matches the double-nested wire shape verbatim. The
    // mock dequeues `{owner: ['alice']}` → `{answers: {owner: {answers: ['alice']}}}`.
    const reply = handle.outbound.find(
      (m) => m.id === 9001 && m.method === undefined && 'result' in m,
    ) as { id: number; result: ToolRequestUserInputResponse };
    expect(reply.result).toEqual({ answers: { owner: { answers: ['alice'] } } });

    // The provider observed the request exactly once.
    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0]?.questions[0]?.question).toBe('what is your name?');
  }, 10_000);

  it('pendingOwnerInputRequestCount increments before provideAnswers awaits and decrements after the reply lands', async () => {
    const { machine, sidecar } = buildRequestUserInputMachineAndSidecar();
    const fsmPath = join(repoRoot, 'rui2.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-rui2';

    // Test-controlled trigger: the provider stalls until the test
    // explicitly resolves, so the test can read the count value DURING
    // the park window. The count seam (`readCount`) is captured below
    // and polled at three pin points: pre-park, mid-park, post-release.
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((res) => {
      releaseProvider = res;
    });
    let observedCountInsideProvider: number | null = null;

    let readCount: (() => number) | null = null;

    const stallingProvider: OwnerInputProvider = {
      async provideAnswers(
        _params: ToolRequestUserInputParams,
      ): Promise<ToolRequestUserInputResponse> {
        // The first synchronous tick inside `provideAnswers` runs AFTER
        // the handler's `onParked()` callback (which increments the
        // count) and BEFORE any await would yield. Read the count here
        // to confirm the increment-before-await ordering.
        if (readCount) {
          observedCountInsideProvider = readCount();
        }
        await providerGate;
        return { answers: { owner: { answers: ['queued'] } } };
      },
    };

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // Push the parkable request; provider is still gated.
      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId,
          turnId: 't-kick',
          itemId: 'item-rui-2',
          questions: [
            {
              id: 'owner',
              header: '',
              question: 'gated?',
              isOther: false,
              isSecret: false,
            },
          ],
        } satisfies ToolRequestUserInputParams,
      });

      // Yield microtasks so the ServerRequest handler runs through park
      // → invoke provider. The provider's synchronous prologue captures
      // the count, then awaits the gate (suspends).
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // Release the gated provider so the reply lands; the handler's
      // `finally` arm decrements the count.
      releaseProvider();
      await waitForServerReply(handle, 9001);
      // Brief tick so the `finally` decrement and any handler cleanup
      // run before the post-release count read.
      await new Promise((r) => setTimeout(r, 10));

      // Drive terminal so the run ends.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'rui2.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/rui2.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'rui2',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      ownerInputProvider: stallingProvider,
      _testReadPendingOwnerInputRequestCount: (read) => {
        readCount = read;
      },
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Count-ordering contract:
    //   - Inside provideAnswers (BEFORE the await suspends) the count is 1.
    //     This proves `onParked()` ran synchronously BEFORE the provider
    //     was awaited.
    //   - After the reply lands and the handler's `finally` arm runs, the
    //     count is back to 0. This proves `onReleased()` ran in `finally`
    //     so every exit path (including a resolve) restores the count.
    expect(observedCountInsideProvider).toBe(1);
    expect(readCount).not.toBeNull();
    expect(readCount?.()).toBe(0);
  }, 10_000);

  it('provider throws → CLI replies with per-qid (declined) marker and writes a stderr line', async () => {
    const { machine, sidecar } = buildRequestUserInputMachineAndSidecar();
    const fsmPath = join(repoRoot, 'rui3.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-rui3';

    const throwingProvider: OwnerInputProvider = {
      async provideAnswers(
        _params: ToolRequestUserInputParams,
      ): Promise<ToolRequestUserInputResponse> {
        throw new Error('forced provider failure');
      },
    };

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // Two questions so we can confirm the decline reply maps EVERY qid.
      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId,
          turnId: 't-kick',
          itemId: 'item-rui-3',
          questions: [
            {
              id: 'q1',
              header: '',
              question: 'first?',
              isOther: false,
              isSecret: false,
            },
            {
              id: 'q2',
              header: '',
              question: 'second?',
              isOther: false,
              isSecret: false,
            },
          ],
        } satisfies ToolRequestUserInputParams,
      });
      await waitForServerReply(handle, 9001);

      // Drive terminal so the run exits 0.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'rui3.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/rui3.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'rui3',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      ownerInputProvider: throwingProvider,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Reply maps EVERY qid to the pinned DECLINED_ANSWER_TEXT.
    const reply = handle.outbound.find(
      (m) => m.id === 9001 && m.method === undefined && 'result' in m,
    ) as { id: number; result: ToolRequestUserInputResponse };
    expect(reply.result).toEqual({
      answers: {
        q1: { answers: [DECLINED_ANSWER_TEXT] },
        q2: { answers: [DECLINED_ANSWER_TEXT] },
      },
    });

    // Stderr captures both the error and the synthetic-decline trail.
    const stderrText = stderrBuf.join('');
    expect(stderrText).toContain('ownerInputProvider error');
    expect(stderrText).toContain('synthetic decline');
    expect(stderrText).toContain('forced provider failure');
  }, 10_000);

  it('malformed params (no .questions) → CLI replies {answers: {}}, stderr logs the malformed-request line, count stays 0', async () => {
    const { machine, sidecar } = buildRequestUserInputMachineAndSidecar();
    const fsmPath = join(repoRoot, 'rui4.fsm.ts');
    writeFileSync(fsmPath, '// stub fsm\n');

    const { handle, connect } = makeSyntheticConnectStub();
    const threadId = 'thread-rui4';

    // Track every `provideAnswers` call: malformed params must short-
    // circuit BEFORE the provider is invoked.
    let providerCallCount = 0;
    const observingProvider: OwnerInputProvider = {
      async provideAnswers(
        _params: ToolRequestUserInputParams,
      ): Promise<ToolRequestUserInputResponse> {
        providerCallCount += 1;
        return { answers: {} };
      },
    };

    // Track `isAwaiting` reads. The narrow-first branch MUST NOT park,
    // so the count never increments and every observed value is false.
    const observed: boolean[] = [];

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      // Malformed: no `questions` field at all.
      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId,
          turnId: 't-kick',
          itemId: 'item-rui-4',
        } as unknown as ToolRequestUserInputParams,
      });
      await waitForServerReply(handle, 9001);

      // Drive a `turn/completed` so the isAwaiting predicate is read
      // post-malformed-request. The narrow-first branch never parked,
      // so the read MUST observe `false`.
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId, turn: { id: 't-kick' } },
      });
      await new Promise((r) => setTimeout(r, 20));

      // Drive-forward's default branch will issue a fresh `turn/start`
      // because no submit happened. Accept it.
      await waitForOutbound(
        handle,
        (m) => m.method === METHOD.turnStart && handle.outbound.indexOf(m) > 0,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-mid' } },
      });

      // Drive terminal so the run ends.
      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-mid',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'rui4.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/rui4.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'rui4',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      ownerInputProvider: observingProvider,
      _testObserveIsAwaiting: (v) => observed.push(v),
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);

    // Reply body is `{answers: {}}` — the narrow-short-circuit response.
    const reply = handle.outbound.find(
      (m) => m.id === 9001 && m.method === undefined && 'result' in m,
    ) as { id: number; result: ToolRequestUserInputResponse };
    expect(reply.result).toEqual({ answers: {} });

    // Provider was never invoked.
    expect(providerCallCount).toBe(0);

    // Stderr captures the malformed-params diagnostic.
    expect(stderrBuf.join('')).toContain('malformed request params');

    // The count never incremented — every observed `isAwaiting` read
    // is `false`.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((v) => v === false)).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Phase 3a Task 4 — browser UI stream publication from existing runtime hooks.
//
// Agent A owns the skeleton + failing behavioral tests only. These tests pin
// the Task 4 publication contract while asserting UI publication survives
// without mirroring model deltas to stdout. Agent B should make these pass by
// publishing UI events at the same runtime call sites that send orientation
// turns or produce operator-visible status.
// ---------------------------------------------------------------------------

describe('runCliForTest — Phase 3a runtime event publication', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-phase3a-task4-'));
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

  function buildTwoStateMachineAndSidecar() {
    interface DonePayload {
      ok: boolean;
    }
    const machine = aharness.machine({
      id: 'phase3a-events',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { done: exit<DonePayload>({ to: 'b' }) },
        }),
        b: terminal('success'),
      },
    });
    const sidecar = {
      a: {
        done: {
          jsonSchema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          } as const,
          validate: (input: unknown) => {
            const v = input as { ok?: unknown } | null;
            if (v && typeof v === 'object' && typeof v.ok === 'boolean') {
              return { ok: true as const, data: input };
            }
            return { ok: false as const, errors: [{ path: '/ok', message: 'must be boolean' }] };
          },
        },
      },
    };
    return { machine, sidecar };
  }

  function makeStdoutCapture(): { stdout: NodeJS.WritableStream; chunks: string[] } {
    const chunks: string[] = [];
    return {
      chunks,
      stdout: {
        write(chunk: string | Uint8Array): boolean {
          chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    };
  }

  function stdoutLines(chunks: readonly string[]): string[] {
    return chunks.join('').split('\n').filter(Boolean);
  }

  async function runWithTask4Aharness(o: {
    readonly fsmName: string;
    readonly machine: ReturnType<typeof aharness.machine>;
    readonly sidecar: Record<string, Record<string, unknown>>;
    readonly connect: RunCliTestHooks['connectHeadlessWsImpl'];
    readonly stdout: NodeJS.WritableStream;
    readonly events: ReplayableAppEvent[];
    readonly onActiveThreadBinding?: (binding: ActiveThreadBinding) => void;
    readonly onReplyHandler?: (
      handler: (payload: Record<string, unknown>) => Promise<unknown>,
    ) => void;
  }) {
    writeFileSync(join(repoRoot, o.fsmName), '// stub fsm\n');
    return runCliForTest({
      fsmPath: o.fsmName,
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: o.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine: o.machine,
        sidecar: o.sidecar,
        modulePath: `/tmp/${o.fsmName}.mjs`,
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: o.fsmName,
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () =>
        makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: o.connect,
      startUiServerImpl: async (options) => {
        o.onReplyHandler?.(
          options.replyHandler as (payload: Record<string, unknown>) => Promise<unknown>,
        );
        return {
          url: 'http://127.0.0.1:0',
          close: async () => {
            /* no-op */
          },
        };
      },
      _testOnUiEvent: (event) => o.events.push(event),
      ...(o.onActiveThreadBinding ? { _testOnActiveThreadBinding: o.onActiveThreadBinding } : {}),
    });
  }

  it('re-checks queued old-thread dynamic-tool calls before mutating the FSM', async () => {
    interface DonePayload {
      ok: boolean;
    }
    let releaseEntry: (() => void) | undefined;
    let entryStartedResolve!: () => void;
    const entryStarted = new Promise<void>((resolve) => {
      releaseEntry = undefined;
      entryStartedResolve = resolve;
    });
    const machine = aharness.machine({
      id: 'phase3a-queued-old-submit',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { next: exit<DonePayload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b after clear',
          clearOnEntry: true,
          onEntry: async () => {
            entryStartedResolve();
            await new Promise<void>((entryResolve) => {
              releaseEntry = entryResolve;
            });
          },
          exits: { done: exit<DonePayload>({ to: 'c' }) },
        }),
        c: terminal('success'),
      },
    });
    const validator = {
      jsonSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      } as const,
      validate: (input: unknown) => {
        const v = input as { ok?: unknown } | null;
        if (v && typeof v === 'object' && typeof v.ok === 'boolean') {
          return { ok: true as const, data: input };
        }
        return { ok: false as const, errors: [{ path: '/ok', message: 'must be boolean' }] };
      },
    };
    const sidecar = { a: { next: validator }, b: { done: validator } };
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const startupThreadId = 'thread-queued-old-startup';
    const replacementThreadId = 'thread-queued-old-replacement';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: startupThreadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});

      handle.push({
        jsonrpc: '2.0',
        id: 9301,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-first',
          callId: 'first-submit',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'next', data: { ok: true } }),
        },
      });
      await entryStarted;

      handle.push({
        jsonrpc: '2.0',
        id: 9302,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old-queued',
          callId: 'queued-old-submit',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });

      releaseEntry?.();
      const firstReply = await waitForOutbound(
        handle,
        (m) => m.id === 9301 && m.result !== undefined,
      );
      expect(firstReply.result).toMatchObject({ success: true });

      const oldReply = await waitForOutbound(
        handle,
        (m) => m.id === 9302 && m.result !== undefined,
      );
      expect(oldReply.result).toEqual({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'aharness: request belongs to an abandoned thread after clearOnEntry; ignored.',
          },
        ],
      });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnInterrupt);
      handle.replyTo(METHOD.turnInterrupt, {});
      await waitForOutbound(handle, (m) => m.method === METHOD.threadUnsubscribe);
      handle.replyTo(METHOD.threadUnsubscribe, {});
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, {
        thread: { id: replacementThreadId, ephemeral: false },
      });
      await waitForOutbound(
        handle,
        (m) =>
          m.method === METHOD.turnStart &&
          typeof m.params === 'object' &&
          m.params !== null &&
          (m.params as { threadId?: unknown }).threadId === replacementThreadId,
      );
      handle.replyTo(METHOD.turnStart, {});

      handle.push({
        jsonrpc: '2.0',
        id: 9303,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-active',
          callId: 'active-submit',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task4-queued-old-submit.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.event.kind === 'StateChange' && event.event.from === 'b' && event.event.to === 'c',
      ),
    ).toHaveLength(1);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({
        kind: 'AbandonedThreadDiagnostic',
        threadId: startupThreadId,
        source: 'dynamicToolCall',
      }),
    );
  }, 10_000);

  it('keeps live stdout minimal while transition lines replace model deltas and UI events retain visible tool-call events', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const threadId = 'thread-ui-stream-1';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      handle.push({
        jsonrpc: '2.0',
        method: METHOD.agentMessageDelta,
        params: { threadId, turnId: 't-kick', itemId: 'msg-1', delta: 'hello browser' },
      });
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.itemStarted,
        params: {
          threadId,
          turnId: 't-kick',
          item: {
            type: 'mcpToolCall',
            id: 'mcp-1',
            serverName: 'github',
            toolName: 'create_issue',
            params: { title: 'bug' },
          },
        },
      });
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 't-kick',
          item: {
            type: 'mcpToolCall',
            id: 'mcp-1',
            serverName: 'github',
            toolName: 'create_issue',
            status: 'completed',
            output: 'created #1',
          },
        },
      });

      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task4-stream.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    const stdoutText = stdoutChunks.join('');
    expect(stdoutText).not.toContain('hello browser');
    expect(stdoutText).toContain('aharness: transition a --done--> b\n');
    expect(stdoutText.split('\n').some((line) => line.startsWith('[transition]'))).toBe(false);

    expect(events.map((e) => e.event)).toContainEqual({
      kind: 'TurnStarted',
      turnId: 't-kick',
    });
    expect(events.map((e) => e.event)).toContainEqual({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'hello browser',
    });
    expect(events.map((e) => e.event)).toContainEqual({
      kind: 'ItemStarted',
      id: 'mcp-1',
      type: 'function_call',
      name: 'mcp:github/create_issue',
      arguments: JSON.stringify({ title: 'bug' }, null, 2),
    });
    expect(events.map((e) => e.event)).toContainEqual({
      kind: 'ItemStarted',
      id: 'mcp-1:output',
      type: 'function_call_output',
      name: 'mcp:github/create_issue',
      output: 'created #1',
      ok: true,
    });
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({
        kind: 'StateChange',
        from: 'a',
        to: 'b',
        cause: 'submit',
      }),
    );
  }, 10_000);

  it('reports browser UI available, lifecycle, and transition stdout status lines with the direct run target label', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const threadId = 'thread-stdout-status';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});

      handle.push({
        jsonrpc: '2.0',
        id: 9101,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task1-status.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    const text = stdoutChunks.join('');
    expect(text.startsWith('\n')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('aharness: run ');
    expect(text).toContain(' starting task1-status.fsm.ts ');
    expect(text).toContain('aharness: browser UI available at http://127.0.0.1:0');
    expect(text).toContain('aharness: codex launching');
    expect(text).toContain('aharness: codex ready thread=thread-stdout-status state=a');
    expect(text).toContain('aharness: transition a --done--> b\n');
    expect(text.split('\n').some((line) => line.startsWith('[transition]'))).toBe(false);
    const runRoot = onlyRunRootForCliRegression(repoRoot);
    expect(stdoutLines(stdoutChunks).filter((line) => line.includes('run completed'))).toEqual([
      `aharness: run completed state=b terminal=success dir=${runRoot}`,
    ]);
    expect(text).not.toContain('aharness: run failed');
  }, 10_000);

  it('reports one failed stdout summary for framework-detected app-server failures', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    writeFileSync(join(repoRoot, 'task4-failed-summary.fsm.ts'), '// stub fsm\n');

    const result = await runCliForTest({
      fsmPath: 'task4-failed-summary.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/task4-failed-summary.fsm.ts.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'task4-failed-summary.fsm.ts',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () => {
        throw new Error('forced spawn failure');
      }) as unknown as RunCliTestHooks['spawnAppServer'],
      startUiServerImpl: async () => ({
        url: 'http://127.0.0.1:0',
        close: async () => {
          /* no-op */
        },
      }),
      _testOnUiEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('aharness: app-server failed: forced spawn failure');
    const runRoot = onlyRunRootForCliRegression(repoRoot);
    expect(stdoutLines(stdoutChunks).filter((line) => line.includes('run failed'))).toEqual([
      `aharness: run failed state=a reason=app-server failed: forced spawn failure dir=${runRoot}`,
    ]);
    expect(stdoutChunks.join('')).not.toContain('aharness: run completed');
  });

  it('keeps stdout failure reasons single-line and sanitized while preserving detailed stderr', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    writeFileSync(join(repoRoot, 'task4-sanitized-failure.fsm.ts'), '// stub fsm\n');
    const detailedMessage =
      `forced spawn failure ${'more context '.repeat(40)}\n` +
      '    at stackFrame (/tmp/example.js:1:2)\n' +
      'stderr:\n' +
      'child process emitted private diagnostics that should stay off stdout\n' +
      'private second diagnostic line';

    const result = await runCliForTest({
      fsmPath: 'task4-sanitized-failure.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/task4-sanitized-failure.fsm.ts.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'task4-sanitized-failure.fsm.ts',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async () => {
        throw new Error(detailedMessage);
      }) as unknown as RunCliTestHooks['spawnAppServer'],
      startUiServerImpl: async () => ({
        url: 'http://127.0.0.1:0',
        close: async () => {
          /* no-op */
        },
      }),
    });

    expect(result.exitCode).toBe(1);
    const stderrText = stderrBuf.join('');
    expect(stderrText).toContain('at stackFrame');
    expect(stderrText).toContain('stderr:\nchild process emitted private diagnostics');

    const failedLines = stdoutLines(stdoutChunks).filter((line) => line.includes('run failed'));
    expect(failedLines).toHaveLength(1);
    const failedLine = failedLines[0]!;
    expect(failedLine).toContain('reason=app-server failed: forced spawn failure more context');
    expect(failedLine).toContain('...');
    expect(failedLine).not.toContain('at stackFrame');
    expect(failedLine).not.toContain('stderr:');
    expect(failedLine).not.toContain('child process emitted private diagnostics');
    expect(failedLine).not.toContain('private second diagnostic line');
  });

  it('reports a failed stdout summary when FSM loading fails after run start', async () => {
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    writeFileSync(join(repoRoot, 'task4-load-failure.fsm.ts'), '// stub fsm\n');

    const result = await runCliForTest({
      fsmPath: 'task4-load-failure.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      loadFsmImpl: (async () => {
        throw new Error('load failure');
      }) as unknown as RunCliTestHooks['loadFsmImpl'],
    });

    expect(result.exitCode).toBe(2);
    expect(stderrBuf.join('')).toContain('aharness: failed to load FSM: load failure');
    const runRoot = onlyRunRootForCliRegression(repoRoot);
    expect(stdoutLines(stdoutChunks).filter((line) => line.includes('run failed'))).toEqual([
      `aharness: run failed reason=failed to load FSM: load failure dir=${runRoot}`,
    ]);
  });

  it('reports a failed stdout summary when auth precheck fails after run start', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    writeFileSync(join(repoRoot, 'task4-auth-failure.fsm.ts'), '// stub fsm\n');

    const result = await runCliForTest({
      fsmPath: 'task4-auth-failure.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => false,
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/task4-auth-failure.fsm.ts.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'task4-auth-failure.fsm.ts',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
    });

    expect(result.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('aharness: ~/.codex/auth.json not found');
    const runRoot = onlyRunRootForCliRegression(repoRoot);
    expect(stdoutLines(stdoutChunks).filter((line) => line.includes('run failed'))).toEqual([
      `aharness: run failed reason=~/.codex/auth.json not found. Run \`codex login\` first. dir=${runRoot}`,
    ]);
  });

  it('reports a failed stdout summary for invalid input flags', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { stdout: invalidStdout, chunks: invalidStdoutChunks } = makeStdoutCapture();
    writeFileSync(join(repoRoot, 'task4-input-failure.fsm.ts'), '// stub fsm\n');

    const invalidResult = await runCliForTest({
      fsmPath: 'task4-input-failure.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: invalidStdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      inputArgs: ['--target-name'],
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/task4-input-failure.fsm.ts.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'task4-input-failure.fsm.ts',
        inputSchema: {
          type: 'object',
          required: ['targetName'],
          properties: { targetName: { type: 'string' } },
          additionalProperties: false,
        },
        inputFlags: { targetName: { description: 'Target name' } },
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
    });

    expect(invalidResult.exitCode).toBe(2);
    expect(stderrBuf.join('')).toContain('aharness: invalid input flags:\n');
    const invalidRunRoot = onlyRunRootForCliRegression(repoRoot);
    const invalidFailedLines = stdoutLines(invalidStdoutChunks).filter((line) =>
      line.includes('run failed'),
    );
    expect(invalidFailedLines).toHaveLength(1);
    expect(invalidFailedLines[0]).toContain(
      `aharness: run failed reason=aharness: invalid input flags: flag --target-name requires a value`,
    );
    expect(invalidFailedLines[0]).toContain(` dir=${invalidRunRoot}`);
  });

  it('reports a failed stdout summary for no-input-fields failures', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { stdout: noInputStdout, chunks: noInputStdoutChunks } = makeStdoutCapture();
    writeFileSync(join(repoRoot, 'task4-no-input-failure.fsm.ts'), '// stub fsm\n');

    const noInputResult = await runCliForTest({
      fsmPath: 'task4-no-input-failure.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: noInputStdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      inputArgs: ['--unknown'],
      loadFsmImpl: (async () => ({
        machine,
        sidecar,
        modulePath: '/tmp/task4-no-input-failure.fsm.ts.mjs',
        issues: [],
        skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
        cacheHit: false,
        hash: 'task4-no-input-failure.fsm.ts',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
    });

    expect(noInputResult.exitCode).toBe(2);
    expect(stderrBuf.join('')).toContain(
      'aharness: FSM declares no input fields; unknown flags: --unknown',
    );
    const noInputRunRoot = onlyRunRootForCliRegression(repoRoot);
    expect(stdoutLines(noInputStdoutChunks).filter((line) => line.includes('run failed'))).toEqual([
      `aharness: run failed reason=FSM declares no input fields; unknown flags: --unknown dir=${noInputRunRoot}`,
    ]);
  });

  it('reports canonical built-in transition stdout lines using the state-change cause', async () => {
    const fsm = createFsm<Record<string, never>>();
    const machine = fsm.machine({
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'state a active',
          on: {
            permissionRequest: {
              match: '^Bash$',
              to: 'b',
              return: () => 'accept',
            },
          },
        }),
        b: fsm.final({ outcome: 'success' }),
      },
    });
    const sidecar = {};
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const threadId = 'thread-canonical-transition';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});

      handle.push({
        jsonrpc: '2.0',
        id: 9201,
        method: METHOD.commandExecutionRequestApproval,
        params: {
          threadId,
          turnId: 't-kick',
          itemId: 'cmd-1',
          command: 'echo hi',
          cwd: repoRoot,
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task3-canonical-transition.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    const text = stdoutChunks.join('');
    expect(text).toContain('aharness: transition a --always--> b\n');
    expect(text.split('\n').some((line) => line.startsWith('[transition]'))).toBe(false);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({
        kind: 'StateChange',
        from: 'a',
        to: 'b',
        cause: 'always',
      }),
    );
  }, 10_000);

  it('reports owner-choice transition stdout lines using the state-change cause', async () => {
    const fsm = createFsm<Record<string, never>>();
    const machine = fsm.machine({
      initial: 'pick',
      states: {
        pick: fsm.choice({
          question: 'Pick a route',
          options: [{ label: 'Done', to: 'done' }],
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const sidecar = {};
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout, chunks: stdoutChunks } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const threadId = 'thread-choice-transition';
    let replyHandler: ((payload: Record<string, unknown>) => Promise<unknown>) | undefined;

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      const start = Date.now();
      while (
        Date.now() - start < 2_000 &&
        !events.some((entry) => entry.event.kind === 'OwnerChoice')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!replyHandler) throw new Error('reply handler was not captured');
      await expect(
        replyHandler({
          kind: 'owner-choice',
          state: 'pick',
          visitCount: 1,
          label: 'Done',
        }),
      ).resolves.toEqual({ status: 200, body: { ok: true } });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task3-owner-choice-transition.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
      onReplyHandler: (handler) => {
        replyHandler = handler;
      },
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    const text = stdoutChunks.join('');
    expect(text).toContain('aharness: transition pick --choice--> done\n');
    expect(text.split('\n').some((line) => line.startsWith('[transition]'))).toBe(false);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({
        kind: 'StateChange',
        from: 'pick',
        to: 'done',
        cause: 'choice',
      }),
    );
  }, 10_000);

  it('publishes FrameworkNote for kickoff, cross-state, and drive-forward orientation turns', async () => {
    interface Payload {
      ok: boolean;
    }
    const machine = aharness.machine({
      id: 'phase3a-framework-notes',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { next: exit<Payload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          exits: { done: exit<Payload>({ to: 'c' }) },
        }),
        c: terminal('success'),
      },
    });
    const validator = {
      jsonSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      } as const,
      validate: (input: unknown) => {
        const v = input as { ok?: unknown } | null;
        if (v && typeof v === 'object' && typeof v.ok === 'boolean') {
          return { ok: true as const, data: input };
        }
        return { ok: false as const, errors: [{ path: '/ok', message: 'must be boolean' }] };
      },
    };
    const sidecar = { a: { next: validator }, b: { done: validator } };
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const threadId = 'thread-ui-notes';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-kick' } },
      });

      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-kick',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'next', data: { ok: true } }),
        },
      });
      await waitForOutbound(handle, (m) => m.id === 9001 && m.result !== undefined);
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: { threadId, item: { type: 'dynamicToolCall', id: 'call-1' } },
      });
      await waitForOutbound(handle, (m) => m.method === METHOD.turnInterrupt);
      handle.replyTo(METHOD.turnInterrupt, {});

      await waitForOutbound(
        handle,
        (m) => m.method === METHOD.turnStart && handle.outbound.indexOf(m) > 0,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-cross' } },
      });

      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId, turn: { id: 't-cross' } },
      });
      await waitForOutbound(
        handle,
        (m) =>
          m.method === METHOD.turnStart &&
          handle.outbound.filter((x) => x.method === METHOD.turnStart).length >= 3,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-forward' } },
      });

      handle.push({
        jsonrpc: '2.0',
        id: 9002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-forward',
          callId: 'call-2',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task4-notes.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    const turnStartTexts = handle.outbound
      .filter((m) => m.method === METHOD.turnStart)
      .map(
        (m) => (m as { params?: { input?: Array<{ text?: string }> } }).params?.input?.[0]?.text,
      );
    expect(turnStartTexts).toEqual([
      expect.stringContaining('state a active'),
      expect.stringContaining('state b active'),
      expect.stringContaining('state b active'),
    ]);

    const frameworkNotes = events
      .map((e) => e.event)
      .filter((event) => event.kind === 'FrameworkNote');
    expect(frameworkNotes).toEqual([
      expect.objectContaining({
        kind: 'FrameworkNote',
        variant: 'orientation',
        text: expect.stringContaining('state a active'),
      }),
      expect.objectContaining({
        kind: 'FrameworkNote',
        variant: 'orientation',
        text: expect.stringContaining('state b active'),
      }),
      expect.objectContaining({
        kind: 'FrameworkNote',
        variant: 'orientation',
        text: expect.stringContaining('state b active'),
      }),
    ]);
  }, 10_000);

  it('publishes TurnCompleted for the parent thread and keeps sub-thread notifications filtered', async () => {
    const { machine, sidecar } = buildTwoStateMachineAndSidecar();
    const { handle, connect } = makeSyntheticConnectStub();
    const { stdout } = makeStdoutCapture();
    const events: ReplayableAppEvent[] = [];
    const threadId = 'thread-ui-turns';

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-parent' } },
      });

      handle.push({
        jsonrpc: '2.0',
        method: METHOD.itemStarted,
        params: {
          threadId,
          item: { type: 'spawnAgentToolCall', id: 'spawn-1', receiverThreadIds: ['thread-sub'] },
        },
      });
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId: 'thread-sub', turn: { id: 't-sub' } },
      });
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId, turn: { id: 't-parent' } },
      });

      await waitForOutbound(
        handle,
        (m) => m.method === METHOD.turnStart && handle.outbound.indexOf(m) > 0,
      );
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 't-after-parent-completed' } },
      });

      handle.push({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 't-after-parent-completed',
          callId: 'call-1',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runWithTask4Aharness({
      fsmName: 'task4-turns.fsm.ts',
      machine,
      sidecar,
      connect: connect as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      stdout,
      events,
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    expect(events.map((e) => e.event).filter((event) => event.kind === 'TurnCompleted')).toEqual([
      {
        kind: 'TurnCompleted',
        turnId: 't-parent',
        finishReason: 'stop',
      },
    ]);
  }, 10_000);
});
