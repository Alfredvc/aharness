import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONSchema7 } from 'json-schema';

import { aharness, createFsm, exit, skill, state, terminal } from '../src/index.js';
import type { AppServerHandle } from '../src/appServer/index.js';
import type {
  InstalledRuntimeSnapshot,
  InstallStorePaths,
  TrustedCommandIndexEntry,
  TrustedCommandsFile,
  TrustedInstallRecord,
  TrustedInstallsFile,
} from '../src/installStore/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import type { LoadInstalledFsmOptions } from '../src/loader/index.js';
import { METHOD } from '../src/protocol/methodNames.js';
import {
  startAharnessRunForTest,
  type StartAharnessRunTestHooks,
} from '../src/runtime/programmaticRun.js';
import type {
  LiveRunEngineOptions,
  LiveRunEngineResult,
  LiveRunLoadedFsm,
} from '../src/runtime/liveRunEngine.js';
import { RUN_EVENT_SCHEMA, type RunEventEnvelope } from '../src/runEvents/index.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';
import type { BrowserReplyController, BrowserReplyResult } from '../src/ui/reply.js';
import type { ArgFlagMeta } from '../src/loader/inputSchema.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface FakeRunPaths {
  readonly repoRoot: string;
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
}

interface CanonicalWriter {
  offset: number;
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

function captureStream(): { readonly stream: NodeJS.WritableStream; text(): string } {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

function fakeRunPaths(prefix: string, runId = 'run-programmatic'): FakeRunPaths {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(repoRoot);
  const runDir = join(repoRoot, '.aharness', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = join(runDir, 'events.jsonl');
  writeFileSync(eventsPath, '');
  return { repoRoot, runId, runDir, eventsPath };
}

function runEvent(runId: string, seq: number, type: string): RunEventEnvelope {
  return {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq,
    id: `${runId}:${seq}`,
    time: `2026-06-07T00:00:0${seq}.000Z`,
    type,
    data: { seq },
  };
}

function appendCanonical(
  options: LiveRunEngineOptions,
  paths: FakeRunPaths,
  writer: CanonicalWriter,
  envelope: RunEventEnvelope,
): void {
  const line = `${JSON.stringify(envelope)}\n`;
  const lineBytes = Buffer.byteLength(line);
  writeFileSync(paths.eventsPath, line, { flag: 'a' });
  options.onCanonicalAppend?.({
    event: envelope,
    offset: writer.offset,
    lineBytes,
  });
  writer.offset += lineBytes;
}

function readJsonl(eventsPath: string): RunEventEnvelope[] {
  return readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEventEnvelope);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function engineResult(paths: FakeRunPaths): LiveRunEngineResult {
  return {
    exitCode: 0,
    runId: paths.runId,
    runDir: paths.runDir,
    eventsPath: paths.eventsPath,
    terminalState: 'done',
    terminalOutcome: 'success',
  };
}

function loadedFsm(overrides: Partial<LiveRunLoadedFsm> = {}): LiveRunLoadedFsm {
  return {
    machine: {} as LiveRunLoadedFsm['machine'],
    sidecar: {},
    modulePath: '/tmp/stub.mjs',
    issues: [],
    cacheHit: false,
    hash: 'stub',
    skillOriginManifest: {
      rootSourceDir: '/tmp',
      sourceDirPrefixes: [],
      availableSkills: [],
    },
    ...overrides,
  };
}

function executableLoadedFsm(
  overrides: Partial<LiveRunLoadedFsm> = {},
  opts: { readonly requiredSkill?: string } = {},
): LiveRunLoadedFsm {
  const requiredSkills = opts.requiredSkill === undefined ? [] : [skill(opts.requiredSkill)];
  const machine = aharness.machine({
    id: 'programmatic-stub',
    initial: 'start',
    states: {
      start: state({
        entryPrompt: 'stub',
        ...(requiredSkills.length > 0 ? { skills: requiredSkills } : {}),
        exits: { finish: exit({ to: 'done' }) },
      }),
      done: terminal('success'),
    },
  });

  return loadedFsm({ machine, ...overrides });
}

function makeProgrammaticAppServer(
  close: () => Promise<void> = async () => undefined,
): AppServerHandle {
  return {
    wsUrl: 'ws+unix:///tmp/aharness-programmatic.sock',
    port: null,
    sockPath: '/tmp/aharness-programmatic.sock',
    close,
  } as AppServerHandle;
}

function installedRuntimeSnapshot(record: TrustedInstallRecord): InstalledRuntimeSnapshot {
  const commands: Record<string, TrustedCommandIndexEntry> = {};
  for (const command of Object.values(record.commands)) {
    commands[`${record.packageName}/${command.commandName}`] = {
      packageName: record.packageName,
      commandName: command.commandName,
      entry: command.entry,
      packageRoot: record.packageRoot,
      ...(record.packageVersion !== undefined ? { packageVersion: record.packageVersion } : {}),
      lockFingerprint: record.lockFingerprint,
      ...(command.description !== undefined ? { description: command.description } : {}),
    };
  }

  return {
    paths: installStorePaths(),
    installs: trustedInstallsFile({ [record.packageName]: record }),
    commands: trustedCommandsFile(commands),
  };
}

function installStorePaths(): InstallStorePaths {
  return {
    storeRoot: '/store',
    managedProjectRoot: '/store/packages',
    installsPath: '/store/installs.json',
    commandsPath: '/store/commands.json',
  };
}

function trustedInstallsFile(installs: Record<string, TrustedInstallRecord>): TrustedInstallsFile {
  return {
    schemaVersion: 1,
    generation: 'gen-1',
    installs,
  };
}

function trustedCommandsFile(
  commands: Record<string, TrustedCommandIndexEntry>,
): TrustedCommandsFile {
  return {
    schemaVersion: 1,
    generation: 'gen-1',
    commands,
  };
}

function trustedInstallRecord(packageName = '@scope/tools'): TrustedInstallRecord {
  return {
    packageName,
    dependencyKey: packageName,
    requestedSpec: `${packageName}@latest`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    sourceIntentKey: `registry:${packageName}`,
    lockFingerprint: 'trusted-lock',
    commands: {
      build: {
        commandName: 'build',
        entry: 'fsms/build.fsm.ts',
      },
    },
  };
}

function connectHeadlessWsForStartupFailure(opts: {
  readonly repoRoot: string;
  readonly failAt: 'ws-connect' | 'skill-preflight' | 'thread-start';
  readonly onClose?: () => Promise<void>;
}): StartAharnessRunTestHooks['connectHeadlessWsImpl'] {
  return vi.fn(async (connectOptions: ConnectHeadlessWsOptions) => {
    if (opts.failAt === 'ws-connect') {
      connectOptions.diagnostics?.('programmatic test ws diagnostic');
      throw new Error('programmatic ws unavailable');
    }

    const transport: Transport = {
      send(message: unknown): void {
        const envelope = message as { id?: number; method?: string; params?: unknown };
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
          queueMicrotask(() =>
            transport.onMessage?.({
              jsonrpc: '2.0',
              id: envelope.id,
              error: { code: -32000, message: 'programmatic thread rejected' },
            }),
          );
        }
      },
      async close() {
        await opts.onClose?.();
      },
    };
    const client = new JsonRpcClient(transport);
    connectOptions.registerHandlers?.(client);
    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  });
}

describe('startAharnessRun', () => {
  it('resolves installed command targets through trust checks and the package-aware loader', async () => {
    const paths = fakeRunPaths('aharness-programmatic-installed-');
    const record = trustedInstallRecord();
    const snapshot = installedRuntimeSnapshot(record);
    const readSnapshotImpl = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const checkLockFingerprintImpl = vi.fn(async () => ({
      ok: true as const,
      value: 'trusted-lock',
    }));
    const loadInstalledFsmImpl = vi.fn(async (_opts: LoadInstalledFsmOptions) => loadedFsm());
    let engineOptions: LiveRunEngineOptions | undefined;
    let verifyResult: { readonly exitCode: number } | undefined;

    const run = await startAharnessRunForTest(
      { target: '@scope/tools/build', cwd: paths.repoRoot },
      {
        diagnostics: captureStream().stream,
        resolveTargetOptions: {
          readSnapshotImpl,
          checkLockFingerprintImpl,
        },
        loadInstalledFsmImpl,
        runLiveRunEngineImpl: async (options) => {
          engineOptions = options;
          verifyResult = await options.verify({
            fsmPath: options.target.filePath,
            repoRoot: options.target.repoRoot,
          });
          await options.loadFsm({
            filePath: options.target.filePath,
            repoRoot: options.target.repoRoot,
          });
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          return engineResult(paths);
        },
      },
    );

    await expect(run.result()).resolves.toMatchObject({ status: 'completed' });
    expect(engineOptions?.target).toEqual({
      filePath: '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts',
      repoRoot: paths.repoRoot,
    });
    expect(verifyResult).toEqual({ exitCode: 0 });
    expect(readSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(checkLockFingerprintImpl).toHaveBeenCalledExactlyOnceWith(record, snapshot.paths);
    expect(loadInstalledFsmImpl).toHaveBeenCalledExactlyOnceWith({
      entryFile: '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts',
      packageName: '@scope/tools',
      commandName: 'build',
      packageRoot: '/store/packages/node_modules/@scope/tools',
      managedProjectRoot: '/store/packages',
      storeRoot: '/store',
      lockFingerprint: 'trusted-lock',
    });
  });

  it('rejects package-only installed targets before starting the live engine', async () => {
    const record = trustedInstallRecord();
    const snapshot = installedRuntimeSnapshot(record);
    const readSnapshotImpl = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const checkLockFingerprintImpl = vi.fn(async () => ({
      ok: true as const,
      value: 'trusted-lock',
    }));
    const runLiveRunEngineImpl: StartAharnessRunTestHooks['runLiveRunEngineImpl'] = vi.fn();

    await expect(
      startAharnessRunForTest(
        { target: '@scope/tools', cwd: process.cwd() },
        {
          resolveTargetOptions: {
            readSnapshotImpl,
            checkLockFingerprintImpl,
          },
          runLiveRunEngineImpl,
          diagnostics: captureStream().stream,
        },
      ),
    ).rejects.toThrow("'@scope/tools' identifies a package, not a command");
    expect(readSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
    expect(runLiveRunEngineImpl).not.toHaveBeenCalled();
  });

  it('rejects verify failures before Codex startup', async () => {
    const paths = fakeRunPaths('aharness-programmatic-verify-failure-');
    const spawnAppServer = vi.fn(async () => makeProgrammaticAppServer());
    const loadFsmImpl = vi.fn(async () => executableLoadedFsm());

    await expect(
      startAharnessRunForTest(
        { target: './workflow.fsm.ts', cwd: paths.repoRoot },
        {
          diagnostics: captureStream().stream,
          verify: async () => ({ exitCode: 7 }),
          versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
          authJsonExists: () => true,
          loadFsmImpl,
          spawnAppServer,
        },
      ),
    ).rejects.toThrow('aharness run failed before handle was ready (exit code 7)');
    expect(loadFsmImpl).not.toHaveBeenCalled();
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'invalid non-object input',
      input: ['not-object'] as unknown as Record<string, unknown>,
      loaded: executableLoadedFsm(),
      expected: 'input must be an object; got array',
    },
    {
      label: 'missing required input',
      input: {},
      loaded: executableLoadedFsm({
        inputSchema: {
          type: 'object',
          properties: { project: { type: 'string' } },
          required: ['project'],
          additionalProperties: false,
        },
        inputFlags: { project: {} },
      }),
      expected: '--project: required input is missing',
    },
    {
      label: 'non-empty input for an FSM without declared input',
      input: { project: 'demo' },
      loaded: executableLoadedFsm(),
      expected: 'FSM declares no input fields; unexpected input fields: --project',
    },
  ])('rejects $label before Codex startup', async ({ input, loaded, expected }) => {
    const paths = fakeRunPaths('aharness-programmatic-input-failure-');
    const spawnAppServer = vi.fn(async () => makeProgrammaticAppServer());
    const loadFsmImpl = vi.fn(async () => loaded);

    await expect(
      startAharnessRunForTest(
        { target: './workflow.fsm.ts', cwd: paths.repoRoot, input },
        {
          diagnostics: captureStream().stream,
          verify: async () => ({ exitCode: 0 }),
          versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
          authJsonExists: () => true,
          loadFsmImpl,
          spawnAppServer,
        },
      ),
    ).rejects.toThrow(expected);
    expect(loadFsmImpl).toHaveBeenCalledTimes(1);
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'app-server',
      expected: 'app-server failed: programmatic app-server unavailable',
    },
    {
      label: 'WS',
      failAt: 'ws-connect' as const,
      expected: 'WS connect failed: programmatic ws unavailable',
    },
    {
      label: 'skill preflight',
      failAt: 'skill-preflight' as const,
      requiredSkill: 'missing-skill',
      expected: 'skill preflight failed:',
    },
    {
      label: 'thread/start',
      failAt: 'thread-start' as const,
      expected: 'thread/start failed: jsonrpc error -32000: programmatic thread rejected',
    },
  ])('resolves post-handle $label startup failure as a failed result', async (testCase) => {
    const paths = fakeRunPaths('aharness-programmatic-startup-failure-');
    const appServerClose = vi.fn(async () => undefined);
    const wsClose = vi.fn(async () => undefined);
    const spawnAppServer =
      testCase.label === 'app-server'
        ? vi.fn(async () => {
            throw new Error('programmatic app-server unavailable');
          })
        : vi.fn(async () => makeProgrammaticAppServer(appServerClose));
    const connectHeadlessWsImpl =
      testCase.label === 'app-server'
        ? undefined
        : connectHeadlessWsForStartupFailure({
            repoRoot: paths.repoRoot,
            failAt: testCase.failAt,
            onClose: wsClose,
          });

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: paths.repoRoot },
      {
        diagnostics: captureStream().stream,
        verify: async () => ({ exitCode: 0 }),
        versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
        authJsonExists: () => true,
        loadFsmImpl: async () => executableLoadedFsm({}, { requiredSkill: testCase.requiredSkill }),
        spawnAppServer,
        ...(connectHeadlessWsImpl !== undefined ? { connectHeadlessWsImpl } : {}),
      },
    );

    await expect(run.result()).resolves.toMatchObject({
      status: 'failed',
      exitCode: 1,
      runId: run.runId,
      runDir: run.runDir,
      eventsPath: run.eventsPath,
    });
    const events = readJsonl(run.eventsPath);
    expect(events.map((event) => event.type)).toContain('run.started');
    expect(events.find((event) => event.type === 'run.failed')?.data).toMatchObject({
      status: 'failed',
      message: expect.stringContaining(testCase.expected),
    });
    if (testCase.label !== 'app-server') {
      expect(appServerClose).toHaveBeenCalledTimes(1);
    }
    if (testCase.label === 'skill preflight' || testCase.label === 'thread/start') {
      expect(wsClose).toHaveBeenCalledTimes(1);
    }
  });

  it('maps post-ready engine exceptions to failed result metadata and diagnostics', async () => {
    const paths = fakeRunPaths('aharness-programmatic-engine-error-');
    const diagnostics = captureStream();

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: paths.repoRoot },
      {
        diagnostics: diagnostics.stream,
        runLiveRunEngineImpl: async (options) => {
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          throw new Error('engine exploded');
        },
      },
    );

    await expect(run.result()).resolves.toEqual({
      status: 'failed',
      exitCode: 1,
      runId: paths.runId,
      runDir: paths.runDir,
      eventsPath: paths.eventsPath,
      reason: 'engine exploded',
    });
    expect(diagnostics.text()).toContain(
      'aharness: programmatic run engine failed: engine exploded',
    );
  });

  it('runs sidecar author code through startAharnessRun using the shared live engine', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aharness-programmatic-sidecar-'));
    tempRoots.push(repoRoot);
    const fsmPath = join(repoRoot, 'workflow.fsm.ts');
    writeFileSync(fsmPath, '// programmatic sidecar fixture\n');
    const base = createFsm<{ status: string }>();
    const fsm = base.withEvents({
      sidecarDone: base.event<{ status: string }>(),
    });
    const machine = fsm.machine({
      id: 'programmatic-sidecar-live-engine',
      data: () => ({ status: 'pending' }),
      initial: 'work',
      states: {
        work: fsm.state({
          prompt: 'work',
          entry: async (_data, ops) => {
            const thread = await ops.codex.createThread('helper');
            const result = await thread.send('complete sidecar work');
            await thread.close();
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
        done: fsm.final({
          outcome: 'success',
          artifacts: {
            'status.txt': (data) => data.status,
          },
        }),
      },
    });
    const parentTurnStarts: unknown[] = [];
    const outboundMethods: string[] = [];
    let threadStartCount = 0;
    let sidecarTurnCount = 0;
    const connectHeadlessWsImpl: StartAharnessRunTestHooks['connectHeadlessWsImpl'] = async (
      opts: ConnectHeadlessWsOptions,
    ) => {
      const transport: Transport = {
        send(message: unknown): void {
          const envelope = message as {
            readonly id?: number;
            readonly method?: string;
            readonly params?: unknown;
          };
          if (envelope.method !== undefined) outboundMethods.push(envelope.method);
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
                result: { data: [{ cwd: repoRoot, skills: [], errors: [] }] },
              }),
            );
            return;
          }
          if (envelope.method === METHOD.threadStart) {
            threadStartCount += 1;
            const threadId =
              threadStartCount === 1 ? 'parent-thread' : `sidecar-thread-${threadStartCount - 1}`;
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
            if (
              typeof params.threadId === 'string' &&
              params.threadId.startsWith('sidecar-thread-')
            ) {
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
                transport.onMessage?.({
                  jsonrpc: '2.0',
                  method: METHOD.turnCompleted,
                  params: { threadId: params.threadId, turn: { id: turnId } },
                });
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
    };

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: repoRoot, ui: false },
      {
        diagnostics: captureStream().stream,
        verify: async () => ({ exitCode: 0 }),
        versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
        authJsonExists: () => true,
        loadFsmImpl: async () =>
          loadedFsm({
            machine,
            modulePath: join(repoRoot, 'workflow.mjs'),
            sourceLocations: {
              states: { work: { sourceFile: fsmPath, line: 1 } },
              exits: {},
              whenBranches: {},
              stateSkills: {},
              availableSkills: [],
            },
          }),
        spawnAppServer: async () => makeProgrammaticAppServer(),
        connectHeadlessWsImpl,
      },
    );

    await expect(run.result()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    expect(parentTurnStarts).toEqual([]);
    expect(outboundMethods).toEqual(
      expect.arrayContaining([METHOD.threadStart, METHOD.turnStart, METHOD.threadUnsubscribe]),
    );
    expect(readFileSync(join(run.runDir, 'artifacts', 'status.txt'), 'utf8')).toBe('completed');
    expect(readJsonl(run.eventsPath).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'sidecar.thread.started',
        'sidecar.turn.completed',
        'sidecar.thread.closed',
        'run.completed',
      ]),
    );
  });

  it('delivers canonical events to onEvent and future-only subscribers', async () => {
    const paths = fakeRunPaths('aharness-programmatic-events-');
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const writer: CanonicalWriter = { offset: 0 };
    const onEventEvents: RunEventEnvelope[] = [];
    let eventHandleRunId: string | undefined;

    const runLiveRunEngineImpl = vi.fn(async (options: LiveRunEngineOptions) => {
      options.onRunReady?.({
        runId: paths.runId,
        runDir: paths.runDir,
        eventsPath: paths.eventsPath,
      });
      await releaseFirst.promise;
      appendCanonical(options, paths, writer, runEvent(paths.runId, 1, 'run.started'));
      await releaseSecond.promise;
      appendCanonical(options, paths, writer, runEvent(paths.runId, 2, 'state.changed'));
      return engineResult(paths);
    });

    const run = await startAharnessRunForTest(
      {
        target: './demo.fsm.ts',
        cwd: paths.repoRoot,
        onEvent: (event, handle) => {
          onEventEvents.push(event);
          eventHandleRunId = handle.runId;
        },
      },
      { runLiveRunEngineImpl, diagnostics: captureStream().stream },
    );

    expect(run.runId).toBe(paths.runId);
    expect(run.runDir).toBe(paths.runDir);
    expect(run.eventsPath).toBe(paths.eventsPath);

    releaseFirst.resolve(undefined);
    await waitFor(() => onEventEvents.length === 1, 'first programmatic event');

    const subscribedEvents: RunEventEnvelope[] = [];
    const unsubscribe = run.subscribe((event) => {
      subscribedEvents.push(event);
    });

    releaseSecond.resolve(undefined);
    await waitFor(
      () => onEventEvents.length === 2 && subscribedEvents.length === 1,
      'second programmatic event',
    );
    await run.result();
    unsubscribe();

    const jsonl = readJsonl(paths.eventsPath);
    expect(onEventEvents).toEqual(jsonl);
    expect(subscribedEvents).toEqual([jsonl[1]]);
    expect(eventHandleRunId).toBe(paths.runId);
    expect(jsonl[0]).not.toHaveProperty('offset');
    expect(jsonl[0]).not.toHaveProperty('lineBytes');
  });

  it('runs each listener through a serial append-ordered queue and logs listener failures', async () => {
    const paths = fakeRunPaths('aharness-programmatic-listener-');
    const releaseEvents = deferred();
    const firstStarted = deferred();
    const releaseFirstListener = deferred();
    const secondStarted = deferred();
    const diagnostics = captureStream();
    const calls: string[] = [];
    const writer: CanonicalWriter = { offset: 0 };

    const run = await startAharnessRunForTest(
      { target: './demo.fsm.ts', cwd: paths.repoRoot },
      {
        diagnostics: diagnostics.stream,
        runLiveRunEngineImpl: async (options) => {
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          await releaseEvents.promise;
          appendCanonical(options, paths, writer, runEvent(paths.runId, 1, 'run.started'));
          appendCanonical(options, paths, writer, runEvent(paths.runId, 2, 'state.changed'));
          return engineResult(paths);
        },
      },
    );

    run.subscribe(async (event) => {
      calls.push(`start-${event.seq}`);
      if (event.seq === 1) {
        firstStarted.resolve(undefined);
        await releaseFirstListener.promise;
        calls.push('end-1');
        throw new Error('listener boom');
      }
      calls.push(`end-${event.seq}`);
      secondStarted.resolve(undefined);
    });

    releaseEvents.resolve(undefined);
    await firstStarted.promise;
    expect(calls).toEqual(['start-1']);

    releaseFirstListener.resolve(undefined);
    await secondStarted.promise;
    expect(calls).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(diagnostics.text()).toContain(
      'aharness: programmatic event listener failed for run.started: listener boom',
    );

    await expect(run.result()).resolves.toMatchObject({ status: 'completed' });
  });

  it('constructs browser reply payloads internally and mirrors controller status/body', async () => {
    const paths = fakeRunPaths('aharness-programmatic-replies-');
    const releaseController = deferred();
    const controllerReady = deferred();
    const releaseResult = deferred();
    const payloads: unknown[] = [];
    const controller: BrowserReplyController = {
      parkOwnerInput: vi.fn(async () => ({ answers: {} })),
      abandonInactiveOwnerInput: vi.fn(),
      close: vi.fn(),
      handleReply: vi.fn(async (payload: unknown): Promise<BrowserReplyResult> => {
        payloads.push(payload);
        const kind =
          typeof payload === 'object' && payload !== null && 'kind' in payload
            ? (payload as { kind?: unknown }).kind
            : undefined;
        if (kind === 'permission') {
          return { status: 409, body: { error: 'no-pending-permission' } };
        }
        return { status: 200, body: { ok: true, kind } };
      }),
    };

    const run = await startAharnessRunForTest(
      { target: './demo.fsm.ts', cwd: paths.repoRoot },
      {
        diagnostics: captureStream().stream,
        runLiveRunEngineImpl: async (options) => {
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          await releaseController.promise;
          options.onBrowserReplyController?.(controller);
          controllerReady.resolve(undefined);
          await releaseResult.promise;
          return engineResult(paths);
        },
      },
    );

    await expect(run.sendText('too early')).resolves.toEqual({
      ok: false,
      status: 503,
      body: { error: 'reply-handler-unavailable' },
    });

    releaseController.resolve(undefined);
    await controllerReady.promise;

    await expect(run.sendText('hello')).resolves.toEqual({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'user-prompt' },
    });
    await expect(
      run.chooseOwnerOption({ state: 'review', visitCount: 2, label: 'Approve' }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(
      run.answerOwnerInput({ requestId: 'owner-1', answers: { scope: 'phase 1' } }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(
      run.resolveApproval({ requestId: 'approval-1', decision: 'acceptForSession' }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(
      run.resolvePermission({ requestId: 'permission-1', decision: 'decline' }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      body: { error: 'no-pending-permission' },
    });
    await expect(
      run.resolveElicitation({
        requestId: 'elicitation-1',
        action: 'accept',
        values: { project: 'demo' },
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 });

    expect(payloads).toEqual([
      { kind: 'user-prompt', text: 'hello' },
      { kind: 'owner-choice', state: 'review', visitCount: 2, label: 'Approve' },
      { kind: 'owner-input', requestId: 'owner-1', answers: { scope: 'phase 1' } },
      { kind: 'approval', requestId: 'approval-1', decision: 'acceptForSession' },
      { kind: 'permission', requestId: 'permission-1', decision: 'decline' },
      {
        kind: 'elicitation',
        requestId: 'elicitation-1',
        action: 'accept',
        values: { project: 'demo' },
      },
    ]);

    releaseResult.resolve(undefined);
    await expect(run.result()).resolves.toMatchObject({ status: 'completed' });
  });

  it('cancels once, closes replies immediately, and resolves a cancelled result', async () => {
    const paths = fakeRunPaths('aharness-programmatic-cancel-');
    const writer: CanonicalWriter = { offset: 0 };
    const events: RunEventEnvelope[] = [];
    const controller: BrowserReplyController = {
      parkOwnerInput: vi.fn(async () => ({ answers: {} })),
      abandonInactiveOwnerInput: vi.fn(),
      close: vi.fn(),
      handleReply: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    };

    const run = await startAharnessRunForTest(
      {
        target: './demo.fsm.ts',
        cwd: paths.repoRoot,
        onEvent: (event) => {
          events.push(event);
        },
      },
      {
        diagnostics: captureStream().stream,
        runLiveRunEngineImpl: async (options) => {
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          options.onBrowserReplyController?.(controller);
          const cancellation = await new Promise<{ readonly reason?: string }>((resolveCancel) => {
            const current = options.cancellation?.current();
            if (current !== null && current !== undefined) {
              resolveCancel(current);
              return;
            }
            let unsubscribe = (): void => undefined;
            unsubscribe =
              options.cancellation?.subscribe((request) => {
                unsubscribe();
                resolveCancel(request);
              }) ?? (() => undefined);
          });
          appendCanonical(options, paths, writer, {
            ...runEvent(paths.runId, 1, 'run.cancelled'),
            data: {
              status: 'cancelled',
              ...(cancellation.reason !== undefined ? { reason: cancellation.reason } : {}),
            },
          });
          return {
            ...engineResult(paths),
            exitCode: 130,
            status: 'cancelled',
            terminalOutcome: 'cancelled',
            ...(cancellation.reason !== undefined ? { reason: cancellation.reason } : {}),
          };
        },
      },
    );

    await run.cancel('owner stopped');
    await run.cancel('ignored');

    const closedReply = {
      ok: false,
      status: 409,
      body: { error: 'run-closed', status: 'cancelled', reason: 'owner stopped' },
    };
    await expect(run.sendText('too late')).resolves.toEqual(closedReply);
    await expect(
      run.chooseOwnerOption({ state: 'review', visitCount: 1, label: 'Done' }),
    ).resolves.toEqual(closedReply);
    await expect(
      run.answerOwnerInput({ requestId: 'owner-1', answers: { topic: 'demo' } }),
    ).resolves.toEqual(closedReply);
    await expect(
      run.resolveApproval({ requestId: 'approval-1', decision: 'accept' }),
    ).resolves.toEqual(closedReply);
    await expect(
      run.resolvePermission({ requestId: 'permission-1', decision: 'decline' }),
    ).resolves.toEqual(closedReply);
    await expect(
      run.resolveElicitation({ requestId: 'elicitation-1', action: 'cancel' }),
    ).resolves.toEqual(closedReply);
    await expect(run.result()).resolves.toEqual({
      status: 'cancelled',
      exitCode: 130,
      runId: paths.runId,
      runDir: paths.runDir,
      eventsPath: paths.eventsPath,
      terminalState: 'done',
      terminalOutcome: 'cancelled',
      reason: 'owner stopped',
    });
    expect(controller.close).toHaveBeenCalledOnce();
    expect(controller.handleReply).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'run.cancelled',
      data: { status: 'cancelled', reason: 'owner stopped' },
    });
    expect(
      readJsonl(paths.eventsPath).filter((event) => event.type === 'run.cancelled'),
    ).toHaveLength(1);
  });

  it('honors immediate cancellation before opening the app-server', async () => {
    const paths = fakeRunPaths('aharness-programmatic-immediate-cancel-');
    const spawnAppServer = vi.fn(async () => {
      throw new Error('app-server should not start after cancellation');
    });

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: paths.repoRoot },
      {
        diagnostics: captureStream().stream,
        verify: async () => ({ exitCode: 0 }),
        versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
        authJsonExists: () => true,
        loadFsmImpl: async () => executableLoadedFsm(),
        spawnAppServer,
      },
    );

    await run.cancel('immediate owner stop');

    await expect(run.result()).resolves.toMatchObject({
      status: 'cancelled',
      exitCode: 130,
      reason: 'immediate owner stop',
    });
    expect(spawnAppServer).not.toHaveBeenCalled();
    expect(
      readJsonl(run.eventsPath).filter((event) => event.type === 'run.cancelled'),
    ).toHaveLength(1);
  });

  it('defaults cwd/input/ui/permission mode before handing options to the engine', async () => {
    const paths = fakeRunPaths('aharness-programmatic-defaults-');
    let engineOptions: LiveRunEngineOptions | undefined;
    let inputResult: unknown;

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts' },
      {
        diagnostics: captureStream().stream,
        runLiveRunEngineImpl: async (options) => {
          engineOptions = options;
          inputResult = await options.resolveInput(loadedFsm());
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          return engineResult(paths);
        },
      },
    );

    await run.result();

    expect(engineOptions?.target).toEqual({
      filePath: resolve(process.cwd(), './workflow.fsm.ts'),
      repoRoot: process.cwd(),
    });
    expect(engineOptions).not.toHaveProperty('permissionMode');
    expect(engineOptions?.ui).toEqual({ serve: false, openBrowser: false });
    expect(inputResult).toEqual({ ok: true, input: {} });
  });

  it.each([
    { label: 'ui true', ui: true, shouldLaunch: false },
    { label: 'ui open true', ui: { open: true }, shouldLaunch: true },
  ])('starts optional UI for $label with the expected browser launch policy', async (testCase) => {
    const paths = fakeRunPaths('aharness-programmatic-ui-live-');
    const closeUiServer = vi.fn(async () => undefined);
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:45678',
      close: closeUiServer,
    }));
    const launchBrowserImpl = vi.fn(() => ({ ok: true as const }));
    const spawnAppServer = vi.fn(async () => {
      throw new Error('stop after UI readiness');
    });

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: paths.repoRoot, ui: testCase.ui },
      {
        diagnostics: captureStream().stream,
        verify: async () => ({ exitCode: 0 }),
        versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
        authJsonExists: () => true,
        loadFsmImpl: async () => executableLoadedFsm(),
        startUiServerImpl,
        launchBrowserImpl,
        spawnAppServer,
      },
    );

    expect(run.uiUrl).toMatch(/^http:\/\/127\.0\.0\.1:45678\/\?token=[^&]+&runId=[^&]+$/);
    expect(startUiServerImpl).toHaveBeenCalledTimes(1);
    if (testCase.shouldLaunch) {
      expect(launchBrowserImpl).toHaveBeenCalledExactlyOnceWith(run.uiUrl);
    } else {
      expect(launchBrowserImpl).not.toHaveBeenCalled();
    }
    await expect(run.result()).resolves.toMatchObject({ status: 'failed', exitCode: 1 });
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(closeUiServer).toHaveBeenCalledTimes(1);
  });

  it('rejects UI startup failure before Codex startup', async () => {
    const paths = fakeRunPaths('aharness-programmatic-ui-failure-');
    const startUiServerImpl = vi.fn(async () => {
      throw new Error('port unavailable');
    });
    const launchBrowserImpl = vi.fn(() => ({ ok: true as const }));
    const spawnAppServer = vi.fn(async () => makeProgrammaticAppServer());

    await expect(
      startAharnessRunForTest(
        { target: './workflow.fsm.ts', cwd: paths.repoRoot, ui: true },
        {
          diagnostics: captureStream().stream,
          verify: async () => ({ exitCode: 0 }),
          versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
          authJsonExists: () => true,
          loadFsmImpl: async () => executableLoadedFsm(),
          startUiServerImpl,
          launchBrowserImpl,
          spawnAppServer,
        },
      ),
    ).rejects.toThrow('aharness: UI server failed: port unavailable');
    expect(startUiServerImpl).toHaveBeenCalledTimes(1);
    expect(launchBrowserImpl).not.toHaveBeenCalled();
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('applies programmatic input defaults and waits for requested UI readiness', async () => {
    const paths = fakeRunPaths('aharness-programmatic-ui-');
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        project: { type: 'string' },
        retries: { type: 'number' },
      },
      required: ['project'],
      additionalProperties: false,
    };
    const inputFlags: Record<string, ArgFlagMeta> = {
      project: {},
      retries: { default: 2 },
    };
    let engineOptions: LiveRunEngineOptions | undefined;
    let inputResult: unknown;

    const run = await startAharnessRunForTest(
      {
        target: './workflow.fsm.ts',
        cwd: paths.repoRoot,
        input: { project: 'demo' },
        permissionMode: 'ask',
        ui: { open: true },
      },
      {
        diagnostics: captureStream().stream,
        runLiveRunEngineImpl: async (options) => {
          engineOptions = options;
          inputResult = await options.resolveInput(loadedFsm({ inputSchema: schema, inputFlags }));
          options.onRunReady?.({
            runId: paths.runId,
            runDir: paths.runDir,
            eventsPath: paths.eventsPath,
          });
          options.onUiReady?.({ url: 'http://127.0.0.1:1234/?token=test&runId=run' });
          return { ...engineResult(paths), uiUrl: 'http://127.0.0.1:1234/?token=test&runId=run' };
        },
      },
    );

    await run.result();

    expect(engineOptions?.target).toEqual({
      filePath: join(paths.repoRoot, 'workflow.fsm.ts'),
      repoRoot: paths.repoRoot,
    });
    expect(engineOptions?.permissionMode).toBe('ask');
    expect(engineOptions?.ui).toEqual({ serve: true, openBrowser: true });
    expect(inputResult).toEqual({ ok: true, input: { project: 'demo', retries: 2 } });
    expect(run.uiUrl).toBe('http://127.0.0.1:1234/?token=test&runId=run');
  });

  it('rejects invalid targets before starting the live engine', async () => {
    const runLiveRunEngineImpl: StartAharnessRunTestHooks['runLiveRunEngineImpl'] = vi.fn();

    await expect(
      startAharnessRunForTest({ target: './workflow' }, { runLiveRunEngineImpl }),
    ).rejects.toThrow("local FSM target './workflow' must end in .fsm.ts");
    expect(runLiveRunEngineImpl).not.toHaveBeenCalled();
  });
});
