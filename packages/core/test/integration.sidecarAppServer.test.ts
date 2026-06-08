import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFsm } from '../src/index.js';
import type { AppServerHandle } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type {
  CommandExecutionRequestApprovalParams,
  ToolRequestUserInputParams,
} from '../src/protocol/index.js';
import type { ActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import {
  runLiveRunEngine,
  type LiveRunLoadedFsm,
  type LiveRunReporter,
} from '../src/runtime/liveRunEngine.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';
import type { ReplayableAppEvent } from '../src/ui/events.js';
import type { BrowserReplyController } from '../src/ui/reply.js';
import { RUN_EVENT_SCHEMA, type RunEventEnvelope } from '../src/runEvents/index.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface FakeRunInput {
  readonly repoRoot: string;
  readonly fsmPath: string;
}

interface SidecarScriptContext {
  readonly transport: Transport;
  readonly threadId: string;
  readonly turnId: string;
  completeAfterServerResponse(requestId: string | number): void;
}

interface SidecarFakeTransportOptions {
  readonly repoRoot: string;
  readonly activeBinding: () => ActiveThreadBinding | undefined;
  readonly parentThreadSnapshots: string[];
  readonly parentTurnStarts: unknown[];
  readonly onSidecarTurnStarted: (context: SidecarScriptContext) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function tempRepo(prefix: string): FakeRunInput {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(repoRoot);
  const fsmPath = join(repoRoot, 'sidecar.fsm.ts');
  writeFileSync(fsmPath, '// sidecar integration fixture\n');
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

function fakeAppServer(): AppServerHandle {
  return {
    wsUrl: 'ws+unix:///tmp/sidecar-integration.sock',
    port: null,
    sockPath: '/tmp/sidecar-integration.sock',
    close: async () => undefined,
  } as AppServerHandle;
}

function loadedFsm(machine: LiveRunLoadedFsm['machine'], input: FakeRunInput): LiveRunLoadedFsm {
  return {
    machine,
    sidecar: {},
    modulePath: join(input.repoRoot, 'sidecar.mjs'),
    issues: [],
    cacheHit: false,
    hash: 'sidecar-integration',
    skillOriginManifest: {
      rootSourceDir: input.repoRoot,
      sourceDirPrefixes: [],
      availableSkills: [],
    },
    sourceLocations: {
      states: { work: { sourceFile: input.fsmPath, line: 1 } },
      exits: {},
      whenBranches: {},
      stateSkills: {},
      availableSkills: [],
    },
  };
}

function readJsonl(eventsPath: string): RunEventEnvelope[] {
  return readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEventEnvelope);
}

function sidecarStatusPayload(result: {
  readonly ok: boolean;
  readonly kind?: string;
  readonly reason?: string;
}): {
  readonly status: string;
} {
  return { status: result.ok ? (result.kind ?? 'ok') : (result.reason ?? 'failed') };
}

function buildCompletedSidecarMachine() {
  const base = createFsm<{ status: string }>();
  const fsm = base.withEvents({
    sidecarDone: base.event<{ status: string }>(),
  });
  return fsm.machine({
    id: 'sidecar-completed-integration',
    data: () => ({ status: 'pending' }),
    initial: 'work',
    states: {
      work: fsm.state({
        prompt: 'work',
        entry: async (_data, ops) => {
          const thread = await ops.codex.createThread('helper', { label: 'Helper' });
          const result = await thread.send('complete sidecar work');
          await thread.close();
          await ops.emit('sidecarDone', sidecarStatusPayload(result));
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
      done: fsm.final({
        outcome: 'success',
        artifacts: {
          'status.txt': (data) => data.status,
        },
      }),
    },
  });
}

function buildInputRequestSidecarMachine() {
  const base = createFsm<{ status: string }>();
  const fsm = base.withEvents({
    sidecarDone: base.event<{ status: string }>(),
  });
  return fsm.machine({
    id: 'sidecar-input-integration',
    data: () => ({ status: 'pending' }),
    initial: 'work',
    states: {
      work: fsm.state({
        prompt: 'work',
        entry: async (_data, ops) => {
          const thread = await ops.codex.createThread('helper');
          const first = await thread.send('ask for missing detail');
          if (!first.ok || first.kind !== 'needsInput') {
            await thread.close();
            await ops.emit('sidecarDone', sidecarStatusPayload(first));
            return;
          }
          const answered = await thread.answer(first.request.id, {
            direction: 'Use the documented route.',
          });
          await thread.close();
          await ops.emit('sidecarDone', sidecarStatusPayload(answered));
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
      done: fsm.final({
        outcome: 'success',
        artifacts: {
          'status.txt': (data) => data.status,
        },
      }),
    },
  });
}

function buildApprovalSidecarMachine(permissionHookCalls: { value: number }) {
  const base = createFsm<{ status: string }>();
  const fsm = base.withEvents({
    sidecarDone: base.event<{ status: string }>(),
  });
  return fsm.machine({
    id: 'sidecar-approval-integration',
    data: () => ({ status: 'pending' }),
    initial: 'work',
    states: {
      work: fsm.state({
        prompt: 'work',
        hooks: {
          permissionRequest: [
            {
              matcher: '^Bash$',
              handler: () => {
                permissionHookCalls.value += 1;
                return 'decline';
              },
            },
          ],
        },
        entry: async (_data, ops) => {
          const thread = await ops.codex.createThread('helper');
          const result = await thread.send('request a browser approval');
          await thread.close();
          await ops.emit('sidecarDone', sidecarStatusPayload(result));
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
      done: fsm.final({
        outcome: 'success',
        artifacts: {
          'status.txt': (data) => data.status,
        },
      }),
    },
  });
}

function connectHeadlessWsWithSidecarScript(opts: SidecarFakeTransportOptions): (
  connectOptions: ConnectHeadlessWsOptions,
) => Promise<{
  readonly client: JsonRpcClient;
  readonly close: () => Promise<void>;
}> {
  return async (connectOptions) => {
    let threadStartCount = 0;
    let sidecarTurnCount = 0;
    const responseCompletionById = new Map<string | number, SidecarScriptContext>();
    const transport: Transport = {
      send(message: unknown): void {
        const envelope = message as {
          readonly id?: number | string;
          readonly method?: string;
          readonly params?: unknown;
          readonly result?: unknown;
        };
        if (
          envelope.method === undefined &&
          envelope.id !== undefined &&
          envelope.result !== undefined
        ) {
          const context = responseCompletionById.get(envelope.id);
          if (context !== undefined) {
            responseCompletionById.delete(envelope.id);
            queueMicrotask(() => emitSidecarCompleted(context));
          }
          return;
        }
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
        if (envelope.method === METHOD.skillsExtraRootsSet) {
          queueMicrotask(() =>
            transport.onMessage?.({ jsonrpc: '2.0', id: envelope.id, result: {} }),
          );
          return;
        }
        if (envelope.method === METHOD.skillsList) {
          queueMicrotask(() =>
            transport.onMessage?.({
              jsonrpc: '2.0',
              id: envelope.id,
              result: { data: [{ cwd: opts.repoRoot, skills: [], errors: [] }] },
            }),
          );
          return;
        }
        if (envelope.method === METHOD.threadStart) {
          threadStartCount += 1;
          const threadId =
            threadStartCount === 1 ? 'parent-thread' : `sidecar-thread-${threadStartCount - 1}`;
          if (threadStartCount > 1) {
            opts.parentThreadSnapshots.push(opts.activeBinding()?.current() ?? '<unset>');
          }
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
            opts.parentTurnStarts.push(envelope.params);
          }
          if (
            typeof params.threadId === 'string' &&
            params.threadId.startsWith('sidecar-thread-')
          ) {
            opts.parentThreadSnapshots.push(opts.activeBinding()?.current() ?? '<unset>');
            sidecarTurnCount += 1;
            const turnId = `sidecar-turn-${sidecarTurnCount}`;
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { turn: { id: turnId } },
              }),
            );
            queueMicrotask(() => {
              transport.onMessage?.({
                jsonrpc: '2.0',
                method: METHOD.turnStarted,
                params: { threadId: params.threadId, turn: { id: turnId } },
              });
              const context: SidecarScriptContext = {
                transport,
                threadId: params.threadId,
                turnId,
                completeAfterServerResponse(requestId) {
                  responseCompletionById.set(requestId, context);
                },
              };
              opts.onSidecarTurnStarted(context);
            });
            return;
          }
          queueMicrotask(() =>
            transport.onMessage?.({
              jsonrpc: '2.0',
              id: envelope.id,
              result: { turn: { id: 'parent-turn' } },
            }),
          );
          return;
        }
        if (envelope.method === METHOD.threadUnsubscribe) {
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
          queueMicrotask(() =>
            transport.onMessage?.({ jsonrpc: '2.0', id: envelope.id, result: {} }),
          );
        }
      },
      async close() {
        /* no-op */
      },
    };
    const client = new JsonRpcClient(transport);
    connectOptions.registerHandlers?.(client);
    await client.request(METHOD.initialize, {
      clientInfo: connectOptions.clientInfo,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  };
}

async function runWithFakeSidecarAppServer(input: {
  readonly machine: LiveRunLoadedFsm['machine'];
  readonly fakeRun: FakeRunInput;
  readonly onSidecarTurnStarted: (context: SidecarScriptContext) => void;
  readonly onUiEvent?: (event: ReplayableAppEvent) => void;
  readonly onBrowserReplyController?: (controller: BrowserReplyController) => void;
  readonly readPendingOwnerInputRequestCount?: (read: () => number) => void;
  readonly onActiveThreadBinding?: (binding: ActiveThreadBinding) => void;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof runLiveRunEngine>>;
  readonly events: RunEventEnvelope[];
  readonly parentThreadSnapshots: readonly string[];
  readonly parentTurnStarts: readonly unknown[];
}> {
  let activeBinding: ActiveThreadBinding | undefined;
  const parentThreadSnapshots: string[] = [];
  const parentTurnStarts: unknown[] = [];
  const result = await runLiveRunEngine({
    target: { filePath: input.fakeRun.fsmPath, repoRoot: input.fakeRun.repoRoot },
    verify: async () => ({ exitCode: 0 }),
    versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
    loadFsm: async () => loadedFsm(input.machine, input.fakeRun),
    authPrecheck: () => ({ ok: true }),
    resolveInput: () => ({ ok: true }),
    permissionMode: 'ask',
    ui: { serve: false },
    diagnostics: writableSink(),
    createReporter: () => reporter(),
    spawnAppServer: async () => fakeAppServer(),
    connectHeadlessWs: connectHeadlessWsWithSidecarScript({
      repoRoot: input.fakeRun.repoRoot,
      activeBinding: () => activeBinding,
      parentThreadSnapshots,
      parentTurnStarts,
      onSidecarTurnStarted: input.onSidecarTurnStarted,
    }),
    startUiServer: (() => {
      throw new Error('UI server should not start');
    }) as never,
    onActiveThreadBinding: (binding) => {
      activeBinding = binding;
      input.onActiveThreadBinding?.(binding);
    },
    ...(input.onUiEvent !== undefined ? { onUiEvent: input.onUiEvent } : {}),
    ...(input.onBrowserReplyController !== undefined
      ? { onBrowserReplyController: input.onBrowserReplyController }
      : {}),
    ...(input.readPendingOwnerInputRequestCount !== undefined
      ? { readPendingOwnerInputRequestCount: input.readPendingOwnerInputRequestCount }
      : {}),
    gitFactSyncExec: () => {
      throw new Error('temp repo has no git facts');
    },
  });
  expect(result.eventsPath).toBeDefined();
  const events = readJsonl(result.eventsPath!);
  expect(events.every((event) => event.schema === RUN_EVENT_SCHEMA)).toBe(true);
  return { result, events, parentThreadSnapshots, parentTurnStarts };
}

function emitSidecarCompleted(context: SidecarScriptContext): void {
  context.transport.onMessage?.({
    jsonrpc: '2.0',
    method: METHOD.agentMessageDelta,
    params: {
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: 'assistant',
      delta: 'done',
    },
  });
  context.transport.onMessage?.({
    jsonrpc: '2.0',
    method: METHOD.turnCompleted,
    params: { threadId: context.threadId, turn: { id: context.turnId } },
  });
}

function sidecarInputRequest(context: SidecarScriptContext): ToolRequestUserInputParams {
  return {
    threadId: context.threadId,
    turnId: context.turnId,
    itemId: 'sidecar-input',
    questions: [
      {
        id: 'direction',
        header: 'Direction',
        question: 'Which direction should the sidecar use?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'A', description: 'Use path A.' }],
      },
    ],
  };
}

function commandApprovalParams(
  context: SidecarScriptContext,
): CommandExecutionRequestApprovalParams {
  return {
    threadId: context.threadId,
    turnId: context.turnId,
    itemId: 'sidecar-command',
    approvalId: 'approval-sidecar-command',
    command: 'pnpm test',
    cwd: '/repo',
  };
}

function commandApprovalRequestId(event: ReplayableAppEvent): string | null {
  const body = event.event as { kind?: unknown; method?: unknown; requestId?: unknown };
  return body.kind === 'ServerRequest' &&
    body.method === METHOD.commandExecutionRequestApproval &&
    typeof body.requestId === 'string'
    ? body.requestId
    : null;
}

describe('sidecar live app-server integration', () => {
  it('runs a completed sidecar turn, closes it, records sidecar events, and leaves the parent binding unchanged', async () => {
    const fakeRun = tempRepo('aharness-sidecar-completed-');

    const run = await runWithFakeSidecarAppServer({
      fakeRun,
      machine: buildCompletedSidecarMachine(),
      onSidecarTurnStarted: emitSidecarCompleted,
    });

    expect(run.result.exitCode).toBe(0);
    expect(readFileSync(join(run.result.runDir!, 'artifacts', 'status.txt'), 'utf8')).toBe(
      'completed',
    );
    expect(run.parentTurnStarts).toEqual([]);
    expect(run.parentThreadSnapshots).toEqual(['parent-thread', 'parent-thread']);
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'sidecar.thread.started',
        'sidecar.turn.started',
        'sidecar.turn.completed',
        'sidecar.thread.closed',
        'run.completed',
      ]),
    );
  });

  it('returns needsInput, answers the sidecar request, and does not create parent owner-input reply state', async () => {
    const fakeRun = tempRepo('aharness-sidecar-input-');
    let pendingOwnerInputCount = -1;
    const uiEvents: ReplayableAppEvent[] = [];

    const run = await runWithFakeSidecarAppServer({
      fakeRun,
      machine: buildInputRequestSidecarMachine(),
      readPendingOwnerInputRequestCount: (read) => {
        pendingOwnerInputCount = read();
      },
      onUiEvent: (event) => {
        uiEvents.push(event);
      },
      onSidecarTurnStarted: (context) => {
        context.completeAfterServerResponse(901);
        context.transport.onMessage?.({
          jsonrpc: '2.0',
          id: 901,
          method: METHOD.toolRequestUserInput,
          params: sidecarInputRequest(context),
        });
      },
    });

    expect(run.result.exitCode).toBe(0);
    expect(readFileSync(join(run.result.runDir!, 'artifacts', 'status.txt'), 'utf8')).toBe(
      'completed',
    );
    expect(pendingOwnerInputCount).toBe(0);
    expect(run.parentTurnStarts).toEqual([]);
    expect(uiEvents.some((event) => event.event.kind === 'OwnerInputRequest')).toBe(false);
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'sidecar.input_request.created',
        'sidecar.input_request.resolved',
        'sidecar.turn.completed',
      ]),
    );
    expect(
      run.events.some(
        (event) =>
          event.type === 'request.created' &&
          event.data !== undefined &&
          event.data['kind'] === 'owner-input',
      ),
    ).toBe(false);
  });

  it('routes sidecar approvals through browser-visible pending cards without invoking parent permissionRequest hooks', async () => {
    const fakeRun = tempRepo('aharness-sidecar-approval-');
    const permissionHookCalls = { value: 0 };
    const approvalRequest = deferred<string>();
    let browserReplyController: BrowserReplyController | undefined;

    const resultPromise = runWithFakeSidecarAppServer({
      fakeRun,
      machine: buildApprovalSidecarMachine(permissionHookCalls),
      onBrowserReplyController: (controller) => {
        browserReplyController = controller;
      },
      onUiEvent: (event) => {
        const requestId = commandApprovalRequestId(event);
        if (requestId !== null) approvalRequest.resolve(requestId);
      },
      onSidecarTurnStarted: (context) => {
        context.completeAfterServerResponse(902);
        context.transport.onMessage?.({
          jsonrpc: '2.0',
          id: 902,
          method: METHOD.commandExecutionRequestApproval,
          params: commandApprovalParams(context),
        });
      },
    });

    const requestId = await approvalRequest.promise;
    expect(browserReplyController).toBeDefined();
    await expect(
      browserReplyController!.handleReply({
        kind: 'approval',
        requestId,
        decision: 'accept',
      }),
    ).resolves.toEqual({ status: 200, body: { ok: true } });

    const run = await resultPromise;

    expect(run.result.exitCode).toBe(0);
    expect(permissionHookCalls.value).toBe(0);
    expect(run.parentTurnStarts).toEqual([]);
    expect(readFileSync(join(run.result.runDir!, 'artifacts', 'status.txt'), 'utf8')).toBe(
      'completed',
    );
    const sidecarApproval = run.events.find(
      (event) => event.type === 'request.created' && event.requestId === requestId,
    );
    expect(sidecarApproval?.data).toMatchObject({
      sidecar: true,
      sidecarKey: 'helper',
      kind: 'command-approval',
    });
    expect(sidecarApproval?.data?.['pendingCard']).toMatchObject({
      kind: 'command-approval',
      requestId,
    });
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['request.created', 'request.resolved', 'sidecar.turn.completed']),
    );
  });
});
