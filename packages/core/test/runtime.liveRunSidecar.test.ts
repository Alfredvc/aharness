import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFsm } from '../src/index.js';
import type { AppServerHandle } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import type { LiveRunLoadedFsm, LiveRunReporter } from '../src/runtime/liveRunEngine.js';
import { runLiveRunEngine } from '../src/runtime/liveRunEngine.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';
import type { BrowserReplyController } from '../src/ui/reply.js';
import type { ReplayableAppEvent } from '../src/ui/events.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRepo(): { readonly repoRoot: string; readonly fsmPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'aharness-live-sidecar-'));
  tempRoots.push(repoRoot);
  const fsmPath = join(repoRoot, 'sidecar.fsm.ts');
  writeFileSync(fsmPath, '// test fsm\n');
  return { repoRoot, fsmPath };
}

function reporter(): LiveRunReporter {
  return {
    runStarting: () => undefined,
    browserReady: () => undefined,
    codexLaunching: () => undefined,
    codexReady: () => undefined,
    transition: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
  };
}

function writableSink(): NodeJS.WritableStream {
  return {
    write: () => true,
  } as NodeJS.WritableStream;
}

function loadedFsm(machine: LiveRunLoadedFsm['machine'], repoRoot: string): LiveRunLoadedFsm {
  return {
    machine,
    sidecar: {},
    modulePath: join(repoRoot, 'sidecar.mjs'),
    issues: [],
    cacheHit: false,
    hash: 'sidecar',
    skillOriginManifest: {
      rootSourceDir: repoRoot,
      sourceDirPrefixes: [],
      availableSkills: [],
    },
    sourceLocations: {
      states: { work: { sourceFile: join(repoRoot, 'sidecar.fsm.ts'), line: 1 } },
      exits: {},
      whenBranches: {},
      stateSkills: {},
      availableSkills: [],
    },
  };
}

function replyToSkillPreflight(
  transport: Transport,
  envelope: { readonly id?: number | string; readonly method?: string; readonly params?: unknown },
  repoRoot: string,
): boolean {
  if (envelope.method === METHOD.skillsExtraRootsSet) {
    queueMicrotask(() => transport.onMessage?.({ jsonrpc: '2.0', id: envelope.id, result: {} }));
    return true;
  }
  if (envelope.method === METHOD.skillsList) {
    queueMicrotask(() =>
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: envelope.id,
        result: { data: [{ cwd: repoRoot, skills: [], errors: [] }] },
      }),
    );
    return true;
  }
  return false;
}

function commandRequestId(event: ReplayableAppEvent): string | null {
  const body = event.event as { kind?: unknown; method?: unknown; requestId?: unknown };
  return body.kind === 'ServerRequest' &&
    body.method === METHOD.commandExecutionRequestApproval &&
    typeof body.requestId === 'string'
    ? body.requestId
    : null;
}

