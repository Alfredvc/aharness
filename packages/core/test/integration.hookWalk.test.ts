import { connect } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOOK_WALK_FSM_SOURCE, hookWalkMachine } from '@aharness/test-support';

import { runCliForTest, type RunCliTestHooks } from '../src/cli/runCli.js';
import type { AppServerHandle } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import { METHOD } from '../src/protocol/methodNames.js';
import { encodeFramed, parseFramedReply, type RequestType } from '../src/protocol/wireFraming.js';
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
  readonly outbound: ReadonlyArray<{ id?: number; method?: string; result?: unknown }>;
  push(envelope: unknown): void;
  replyTo(method: string, result: unknown): void;
}

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

  const connectStub = (async (opts: ConnectHeadlessWsOptions) => {
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

  return { handle, connect: connectStub };
}

async function waitForOutbound(
  handle: SyntheticTransportHandle,
  predicate: (envelope: { id?: number; method?: string; result?: unknown }) => boolean,
  timeoutMs = 2_000,
): Promise<{ id?: number; method?: string; result?: unknown }> {
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

async function sendHookFrame(
  path: string,
  type: RequestType,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolveP, rejectP) => {
    const socket = connect(path);
    const chunks: Buffer[] = [];
    socket.on('error', rejectP);
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => {
      const parsed = parseFramedReply(Buffer.concat(chunks));
      if (!parsed.ok) {
        rejectP(new Error(parsed.error));
        return;
      }
      if (parsed.value.status !== 'OK') {
        rejectP(new Error(parsed.value.body));
        return;
      }
      resolveP(JSON.parse(parsed.value.body) as Record<string, unknown>);
    });
    socket.on('connect', () => {
      socket.write(encodeFramed(type, JSON.stringify(body)));
      socket.end();
    });
  });
}

async function waitForSocket(path: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      await new Promise<void>((resolveP, rejectP) => {
        const socket = connect(path);
        socket.once('connect', () => {
          socket.destroy();
          resolveP();
        });
        socket.once('error', rejectP);
      }).catch(() => undefined);
      if (existsSync(path)) return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for hook socket ${path}`);
}

function onlyRunRoot(repoRoot: string): string {
  const runsRoot = join(repoRoot, '.harness', 'runs');
  const dirs = readdirSync(runsRoot)
    .map((name) => join(runsRoot, name))
    .filter((path) => statSync(path).isDirectory());
  expect(dirs).toHaveLength(1);
  return dirs[0]!;
}

describe('runCliForTest — Phase 2d hook walk', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'h-hook-walk-'));
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

  it('boots a hook-declaring FSM, passes hook overrides, and routes frames to the active state', async () => {
    const fsmPath = join(repoRoot, 'hookWalk.fsm.ts');
    writeFileSync(fsmPath, HOOK_WALK_FSM_SOURCE);

    const sidecar = {
      hooked: {
        next: {
          jsonSchema: { type: 'object' as const, properties: {} },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
      quiet: {
        finish: {
          jsonSchema: { type: 'object' as const, properties: {} },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const { handle, connect: connectWs } = makeSyntheticConnectStub();
    const threadId = 'thread-hook-walk';
    let spawnOverrides: ReadonlyArray<readonly [string, string]> | undefined;

    const driver = async (): Promise<void> => {
      await waitForOutbound(handle, (m) => m.method === METHOD.threadStart);
      handle.replyTo(METHOD.threadStart, { thread: { id: threadId, ephemeral: false } });

      const runRoot = onlyRunRoot(repoRoot);
      const hookSocketPath = join(runRoot, 'hook.sock');
      await waitForSocket(hookSocketPath);

      const common = {
        session_id: threadId,
        cwd: repoRoot,
        transcript_path: null,
        model: 'm',
        permission_mode: 'default',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: {},
        triggered_at: '2026-05-13T00:00:00Z',
      };
      await expect(sendHookFrame(hookSocketPath, 'PRE_TOOL_USE', common)).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'pre from hooked',
        },
      });
      await expect(
        sendHookFrame(hookSocketPath, 'POST_TOOL_USE', {
          ...common,
          hook_event_name: 'PostToolUse',
          tool_response: {},
        }),
      ).resolves.toEqual({
        hookSpecificOutput: { additionalContext: 'post from hooked' },
      });
      await expect(
        sendHookFrame(hookSocketPath, 'USER_PROMPT_SUBMIT', {
          session_id: threadId,
          cwd: repoRoot,
          transcript_path: null,
          model: 'm',
          permission_mode: 'default',
          turn_id: 'turn-1',
          prompt: 'hello',
          triggered_at: '2026-05-13T00:00:00Z',
        }),
      ).resolves.toEqual({
        hookSpecificOutput: { additionalContext: 'prompt from hooked' },
      });

      await waitForOutbound(handle, (m) => m.method === METHOD.turnStart);
      handle.replyTo(METHOD.turnStart, {});
      handle.push({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 'turn-1' } },
      });

      handle.push({
        jsonrpc: '2.0',
        id: 9101,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-1',
          callId: 'call-next',
          tool: 'harness_submit',
          arguments: JSON.stringify({ state: 'hooked', exit: 'next', data: {} }),
        },
      });
      await waitForOutbound(handle, (m) => m.id === 9101 && m.result !== undefined);
      await expect(sendHookFrame(hookSocketPath, 'PRE_TOOL_USE', common)).resolves.toEqual({});

      handle.push({
        jsonrpc: '2.0',
        id: 9102,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-1',
          callId: 'call-finish',
          tool: 'harness_submit',
          arguments: JSON.stringify({ state: 'quiet', exit: 'finish', data: {} }),
        },
      });
    };

    const driverErr: { value: Error | null } = { value: null };
    const driverPromise = driver().catch((e) => {
      driverErr.value = e as Error;
    });

    const result = await runCliForTest({
      fsmPath: 'hookWalk.fsm.ts',
      cwd: repoRoot,
      stderr: stderrSink,
      stdout: process.stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      authJsonExists: () => true,
      loadFsmImpl: (async () => ({
        machine: hookWalkMachine,
        sidecar,
        modulePath: '/tmp/hookWalk.mjs',
        issues: [],
        cacheHit: false,
        hash: 'hook-walk',
      })) as unknown as RunCliTestHooks['loadFsmImpl'],
      spawnAppServer: (async (opts) => {
        spawnOverrides = opts.cliOverrides;
        return makeStubAppServer();
      }) as RunCliTestHooks['spawnAppServer'],
      connectHeadlessWsImpl: connectWs as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
    });

    await driverPromise;
    if (driverErr.value) throw driverErr.value;

    expect(result.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    expect(spawnOverrides).toEqual(
      expect.arrayContaining([
        ['hooks.PreToolUse', expect.stringMatching(/hooks = .*pre_tool_use\.sh.*timeout = 30/)],
        ['hooks.PostToolUse', expect.stringMatching(/hooks = .*post_tool_use\.sh.*timeout = 30/)],
        [
          'hooks.UserPromptSubmit',
          expect.stringMatching(/hooks = .*user_prompt_submit\.sh.*timeout = 30/),
        ],
      ]),
    );
  }, 10_000);
});