describe('runLiveRunEngine sidecar wiring', () => {
  it('binds sidecar ops, routes sidecar approvals through the browser, pauses timeout, emits events, and shuts down sidecars first', async () => {
    vi.useFakeTimers();
    const { repoRoot, fsmPath } = tempRepo();
    const lifecycle: string[] = [];
    const parentTurnStarts: unknown[] = [];
    let browserReplyController: BrowserReplyController | undefined;
    let resolveApprovalRequest!: (requestId: string) => void;
    const approvalRequest = new Promise<string>((resolve) => {
      resolveApprovalRequest = resolve;
    });

    const fsm = createFsm<{ status: string | null }>();
    const events = fsm.withEvents({
      sidecarDone: fsm.event<{ status: string }>(),
    });
    const machine = events.machine({
      id: 'live-sidecar',
      data: () => ({ status: null }),
      initial: 'work',
      states: {
        work: events.state({
          prompt: 'work',
          entry: async (_data, ops) => {
            const thread = await ops.codex.createThread('helper', {
              defaultTurnTimeoutMs: 100,
            });
            const result = await thread.send('inspect');
            await ops.emit('sidecarDone', {
              status: result.ok ? result.kind : result.reason,
            });
          },
          on: {
            sidecarDone: {
              to: 'done',
              reduce: (draft, payload) => {
                draft.status = payload.status;
              },
            },
          },
        }),
        done: events.final({
          outcome: 'success',
          artifacts: {
            'status.txt': (data) => data.status ?? 'missing',
          },
        }),
      },
    });

    let threadStartCount = 0;
    const connectHeadlessWs = async (opts: ConnectHeadlessWsOptions) => {
      const transport: Transport = {
        send(message: unknown) {
          const envelope = message as {
            readonly id?: number | string;
            readonly method?: string;
            readonly params?: unknown;
            readonly result?: unknown;
          };
          if (replyToSkillPreflight(transport, envelope, repoRoot)) return;
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { serverInfo: { name: 'stub', version: '0.0.0' } },
              }),
            );
            return;
          }
          if (envelope.method === METHOD.threadStart) {
            threadStartCount += 1;
            const threadId = threadStartCount === 1 ? 'parent-thread' : 'sidecar-thread';
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { thread: { id: threadId, ephemeral: threadStartCount !== 1 } },
              }),
            );
            return;
          }
          if (envelope.method === METHOD.turnStart) {
            const params = envelope.params as { readonly threadId?: string };
            if (params.threadId === 'parent-thread') {
              parentTurnStarts.push(envelope.params);
            }
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { turn: { id: 'sidecar-turn' } },
              }),
            );
            if (params.threadId === 'sidecar-thread') {
              queueMicrotask(() =>
                transport.onMessage?.({
                  jsonrpc: '2.0',
                  id: 700,
                  method: METHOD.commandExecutionRequestApproval,
                  params: {
                    threadId: 'sidecar-thread',
                    turnId: 'sidecar-turn',
                    itemId: 'sidecar-command',
                    command: 'pnpm test',
                    cwd: repoRoot,
                  },
                }),
              );
            }
            return;
          }
          if (envelope.method === METHOD.threadUnsubscribe) {
            lifecycle.push('thread.unsubscribe');
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { status: 'unsubscribed' },
              }),
            );
            return;
          }
          if (envelope.method === METHOD.turnInterrupt) {
            lifecycle.push('turn.interrupt');
            queueMicrotask(() =>
              transport.onMessage?.({ jsonrpc: '2.0', id: envelope.id, result: {} }),
            );
            return;
          }
          if (envelope.id === 700 && envelope.result !== undefined) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                method: METHOD.agentMessageDelta,
                params: {
                  threadId: 'sidecar-thread',
                  turnId: 'sidecar-turn',
                  itemId: 'assistant',
                  delta: 'done',
                },
              }),
            );
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                method: METHOD.turnCompleted,
                params: { threadId: 'sidecar-thread', turn: { id: 'sidecar-turn' } },
              }),
            );
          }
        },
        close() {
          lifecycle.push('client.close');
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
    };

    const appServer: AppServerHandle = {
      wsUrl: 'ws+unix:///tmp/sidecar.sock',
      port: null,
      sockPath: '/tmp/sidecar.sock',
      close: async () => {
        lifecycle.push('appServer.close');
      },
    };
    const resultPromise = runLiveRunEngine({
      target: { filePath: fsmPath, repoRoot },
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
      loadFsm: async () => loadedFsm(machine, repoRoot),
      authPrecheck: () => ({ ok: true }),
      resolveInput: () => ({ ok: true }),
      ui: { serve: false },
      diagnostics: writableSink(),
      createReporter: () => reporter(),
      spawnAppServer: async () => appServer,
      connectHeadlessWs,
      startUiServer: (() => {
        throw new Error('UI server should not start');
      }) as never,
      onBrowserReplyController: (controller) => {
        browserReplyController = controller;
      },
      onUiEvent: (event) => {
        const requestId = commandRequestId(event);
        if (requestId !== null) resolveApprovalRequest(requestId);
      },
    });

    const requestId = await approvalRequest;
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle).not.toContain('turn.interrupt');
    expect(browserReplyController).toBeDefined();
    const reply = await browserReplyController!.handleReply({
      kind: 'approval',
      requestId,
      decision: 'accept',
    });
    expect(reply).toEqual({ status: 200, body: { ok: true } });

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(parentTurnStarts).toEqual([]);
    expect(lifecycle).toEqual(['thread.unsubscribe', 'client.close', 'appServer.close']);
    expect(readFileSync(join(result.runDir!, 'artifacts', 'status.txt'), 'utf8')).toBe('completed');
  });
});
