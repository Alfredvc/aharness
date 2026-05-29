/**
 * Phase 1 `runCliForTest` unit tests.
 *
 * Exercises the boot sequence's pre-spawn gates (verify, version gate,
 * runDir derivation, auth precheck, input-flag parsing, hook override wiring)
 * via dependency-injected hooks. No real `node:child_process` spawn, no
 * real `codex` binary — those paths land in `cli.runCli.phase1.test.ts`.
 *
 * Cases:
 *   1. Verify failure — early bail, no app-server spawn.
 *   2. Version-gate failure — bail with exit 2, stderr message.
 *   3. Fresh boot — even a legacy resume option mints a new run dir when
 *      a prior one exists.
 *   4. Bare `aharness <file>` mints a new run dir even when a prior one exists.
 *   5. Legacy resume with no prior is ignored and emits no resume notice.
 *   6. Auth precheck miss — exit 1 + stderr message, no spawn.
 *   7. Declared hook kinds materialize wrappers and pass hook overrides.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, createActor } from 'xstate';

import { aharness, state, exit, terminal } from '../src/index.js';
import { runCliForTest, type RunCliForTestOpts, type RunCliTestHooks } from '../src/cli/runCli.js';
import type { AppServerHandle, SpawnAppServerOptions } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import { METHOD } from '../src/protocol/methodNames.js';
import {
  flushHeadlessSnapshotEnvelope,
  loadHeadlessSnapshotEnvelope,
} from '../src/runtime/snapshotEnvelope.js';
import {
  RUN_EVENT_SCHEMA,
  type RunEventAppendInput,
  type RunEventEnvelope,
  type RunEventRecorder,
} from '../src/runEvents/index.js';
import type { ActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import type { ReplayableAppEvent, UiSnapshot } from '../src/ui/events.js';
import type { StartUiServerOptions } from '../src/ui/server.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';

const APPROVAL_POLICY_OVERRIDE = ['approval_policy', '"on-request"'] as const;
const YOLO_OVERRIDES = [
  ['approval_policy', '"never"'],
  ['sandbox_mode', '"danger-full-access"'],
] as const;

// ---------------------------------------------------------------------------
// Stubs.
// ---------------------------------------------------------------------------

function makeStubAppServer(wsUrl = 'ws+unix:///nonexistent.sock'): AppServerHandle {
  const closed = { value: false };
  return {
    wsUrl,
    port: null,
    sockPath: '/nonexistent.sock',
    async close(): Promise<void> {
      closed.value = true;
    },
  } as unknown as AppServerHandle;
}

function makeFsmFile(repoRoot: string, name = 'demo.fsm.ts'): string {
  // The verify hook is stubbed in every test; the file only needs to
  // exist as a path the boot sequence can resolve. Contents are never
  // compiled because the `loadFsmImpl` hook returns a stub machine.
  const path = join(repoRoot, name);
  writeFileSync(path, '// stub fsm\n');
  return path;
}

function makeWritableBuffer(): {
  readonly chunks: string[];
  readonly sink: NodeJS.WritableStream;
  text(): string;
} {
  const chunks: string[] = [];
  return {
    chunks,
    sink: {
      write(chunk: string | Uint8Array): boolean {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

function readRunEventEnvelopes(repoRoot: string): RunEventEnvelope[] {
  const runId = readdirSync(join(repoRoot, '.aharness', 'runs'))[0];
  if (!runId) throw new Error('missing run dir');
  return readFileSync(join(repoRoot, '.aharness', 'runs', runId, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEventEnvelope);
}

function expectCanonicalRunEventStream(repoRoot: string): RunEventEnvelope[] {
  const entries = readRunEventEnvelopes(repoRoot);
  expect(entries.every((entry) => entry.schema === RUN_EVENT_SCHEMA)).toBe(true);
  expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_entry, index) => index + 1));
  expect(entries.map((entry) => entry.id)).toEqual(
    entries.map((entry, index) => `${entry.runId}:${index + 1}`),
  );
  expect(entries.every((entry) => !('kind' in entry) && !('ts' in entry))).toBe(true);
  return entries;
}

function failingRunEventRecorder(): RunEventRecorder {
  return {
    append(input: RunEventAppendInput) {
      const envelope: RunEventEnvelope = {
        schema: RUN_EVENT_SCHEMA,
        runId: 'run-warning',
        seq: 1,
        id: 'run-warning:1',
        time: '2026-05-29T00:00:00.000Z',
        type: input.type,
      };
      return {
        ok: false,
        warning: {
          code: 'append-failed',
          message: 'disk full',
          eventsPath: '/tmp/events.jsonl',
          offset: 0,
          envelope,
        },
      };
    },
    nextSeq: () => 1,
    offset: () => 0,
  };
}

/**
 * Build a minimal stub `LoadFsmResult`. The runCli body only reads
 * `.machine`, `.sidecar`, `.inputSchema?`, `.inputFlags?` — the rest of
 * the loader's surface is irrelevant to these pre-spawn cases.
 */
function makeStubLoadFsmResult() {
  const m = aharness.machine({
    id: 'stub',
    initial: 'greet',
    states: {
      greet: state({
        entryPrompt: 'stub',
        exits: { finish: exit({ to: 'done' }) },
      }),
      done: terminal('success'),
    },
  });
  return {
    machine: m,
    sidecar: {},
    modulePath: '/tmp/stub.mjs',
    issues: [],
    cacheHit: false,
    hash: 'stub',
  };
}

interface BuildOpts {
  readonly cwd: string;
  readonly fsmPath: string;
  readonly hooks?: Partial<RunCliTestHooks>;
}

function buildOpts(b: BuildOpts): RunCliForTestOpts {
  return {
    fsmPath: b.fsmPath,
    cwd: b.cwd,
    stderr: process.stderr,
    stdout: process.stdout,
    verify: async () => ({ exitCode: 0 }),
    versionGate: async () => ({ ok: true, found: '0.0.0', required: '0.0.0' }),
    authJsonExists: () => true,
    loadFsmImpl: (async () => makeStubLoadFsmResult()) as unknown as RunCliTestHooks['loadFsmImpl'],
    // Default spawnAppServer that fails — tests that pass the pre-spawn
    // gates must override this. Cases that bail at a pre-spawn gate
    // never reach the spawn site.
    spawnAppServer: vi.fn(async () => {
      throw new Error('test: unexpected spawnAppServer call');
    }) as unknown as RunCliTestHooks['spawnAppServer'],
    launchBrowserImpl: vi.fn(() => ({ ok: true })),
    ...b.hooks,
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('runCliForTest — pre-spawn gates', () => {
  let repoRoot: string;
  let stderrBuf: string[];
  let stderrSink: NodeJS.WritableStream;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'aharness-runcli-'));
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

  it('case 1: verify failure → bail with verify exit code, no app-server spawn', async () => {
    const fsmPath = makeFsmFile(repoRoot);
    const spawnAppServer = vi.fn(async () => makeStubAppServer());
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        verify: async () => ({ exitCode: 1 }),
        spawnAppServer,
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('case 2: version-gate failure → exit 2 with stderr message, no app-server spawn', async () => {
    const fsmPath = makeFsmFile(repoRoot);
    const spawnAppServer = vi.fn(async () => makeStubAppServer());
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        versionGate: async () => ({
          ok: false,
          found: null,
          required: '0.42.0',
          message: 'codex too old',
        }),
        spawnAppServer,
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(2);
    expect(stderrBuf.join('')).toContain('aharness: codex too old');
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('case 3a: legacy resume option still starts a fresh run and ignores prior snapshots', async () => {
    const fsmName = 'legacy-resume-ignored.fsm.ts';
    const fsmPath = makeFsmFile(repoRoot, fsmName);
    const fsmBase = basename(fsmPath, '.fsm.ts');
    const fsmHash = createHash('sha256').update(fsmBase).digest('hex').slice(0, 6);
    const existingRunId = `${fsmHash}-aaaaaa`;
    const existingRoot = join(repoRoot, '.aharness', 'runs', existingRunId);
    mkdirSync(existingRoot, { recursive: true });

    const loaded = makeStubLoadFsmResult();
    const actor = createActor(loaded.machine);
    actor.start();
    const persisted = actor.getPersistedSnapshot();
    actor.stop();
    flushHeadlessSnapshotEnvelope(join(existingRoot, 'snapshot.json'), {
      xstate: persisted,
      aharnessSubmitToolName: 'aharness_submit',
      threadId: 'thread-prior',
    });

    let capturedSock: string | undefined;
    let capturedSnapshot: UiSnapshot | undefined;
    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      capturedSnapshot = options.eventLog.snapshot();
      return {
        url: 'http://127.0.0.1:45678',
        close: vi.fn(async () => undefined),
      };
    });
    const spawnAppServer = vi.fn(async (input) => {
      capturedSock = input.sockPath;
      throw new Error('test-abort-after-spawn-args-captured');
    });

    const opts = {
      ...buildOpts({
        cwd: repoRoot,
        fsmPath,
        hooks: {
          loadFsmImpl: (async () => loaded) as unknown as RunCliTestHooks['loadFsmImpl'],
          startUiServerImpl,
          spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
        },
      }),
      resume: true,
      stderr: stderrSink,
    } as RunCliForTestOpts;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(capturedSock).toBeDefined();
    expect(capturedSock).not.toBe(join(existingRoot, 'app-server.sock'));
    expect(capturedSock).toMatch(new RegExp(`/${fsmHash}-[0-9a-f]{6}/app-server.sock$`));
    expect(capturedSnapshot?.state.run.runId).not.toBe(existingRunId);
    expect(capturedSnapshot?.state.posture).not.toHaveProperty('pendingClear');
  });

  it('case 3b: legacy resume option starts with thread/start, never thread/resume', async () => {
    const fsmName = 'legacy-resume-thread-start.fsm.ts';
    const fsmPath = makeFsmFile(repoRoot, fsmName);
    const fsmBase = basename(fsmPath, '.fsm.ts');
    const fsmHash = createHash('sha256').update(fsmBase).digest('hex').slice(0, 6);
    const priorRunId = `${fsmHash}-bbbbbb`;
    const priorRoot = join(repoRoot, '.aharness', 'runs', priorRunId);
    mkdirSync(priorRoot, { recursive: true });
    const loaded = makeStubLoadFsmResult();
    const actor = createActor(loaded.machine);
    actor.start();
    const persisted = actor.getPersistedSnapshot();
    actor.stop();
    flushHeadlessSnapshotEnvelope(join(priorRoot, 'snapshot.json'), {
      xstate: persisted,
      aharnessSubmitToolName: 'aharness_submit',
      threadId: 'thread-prior',
    });

    const outboundMethods: string[] = [];
    let transport!: Transport;
    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as { id?: number; method?: string };
          if (envelope.method) outboundMethods.push(envelope.method);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { serverInfo: { name: 'stub', version: '0.0.0' } },
              }),
            );
          }
          if (envelope.method === METHOD.threadStart || envelope.method === METHOD.threadResume) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                error: { code: -32000, message: 'stop after thread method' },
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

    const opts = {
      ...buildOpts({
        cwd: repoRoot,
        fsmPath,
        hooks: {
          loadFsmImpl: (async () => loaded) as unknown as RunCliTestHooks['loadFsmImpl'],
          spawnAppServer: (async () =>
            makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
          connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        },
      }),
      resume: true,
      stderr: stderrSink,
    } as RunCliForTestOpts;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(outboundMethods).toContain(METHOD.threadStart);
    expect(outboundMethods).not.toContain(METHOD.threadResume);
  });

  it('case 3c: bare invocation mints a fresh run dir even when a prior one exists', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'fresh.fsm.ts');
    const fsmBase = basename(fsmPath, '.fsm.ts');
    const fsmHash = createHash('sha256').update(fsmBase).digest('hex').slice(0, 6);
    const existingRunId = `${fsmHash}-aaaaaa`;
    const existingRoot = join(repoRoot, '.aharness', 'runs', existingRunId);
    mkdirSync(existingRoot, { recursive: true });

    let capturedSock: string | undefined;
    const spawnAppServer = vi.fn(async (input) => {
      capturedSock = input.sockPath;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(capturedSock).toBeDefined();
    expect(capturedSock).not.toContain(existingRunId);
    expect(capturedSock).toMatch(new RegExp(`/${fsmHash}-[0-9a-f]{6}/app-server.sock$`));
  });

  it('registers approval handlers in the pre-initialize WS window', async () => {
    const fsmPath = makeFsmFile(repoRoot);
    const registeredServerRequests: string[] = [];
    const registeredNotifications: string[] = [];
    const connectStub = vi.fn(async (opts: ConnectHeadlessWsOptions) => {
      const transport: Transport = {
        send() {
          /* no initialize is sent in this test; registration is the assertion. */
        },
        async close() {
          /* no-op */
        },
      };
      const client = new JsonRpcClient(transport);
      const onServerRequest = client.onServerRequest.bind(client);
      client.onServerRequest = ((method, handler) => {
        registeredServerRequests.push(method);
        onServerRequest(method, handler);
      }) as JsonRpcClient['onServerRequest'];
      const onNotification = client.onNotification.bind(client);
      client.onNotification = ((method, handler) => {
        registeredNotifications.push(method);
        return onNotification(method, handler);
      }) as JsonRpcClient['onNotification'];

      opts.registerHandlers?.(client);
      throw new Error('test-stop-after-registerHandlers');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: vi.fn(async () => makeStubAppServer()),
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      },
    });

    const result = await runCliForTest(opts);

    expect(result.exitCode).toBe(1);
    expect(registeredServerRequests).toEqual(
      expect.arrayContaining([
        METHOD.commandExecutionRequestApproval,
        METHOD.fileChangeRequestApproval,
        METHOD.toolDynamicCall,
        METHOD.toolRequestUserInput,
        METHOD.mcpServerElicitationRequest,
        METHOD.permissionsRequestApproval,
      ]),
    );
    expect(registeredNotifications).toEqual(
      expect.arrayContaining([
        METHOD.fileChangePatchUpdated,
        METHOD.serverRequestResolved,
        METHOD.rawResponseItemCompleted,
      ]),
    );
  });

  it('case 3d: legacy resume option with no prior run emits no resume notice', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'noprior.fsm.ts');
    const fsmBase = basename(fsmPath, '.fsm.ts');
    const fsmHash = createHash('sha256').update(fsmBase).digest('hex').slice(0, 6);

    const spawnAppServer = vi.fn(async () => {
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = {
      ...buildOpts({
        cwd: repoRoot,
        fsmPath,
        hooks: {
          spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
        },
      }),
      resume: true,
      stderr: stderrSink,
    } as RunCliForTestOpts;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1); // bailed in stub spawn
    expect(stderrBuf.join('')).not.toContain('--resume requested');
    const runs = join(repoRoot, '.aharness', 'runs');
    const created = readdirSync(runs);
    expect(created.some((n) => n.startsWith(`${fsmHash}-`))).toBe(true);
  });

  it('case 6: auth.json missing → exit 1, app-server not spawned, stderr message', async () => {
    const fsmPath = makeFsmFile(repoRoot);
    const spawnAppServer = vi.fn(async () => makeStubAppServer());
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        authJsonExists: () => false,
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('~/.codex/auth.json not found');
    expect(stderrBuf.join('')).toContain('codex login');
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('reports missing required input flags with descriptions and an example command', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'pipeline.fsm.ts');
    const spawnAppServer = vi.fn(async () => makeStubAppServer());
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          ...makeStubLoadFsmResult(),
          inputSchema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
            additionalProperties: false,
          },
          inputFlags: { topic: { description: 'Project topic' } },
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(2);
    const err = stderrBuf.join('');
    expect(err).toContain('missing required flag --topic');
    expect(err).toContain('Required input flags:');
    expect(err).toContain('--topic <string>');
    expect(err).toContain('Project topic');
    expect(err).toContain('Example: aharness pipeline.fsm.ts --topic <string>');
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('passes the fixed on-request approval policy for a zero-hook run', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'approval-policy.fsm.ts');
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual([APPROVAL_POLICY_OVERRIDE]);
  });

  it('passes the fixed approval policy before mock-model provider overrides', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'mock-model.fsm.ts');
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;
    opts._testMockModelBaseUrl = 'http://127.0.0.1:17777';

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual([
      APPROVAL_POLICY_OVERRIDE,
      ['model_provider', '"mock"'],
      ['model_providers.mock.name', '"mock"'],
      ['model_providers.mock.base_url', '"http://127.0.0.1:17777"'],
      ['model_providers.mock.wire_api', '"responses"'],
    ]);
  });

  it('passes YOLO approval and sandbox overrides for a zero-hook run', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'yolo.fsm.ts');
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;
    opts.yolo = true;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual(YOLO_OVERRIDES);
  });

  it('passes YOLO overrides before mock-model provider overrides', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'yolo-mock-model.fsm.ts');
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;
    opts.yolo = true;
    opts._testMockModelBaseUrl = 'http://127.0.0.1:17777';

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual([
      ...YOLO_OVERRIDES,
      ['model_provider', '"mock"'],
      ['model_providers.mock.name', '"mock"'],
      ['model_providers.mock.base_url', '"http://127.0.0.1:17777"'],
      ['model_providers.mock.wire_api', '"responses"'],
    ]);
  });

  it('case 7: FSM declaring hooks materializes wrappers and passes hook overrides', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'hooked.fsm.ts');
    const m = aharness.machine({
      id: 'hooked',
      initial: 'work',
      states: {
        work: state({
          entryPrompt: 'work',
          exits: { done: exit({ to: 'finish' }) },
          hooks: {
            preToolUse: [{ matcher: 'shell', handler: () => ({}) }],
          },
        }),
        finish: terminal('success'),
      },
    });
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar: {},
          modulePath: '/tmp/stub.mjs',
          issues: [],
          cacheHit: false,
          hash: 'stub',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('app-server failed');
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual([
      APPROVAL_POLICY_OVERRIDE,
      ['hooks.PreToolUse', expect.stringMatching(/hooks = .*pre_tool_use\.sh.*timeout = 30/)],
    ]);
    const runs = readdirSync(join(repoRoot, '.aharness', 'runs'));
    expect(runs).toHaveLength(1);
    const hookDir = join(repoRoot, '.aharness', 'runs', runs[0]!, 'hooks');
    expect(existsSync(join(hookDir, 'pre_tool_use.sh'))).toBe(true);
    expect(existsSync(join(hookDir, 'post_tool_use.sh'))).toBe(false);
    expect(existsSync(join(hookDir, 'user_prompt_submit.sh'))).toBe(false);
  });

  it('case 7b: permissionRequest-only FSM emits no codex hook overrides or wrappers', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'permission-only.fsm.ts');
    const m = aharness.machine({
      id: 'permissionOnly',
      initial: 'work',
      states: {
        work: state({
          entryPrompt: 'work',
          exits: { done: exit({ to: 'finish' }) },
          hooks: {
            permissionRequest: [{ matcher: '^Bash$', handler: () => 'delegate' }],
          },
        }),
        finish: terminal('success'),
      },
    });
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar: {},
          modulePath: '/tmp/stub.mjs',
          issues: [],
          cacheHit: false,
          hash: 'stub',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual([APPROVAL_POLICY_OVERRIDE]);
    const runs = readdirSync(join(repoRoot, '.aharness', 'runs'));
    expect(runs).toHaveLength(1);
    const runRoot = join(repoRoot, '.aharness', 'runs', runs[0]!);
    expect(existsSync(join(runRoot, 'hook.sock'))).toBe(false);
    expect(existsSync(join(runRoot, 'hooks', 'permission_request.sh'))).toBe(false);
  });

  it('case 7c: mixed permissionRequest plus preToolUse materializes only PreToolUse wiring', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'mixed-hooks.fsm.ts');
    const m = aharness.machine({
      id: 'mixedHooks',
      initial: 'work',
      states: {
        work: state({
          entryPrompt: 'work',
          exits: { done: exit({ to: 'finish' }) },
          hooks: {
            permissionRequest: [{ matcher: '^Bash$', handler: () => 'delegate' }],
            preToolUse: [{ matcher: '^Bash$', handler: () => undefined }],
          },
        }),
        finish: terminal('success'),
      },
    });
    let capturedOverrides: ReadonlyArray<readonly [string, string]> | undefined;
    const spawnAppServer = vi.fn(async (opts: SpawnAppServerOptions) => {
      capturedOverrides = opts.cliOverrides;
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar: {},
          modulePath: '/tmp/stub.mjs',
          issues: [],
          cacheHit: false,
          hash: 'stub',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(capturedOverrides).toEqual([
      APPROVAL_POLICY_OVERRIDE,
      ['hooks.PreToolUse', expect.stringMatching(/hooks = .*pre_tool_use\.sh.*timeout = 30/)],
    ]);
    const runs = readdirSync(join(repoRoot, '.aharness', 'runs'));
    expect(runs).toHaveLength(1);
    const hookDir = join(repoRoot, '.aharness', 'runs', runs[0]!, 'hooks');
    expect(existsSync(join(hookDir, 'pre_tool_use.sh'))).toBe(true);
    expect(existsSync(join(hookDir, 'permission_request.sh'))).toBe(false);
  });

  it('case 9: onEntry errors are surfaced without aborting the already-committed run', async () => {
    interface DonePayload {
      ok: boolean;
    }
    const m = aharness.machine({
      id: 'entry-throw',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'in a',
          onEntry: () => {
            throw new Error('entry exploded');
          },
          exits: { done: exit<DonePayload>({ to: 'b' }) },
        }),
        b: terminal('success'),
      },
    });
    const sidecar = {
      a: {
        done: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const fsmName = 'entry-throw.fsm.ts';
    const fsmPath = makeFsmFile(repoRoot, fsmName);
    const threadId = 'thread-entry-throw';
    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    const waitForOutbound = async (
      predicate: (envelope: { method?: string; id?: number; result?: unknown }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound.map((m) => m.method).join(', ')}`,
      );
    };
    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: threadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.turnStarted,
        params: { threadId, turn: { id: 'turn-entry' } },
      });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9001,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-entry',
          callId: 'call-entry',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'done', data: { ok: true } }),
        },
      });
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/entry-throw.mjs',
          issues: [],
          cacheHit: false,
          hash: 'entry-throw',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(stderrBuf.join('')).toContain("onEntry hook for state 'a' threw: entry exploded");
  });

  it('case 11: starts the UI server before app-server spawn, prints its URL, and publishes initial run state', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ui-boot.fsm.ts');
    const stdout = makeWritableBuffer();
    const order: string[] = [];
    const published: ReplayableAppEvent[] = [];
    let capturedSnapshot: UiSnapshot | undefined;

    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      order.push('ui-server');
      capturedSnapshot = options.eventLog.snapshot();
      return {
        url: 'http://127.0.0.1:45678',
        close: vi.fn(async () => undefined),
      };
    });
    const spawnAppServer = vi.fn(async () => {
      order.push('app-server');
      throw new Error('test-abort-after-spawn-args-captured');
    });

    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        startUiServerImpl,
        _testOnUiEvent: (event) => published.push(event),
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stdout = stdout.sink;
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(startUiServerImpl).toHaveBeenCalledTimes(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['ui-server', 'app-server']);
    expect(stdout.text()).toContain('http://127.0.0.1:45678');
    expect(capturedSnapshot?.state.run).toMatchObject({
      runId: expect.stringMatching(/^[0-9a-f]{6}-[0-9a-f]{6}$/),
      repoRoot,
      fsmFile: fsmPath,
    });
    expect(capturedSnapshot?.state.currentState).toMatchObject({
      path: 'greet',
      leaf: 'greet',
      kind: 'stateful',
    });
    expect(capturedSnapshot?.state.topology).toMatchObject({
      machineId: 'stub',
      initial: 'greet',
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'greet', kind: 'stateful' }),
        expect.objectContaining({ id: 'done', kind: 'terminal' }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({
          id: 'greet::finish',
          from: 'greet',
          to: 'done',
          kind: 'submit',
        }),
      ]),
    });
    expect(capturedSnapshot?.state.posture).toMatchObject({
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    });
    expect(capturedSnapshot?.latestEventId).toBe('1');
    expect(published[0]).toMatchObject({
      id: '1',
      event: {
        kind: 'StateChange',
        from: null,
        to: 'greet',
        cause: 'boot',
      },
    });
  });

  it('keeps the browser useful when canonical runtime append fails', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ui-append-warning.fsm.ts');
    const published: ReplayableAppEvent[] = [];
    const spawnAppServer = vi.fn(async () => {
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        _testRunEventRecorder: failingRunEventRecorder(),
        _testOnUiEvent: (event) => published.push(event),
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(stderrBuf.join('')).toContain('events.jsonl append failed');
    expect(published.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'FrameworkNote',
          variant: 'warn',
          text: expect.stringContaining('events.jsonl append failed'),
        }),
        expect.objectContaining({
          kind: 'StateChange',
          from: null,
          to: 'greet',
          cause: 'boot',
        }),
      ]),
    );
  });

  it('case 12: closes the UI server when app-server spawn fails', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ui-close-on-spawn-fail.fsm.ts');
    const closeUiServer = vi.fn(async () => undefined);
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:45678',
      close: closeUiServer,
    }));
    const spawnAppServer = vi.fn(async () => {
      throw new Error('spawn exploded');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        startUiServerImpl,
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(startUiServerImpl).toHaveBeenCalledTimes(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(closeUiServer).toHaveBeenCalledTimes(1);
    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    expect(eventEntries.map((entry) => entry.type)).toEqual([
      'run.started',
      'state.changed',
      'run.failed',
    ]);
    expect(eventEntries.at(-1)).toEqual(
      expect.objectContaining({
        type: 'run.failed',
        data: expect.objectContaining({
          status: 'failed',
          message: 'app-server failed: spawn exploded',
        }),
      }),
    );
  });

  it('case 13: reports UI server startup failure and does not spawn app-server', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ui-start-failure.fsm.ts');
    const startUiServerImpl = vi.fn(async () => {
      throw new Error('port unavailable');
    });
    const spawnAppServer = vi.fn(async () => {
      throw new Error('app-server should not start after UI failure');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        startUiServerImpl,
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('aharness: UI server failed: port unavailable');
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('case 14: closes the UI server when thread/start fails after WS connect', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ui-close-on-thread-start-fail.fsm.ts');
    const closeUiServer = vi.fn(async () => undefined);
    const closeAppServer = vi.fn(async () => undefined);
    let transport!: Transport;

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as { id?: number; method?: string };
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { serverInfo: { name: 'stub', version: '0.0.0' } },
              }),
            );
          }
          if (envelope.method === METHOD.threadStart) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                error: { code: -32000, message: 'thread start exploded' },
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

    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        spawnAppServer: (async () => ({
          ...makeStubAppServer(),
          close: closeAppServer,
        })) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async () => ({
          url: 'http://127.0.0.1:45678',
          close: closeUiServer,
        }),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('thread start exploded');
    expect(closeAppServer).toHaveBeenCalledTimes(1);
    expect(closeUiServer).toHaveBeenCalledTimes(1);
  });

  it('case 15: production runCli source does not import the legacy stdout UI substitute', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'cli', 'runCli.ts'), 'utf8');

    expect(source).not.toContain("from './stdoutUI.js'");
    expect(source).not.toContain('createStdoutUI');
  });

  it('case 16: publishes owner input requests and resolves them through the browser reply handler', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'browser-owner-input.fsm.ts');
    const m = aharness.machine({
      id: 'browser-owner-input',
      initial: 'greet',
      states: {
        greet: state({
          entryPrompt: 'ask owner',
          exits: { finish: exit<FinishPayload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      greet: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    const published: ReplayableAppEvent[] = [];
    let transport!: Transport;
    let capturedReplyHandler: StartUiServerOptions['replyHandler'];

    const waitForOutbound = async (
      predicate: (envelope: { method?: string; id?: number; result?: unknown }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: 'thread-browser-owner-input', ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      if (capturedReplyHandler !== undefined) {
        transport.onMessage?.({
          jsonrpc: '2.0',
          id: 9100,
          method: METHOD.toolRequestUserInput,
          params: {
            itemId: 'item-owner-1',
            questions: [
              {
                id: 'owner',
                header: 'Owner',
                question: 'What should happen next?',
                isOther: true,
                isSecret: false,
                options: [
                  {
                    label: 'Custom answer (Recommended)',
                    description: 'Type the requested owner reply.',
                  },
                ],
              },
            ],
          },
        });
        const replyResult = await capturedReplyHandler({
          kind: 'owner-input',
          requestId: 'item-owner-1',
          answers: { owner: 'alice' },
        });
        expect(replyResult.status).toBe(200);
        await waitForOutbound(
          (msg) =>
            msg.id === 9100 &&
            JSON.stringify(msg.result).includes('"alice"') &&
            JSON.stringify(msg.result).includes('"owner"'),
        );
      }

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9200,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: 'thread-browser-owner-input',
          turnId: 'turn-browser-owner-input',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'greet', exit: 'finish', data: { ok: true } }),
        },
      });
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/browser-owner-input.mjs',
          issues: [],
          cacheHit: false,
          hash: 'browser-owner-input',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          capturedReplyHandler = options.replyHandler;
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
        _testOnUiEvent: (event) => published.push(event),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(capturedReplyHandler).toBeTypeOf('function');
    expect(published.map((event) => event.event)).toContainEqual({
      kind: 'ServerRequest',
      id: 'item-owner-1',
      method: METHOD.toolRequestUserInput,
      questions: [
        {
          id: 'owner',
          header: 'Owner',
          question: 'What should happen next?',
          isOther: true,
          isSecret: false,
          choices: ['Custom answer (Recommended)', '__other__'],
        },
      ],
    });

    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    expect(eventEntries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'state.changed',
        'request.created',
        'request.resolved',
        'run.completed',
        'posture.changed',
      ]),
    );
    expect(eventEntries.find((entry) => entry.type === 'run.started')).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: expect.stringMatching(/^[0-9a-f]{6}-[0-9a-f]{6}$/),
          repoRoot,
          fsmFile: fsmPath,
        }),
      }),
    );
    expect(eventEntries.find((entry) => entry.type === 'request.created')).toEqual(
      expect.objectContaining({
        requestId: 'item-owner-1',
        data: expect.objectContaining({
          kind: 'owner-input',
          questionCount: 1,
          status: 'pending',
        }),
      }),
    );
    expect(eventEntries.find((entry) => entry.type === 'run.completed')).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'done',
          terminal: 'success',
          status: 'success',
        }),
      }),
    );
  });

  it('case 17: user-prompt reply in an open state starts a turn with the active thread id and user text', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'open-user-prompt.fsm.ts');
    const m = aharness.machine({
      id: 'open-user-prompt',
      initial: 'chat',
      states: {
        chat: state({
          open: true,
          entryPrompt: 'open chat',
          exits: { finish: exit<FinishPayload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      chat: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    let capturedReplyHandler: StartUiServerOptions['replyHandler'];
    const threadId = 'thread-open-user-prompt';

    const waitForOutbound = async (
      predicate: (envelope: { method?: string; id?: number; params?: unknown }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: threadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      if (capturedReplyHandler === undefined) {
        throw new Error('reply handler was not captured');
      }
      const replyPromise = capturedReplyHandler({
        kind: 'user-prompt',
        text: 'hello from browser',
      });
      const userPromptTurn = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.turnStart &&
          JSON.stringify(msg.params).includes('hello from browser'),
      );
      transport.onMessage?.({ jsonrpc: '2.0', id: userPromptTurn.id, result: {} });
      const replyResult = await replyPromise;
      expect(replyResult.status).toBe(200);
      expect(userPromptTurn.params).toEqual({
        threadId,
        input: [{ type: 'text', text: 'hello from browser' }],
      });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9300,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-open-user-prompt',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'chat', exit: 'finish', data: { ok: true } }),
        },
      });
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/open-user-prompt.mjs',
          issues: [],
          cacheHit: false,
          hash: 'open-user-prompt',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          capturedReplyHandler = options.replyHandler;
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
  });

  it('routes browser replies, notifications, metadata, and file-change correlation through the active binding', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'active-binding-routing.fsm.ts');
    const m = aharness.machine({
      id: 'active-binding-routing',
      initial: 'chat',
      states: {
        chat: state({
          open: true,
          entryPrompt: 'open chat',
          exits: { finish: exit<FinishPayload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      chat: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    const published: ReplayableAppEvent[] = [];
    const stdout = makeWritableBuffer();
    let transport!: Transport;
    let capturedReplyHandler: StartUiServerOptions['replyHandler'];
    let readUiSnapshot: (() => UiSnapshot) | undefined;
    let activeBinding: ActiveThreadBinding | undefined;
    let readPendingOwnerYieldCount: (() => number) | undefined;
    const startupThreadId = 'thread-startup-binding';
    const replacementThreadId = 'thread-replacement-binding';

    const waitForOutbound = async (
      predicate: (envelope: {
        method?: string;
        id?: number;
        params?: unknown;
        result?: unknown;
      }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.agentMessageDelta,
        params: {
          turnId: 'turn-pre-start',
          itemId: 'pre-start-delta',
          delta: 'pre-start delta',
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: startupThreadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      if (capturedReplyHandler === undefined) {
        throw new Error('reply handler was not captured');
      }
      if (activeBinding === undefined) {
        throw new Error('active binding was not captured');
      }

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9400,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-owner-old',
          itemId: 'owner-old-1',
          questions: [
            {
              id: 'owner',
              header: 'Owner',
              question: 'What should happen next?',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(
          published.some(
            (event) =>
              event.event.kind === 'ServerRequest' &&
              event.event.method === METHOD.toolRequestUserInput &&
              event.event.id === 'owner-old-1',
          ),
        ).toBe(true),
      );
      await vi.waitFor(() => expect(readPendingOwnerYieldCount?.()).toBe(1));

      activeBinding.set(replacementThreadId);
      const abandonedOwnerReply = await waitForOutbound(
        (msg) => msg.id === 9400 && msg.result !== undefined,
      );
      expect(abandonedOwnerReply.result).toEqual({
        answers: { owner: { answers: ['(declined)'] } },
      });
      await vi.waitFor(() => expect(readPendingOwnerYieldCount?.()).toBe(0));
      await vi.waitFor(() =>
        expect(
          published.some(
            (event) =>
              event.event.kind === 'OwnerInputResolved' && event.event.id === 'owner-old-1',
          ),
        ).toBe(true),
      );
      const staleOwnerReply = await capturedReplyHandler({
        kind: 'owner-input',
        requestId: 'owner-old-1',
        answers: { owner: 'alice' },
      });
      expect(staleOwnerReply).toEqual({
        status: 409,
        body: { error: 'no-pending-owner-input' },
      });

      const replyPromise = capturedReplyHandler({
        kind: 'user-prompt',
        text: 'hello after binding swap',
      });
      const browserTurn = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.turnStart &&
          JSON.stringify(msg.params).includes('hello after binding swap'),
      );
      expect(browserTurn.params).toEqual({
        threadId: replacementThreadId,
        input: [{ type: 'text', text: 'hello after binding swap' }],
      });
      transport.onMessage?.({ jsonrpc: '2.0', id: browserTurn.id, result: {} });
      await expect(replyPromise).resolves.toMatchObject({ status: 200 });

      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId: startupThreadId, turn: { id: 'turn-old' } },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.agentMessageDelta,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          itemId: 'old-delta',
          delta: 'old delta',
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old-file',
          item: {
            type: 'fileChange',
            id: 'old-patch-1',
            changes: [{ path: 'src/old.ts', kind: { type: 'update' }, diff: '@@ old' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-file',
          item: {
            type: 'fileChange',
            id: 'patch-1',
            changes: [{ path: 'src/file.ts', kind: { type: 'update' }, diff: '@@' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.agentMessageDelta,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-new',
          itemId: 'new-delta',
          delta: 'new delta',
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: { threadId: replacementThreadId, turn: { id: 'turn-new' } },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9500,
        method: METHOD.fileChangeRequestApproval,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-file',
          itemId: 'patch-1',
          reason: 'needs review',
          grantRoot: repoRoot,
        },
      });

      await vi.waitFor(() =>
        expect(
          published.some(
            (event) =>
              event.event.kind === 'ServerRequest' &&
              event.event.method === METHOD.fileChangeRequestApproval &&
              event.event.threadId === replacementThreadId &&
              event.event.changes.length === 1,
          ),
        ).toBe(true),
      );

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9600,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-finish',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'chat', exit: 'finish', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9600 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/active-binding-routing.mjs',
          issues: [],
          cacheHit: false,
          hash: 'active-binding-routing',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          capturedReplyHandler = options.replyHandler;
          readUiSnapshot = () => options.eventLog.snapshot();
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
        _testOnActiveThreadBinding: (binding) => {
          activeBinding = binding;
        },
        _testReadPendingOwnerYieldCount: (read) => {
          readPendingOwnerYieldCount = read;
        },
        _testOnUiEvent: (event) => published.push(event),
      },
    });
    opts.stderr = stderrSink;
    opts.stdout = stdout.sink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(stdout.text()).not.toContain('pre-start delta');
    expect(stdout.text()).not.toContain('old delta');
    expect(stdout.text()).toContain('new delta');
    expect(
      published.some(
        (event) => event.event.kind === 'TurnCompleted' && event.event.turnId === 'turn-old',
      ),
    ).toBe(false);
    expect(
      published.some(
        (event) => event.event.kind === 'TurnCompleted' && event.event.turnId === 'turn-new',
      ),
    ).toBe(true);
    expect(published.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'AbandonedThreadDiagnostic',
          threadId: startupThreadId,
          source: 'parkedOwnerInput',
        }),
        expect.objectContaining({
          kind: 'AbandonedThreadDiagnostic',
          threadId: startupThreadId,
          source: 'turnCompleted',
        }),
        expect.objectContaining({
          kind: 'AbandonedThreadDiagnostic',
          threadId: startupThreadId,
          source: 'agentMessageDelta',
        }),
        expect.objectContaining({
          kind: 'AbandonedThreadDiagnostic',
          threadId: startupThreadId,
          source: 'itemCompleted',
        }),
      ]),
    );
    const runId = readdirSync(join(repoRoot, '.aharness', 'runs'))[0];
    if (!runId) throw new Error('missing run dir');
    const eventEntries = readFileSync(
      join(repoRoot, '.aharness', 'runs', runId, 'events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            schema?: string;
            type?: string;
            threadId?: string;
            data?: Record<string, unknown>;
          },
      );
    expect(eventEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'aharness.event.v1',
          type: 'diagnostic.abandoned_thread',
          threadId: startupThreadId,
          data: expect.objectContaining({ source: 'turnCompleted' }),
        }),
      ]),
    );
    expect(eventEntries.every((entry) => !('kind' in entry) && !('ts' in entry))).toBe(true);
    const snapshot = loadHeadlessSnapshotEnvelope(
      join(repoRoot, '.aharness', 'runs', runId, 'snapshot.json'),
    );
    expect(snapshot.kind).toBe('ok');
    if (snapshot.kind !== 'ok') throw new Error('snapshot did not load');
    expect(snapshot.envelope.threadId).toBe(replacementThreadId);
    expect(readUiSnapshot?.().state.run?.threadId).toBe(replacementThreadId);
    expect(readUiSnapshot?.().state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: startupThreadId, source: 'turnCompleted' }),
      ]),
    );
  });

  it('resolves parked approvals on active-thread binding swap and rejects later browser replies', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'active-binding-approval-cleanup.fsm.ts');
    const m = aharness.machine({
      id: 'active-binding-approval-cleanup',
      initial: 'chat',
      states: {
        chat: state({
          entryPrompt: 'approval cleanup',
          exits: { finish: exit<FinishPayload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      chat: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    const published: ReplayableAppEvent[] = [];
    let transport!: Transport;
    let capturedReplyHandler: StartUiServerOptions['replyHandler'];
    let activeBinding: ActiveThreadBinding | undefined;
    const startupThreadId = 'thread-approval-cleanup-startup';
    const replacementThreadId = 'thread-approval-cleanup-replacement';

    const waitForOutbound = async (
      predicate: (envelope: {
        method?: string;
        id?: number;
        params?: unknown;
        result?: unknown;
      }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: startupThreadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });
      if (capturedReplyHandler === undefined) {
        throw new Error('reply handler was not captured');
      }
      if (activeBinding === undefined) {
        throw new Error('active binding was not captured');
      }

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9700,
        method: METHOD.permissionsRequestApproval,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-permission',
          itemId: 'permission-1',
          cwd: repoRoot,
          permissions: { network: null, fileSystem: null },
        },
      });

      await vi.waitFor(() =>
        expect(
          published.some(
            (event) =>
              event.event.kind === 'ServerRequest' &&
              event.event.method === METHOD.permissionsRequestApproval &&
              event.event.threadId === startupThreadId,
          ),
        ).toBe(true),
      );
      const permissionRequest = published.find(
        (event) =>
          event.event.kind === 'ServerRequest' &&
          event.event.method === METHOD.permissionsRequestApproval,
      )?.event;
      if (permissionRequest?.kind !== 'ServerRequest') {
        throw new Error('permission request was not published');
      }

      activeBinding.set(replacementThreadId);
      const abandonedReply = await waitForOutbound(
        (msg) => msg.id === 9700 && msg.result !== undefined,
      );
      expect(abandonedReply.result).toEqual({ permissions: {}, scope: 'turn' });
      await vi.waitFor(() =>
        expect(
          published.some(
            (event) =>
              event.event.kind === 'ApprovalRequestResolved' &&
              event.event.requestId === permissionRequest.requestId,
          ),
        ).toBe(true),
      );

      const staleBrowserReply = await capturedReplyHandler({
        kind: 'permission',
        requestId: permissionRequest.requestId,
        decision: 'accept',
      });
      expect(staleBrowserReply).toEqual({
        status: 409,
        body: { error: 'approval-request-not-pending' },
      });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9701,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-finish',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'chat', exit: 'finish', data: { ok: true } }),
        },
      });
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/active-binding-approval-cleanup.mjs',
          issues: [],
          cacheHit: false,
          hash: 'active-binding-approval-cleanup',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          capturedReplyHandler = options.replyHandler;
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
        _testOnActiveThreadBinding: (binding) => {
          activeBinding = binding;
        },
        _testOnUiEvent: (event) => published.push(event),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(published.map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        kind: 'AbandonedThreadDiagnostic',
        threadId: startupThreadId,
        source: 'parkedApproval',
      }),
    );
  });

  it('publishes a fresh clear boundary only after replacement orientation succeeds', async () => {
    interface Payload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'fresh-clear-boundary.fsm.ts');
    const m = aharness.machine({
      id: 'fresh-clear-boundary',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { go: exit<Payload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          clearOnEntry: true,
          exits: { done: exit<Payload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const validator = {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true as const, data: input }),
    };
    const sidecar = { a: { go: validator }, b: { done: validator } };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    const published: ReplayableAppEvent[] = [];
    let transport!: Transport;
    const startupThreadId = 'thread-fresh-clear-startup';
    const replacementThreadId = 'thread-fresh-clear-replacement';

    const waitForOutbound = async (
      predicate: (envelope: {
        method?: string;
        id?: number;
        params?: unknown;
        result?: unknown;
      }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const initialThreadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      expect((initialThreadStart.params as { cwd?: unknown }).cwd).toBe(repoRoot);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: initialThreadStart.id,
        result: { thread: { id: startupThreadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9800,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          callId: 'call-go',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9800 && msg.result !== undefined);

      const interrupt = await waitForOutbound((msg) => msg.method === METHOD.turnInterrupt);
      transport.onMessage?.({ jsonrpc: '2.0', id: interrupt.id, result: {} });

      const unsubscribe = await waitForOutbound((msg) => msg.method === METHOD.threadUnsubscribe);
      transport.onMessage?.({ jsonrpc: '2.0', id: unsubscribe.id, result: {} });

      const replacementThreadStart = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.threadStart &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { sessionStartSource?: unknown }).sessionStartSource === 'clear',
      );
      expect((replacementThreadStart.params as { cwd?: unknown }).cwd).toBe(repoRoot);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: replacementThreadStart.id,
        result: { thread: { id: replacementThreadId, ephemeral: false } },
      });

      const replacementTurnStart = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.turnStart &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { threadId?: unknown }).threadId === replacementThreadId,
      );
      expect(published.map((entry) => entry.event)).not.toContainEqual(
        expect.objectContaining({ kind: 'FreshClearBoundary' }),
      );
      transport.onMessage?.({ jsonrpc: '2.0', id: replacementTurnStart.id, result: {} });

      await vi.waitFor(() =>
        expect(published.map((entry) => entry.event)).toContainEqual(
          expect.objectContaining({
            kind: 'FreshClearBoundary',
            reason: 'clearOnEntry',
            previousThreadId: startupThreadId,
            nextThreadId: replacementThreadId,
            statePath: 'b',
          }),
        ),
      );

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9801,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-new',
          callId: 'call-done',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9801 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/fresh-clear-boundary.mjs',
          issues: [],
          cacheHit: false,
          hash: 'fresh-clear-boundary',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async () => ({
          url: 'http://127.0.0.1:45678',
          close: vi.fn(async () => undefined),
        }),
        _testOnUiEvent: (event) => published.push(event),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
  });

  it('uses resolved fresh clear cwd for replacement threads while run files stay under the launch root', async () => {
    interface Ctx {
      currentWorktreeDir: string;
    }
    interface Payload {
      worktreeDir: string;
    }

    const scenarios = [
      {
        name: 'absolute-object',
        clearOnEntry: (worktreeDir: string) => ({ cwd: worktreeDir }),
      },
      {
        name: 'post-transition-function',
        clearOnEntry: () => ({
          cwd: (data: Readonly<Ctx>) => data.currentWorktreeDir,
        }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const worktreeDir = join(repoRoot, `worktree-${scenario.name}`);
      mkdirSync(worktreeDir, { recursive: true });
      const fsmPath = makeFsmFile(repoRoot, `fresh-clear-cwd-${scenario.name}.fsm.ts`);
      const m = aharness.machine({
        id: `fresh-clear-cwd-${scenario.name}`,
        initial: 'a',
        context: (): Ctx => ({ currentWorktreeDir: '' }),
        states: {
          a: state<Ctx>({
            entryPrompt: 'state a active',
            exits: {
              go: exit<Payload>({
                to: 'b',
                actions: assign({
                  currentWorktreeDir: ({ event }) =>
                    (event as { payload: Payload }).payload.worktreeDir,
                }),
              }),
            },
          }),
          b: state<Ctx>({
            entryPrompt: 'state b active',
            clearOnEntry: scenario.clearOnEntry(worktreeDir),
            exits: { done: exit<Payload>({ to: 'done' }) },
          }),
          done: terminal('success'),
        },
      });
      const validator = {
        jsonSchema: { type: 'object' },
        validate: (input: unknown) => ({ ok: true as const, data: input }),
      };
      const sidecar = { a: { go: validator }, b: { done: validator } };

      const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
        [];
      let transport!: Transport;
      const startupThreadId = `thread-${scenario.name}-startup`;
      const replacementThreadId = `thread-${scenario.name}-replacement`;

      const waitForOutbound = async (
        predicate: (envelope: {
          method?: string;
          id?: number;
          params?: unknown;
          result?: unknown;
        }) => boolean,
        timeoutMs = 2_000,
      ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (let i = outbound.length - 1; i >= 0; i--) {
            const envelope = outbound[i];
            if (envelope && predicate(envelope)) return envelope;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(
          `timeout waiting for outbound in ${scenario.name}; saw ${outbound
            .map((message) => message.method ?? `response:${message.id}`)
            .join(', ')}`,
        );
      };

      const connectStub = async (opts: ConnectHeadlessWsOptions) => {
        transport = {
          send(msg: unknown) {
            const envelope = msg as {
              id?: number;
              method?: string;
              params?: unknown;
              result?: unknown;
            };
            outbound.push(envelope);
            if (envelope.method === METHOD.initialize) {
              queueMicrotask(() =>
                transport.onMessage?.({
                  jsonrpc: '2.0',
                  id: envelope.id,
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
      };

      const driver = async (): Promise<void> => {
        const initialThreadStart = await waitForOutbound(
          (msg) => msg.method === METHOD.threadStart,
        );
        expect((initialThreadStart.params as { cwd?: unknown }).cwd).toBe(repoRoot);
        transport.onMessage?.({
          jsonrpc: '2.0',
          id: initialThreadStart.id,
          result: { thread: { id: startupThreadId, ephemeral: false } },
        });

        const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
        transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

        transport.onMessage?.({
          jsonrpc: '2.0',
          id: 9900,
          method: METHOD.toolDynamicCall,
          params: {
            threadId: startupThreadId,
            turnId: 'turn-old',
            callId: 'call-go',
            tool: 'aharness_submit',
            arguments: JSON.stringify({
              state: 'a',
              exit: 'go',
              data: { worktreeDir },
            }),
          },
        });
        await waitForOutbound((msg) => msg.id === 9900 && msg.result !== undefined);

        const interrupt = await waitForOutbound((msg) => msg.method === METHOD.turnInterrupt);
        transport.onMessage?.({ jsonrpc: '2.0', id: interrupt.id, result: {} });

        const unsubscribe = await waitForOutbound((msg) => msg.method === METHOD.threadUnsubscribe);
        transport.onMessage?.({ jsonrpc: '2.0', id: unsubscribe.id, result: {} });

        const replacementThreadStart = await waitForOutbound(
          (msg) =>
            msg.method === METHOD.threadStart &&
            typeof msg.params === 'object' &&
            msg.params !== null &&
            (msg.params as { sessionStartSource?: unknown }).sessionStartSource === 'clear',
        );
        expect((replacementThreadStart.params as { cwd?: unknown }).cwd).toBe(worktreeDir);
        transport.onMessage?.({
          jsonrpc: '2.0',
          id: replacementThreadStart.id,
          result: { thread: { id: replacementThreadId, ephemeral: false } },
        });

        const replacementTurnStart = await waitForOutbound(
          (msg) =>
            msg.method === METHOD.turnStart &&
            typeof msg.params === 'object' &&
            msg.params !== null &&
            (msg.params as { threadId?: unknown }).threadId === replacementThreadId,
        );
        transport.onMessage?.({ jsonrpc: '2.0', id: replacementTurnStart.id, result: {} });

        transport.onMessage?.({
          jsonrpc: '2.0',
          id: 9901,
          method: METHOD.toolDynamicCall,
          params: {
            threadId: replacementThreadId,
            turnId: 'turn-new',
            callId: 'call-done',
            tool: 'aharness_submit',
            arguments: JSON.stringify({
              state: 'b',
              exit: 'done',
              data: { worktreeDir },
            }),
          },
        });
        await waitForOutbound((msg) => msg.id === 9901 && msg.result !== undefined);
      };

      const driverPromise = driver();
      const opts = buildOpts({
        cwd: repoRoot,
        fsmPath,
        hooks: {
          loadFsmImpl: (async () => ({
            machine: m,
            sidecar,
            modulePath: `/tmp/fresh-clear-cwd-${scenario.name}.mjs`,
            issues: [],
            cacheHit: false,
            hash: `fresh-clear-cwd-${scenario.name}`,
          })) as unknown as RunCliTestHooks['loadFsmImpl'],
          spawnAppServer: (async () =>
            makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
          connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
          startUiServerImpl: async () => ({
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          }),
        },
      });
      opts.stderr = stderrSink;

      const r = await runCliForTest(opts);
      await driverPromise;

      expect(r.exitCode).toBe(0);
      expect(existsSync(join(repoRoot, '.aharness', 'runs'))).toBe(true);
      expect(existsSync(join(worktreeDir, '.aharness'))).toBe(false);
    }
  });

  it('uses the same fresh clear scheduler after await-resolution transitions', async () => {
    interface Payload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'fresh-clear-await.fsm.ts');
    const m = aharness.machine({
      id: 'fresh-clear-await',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a awaiting owner',
          exits: { ownerReply: { kind: 'await', to: 'b' } },
        }),
        b: state({
          entryPrompt: 'state b active',
          clearOnEntry: true,
          exits: { done: exit<Payload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const validator = {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true as const, data: input }),
    };
    const sidecar = { b: { done: validator } };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    const startupThreadId = 'thread-fresh-clear-await-startup';
    const replacementThreadId = 'thread-fresh-clear-await-replacement';

    const waitForOutbound = async (
      predicate: (envelope: {
        method?: string;
        id?: number;
        params?: unknown;
        result?: unknown;
      }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const initialThreadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      expect((initialThreadStart.params as { cwd?: unknown }).cwd).toBe(repoRoot);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: initialThreadStart.id,
        result: { thread: { id: startupThreadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.rawResponseItemCompleted,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          item: {
            type: 'function_call',
            call_id: 'call-await',
            name: 'request_user_input',
            arguments: JSON.stringify({
              questions: [{ id: 'owner', question: 'answer?', isOther: false, isSecret: false }],
            }),
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.rawResponseItemCompleted,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          item: {
            type: 'function_call_output',
            call_id: 'call-await',
            output: JSON.stringify({ answers: { owner: { answers: ['owner text'] } } }),
          },
        },
      });

      const interrupt = await waitForOutbound((msg) => msg.method === METHOD.turnInterrupt);
      transport.onMessage?.({ jsonrpc: '2.0', id: interrupt.id, result: {} });

      const unsubscribe = await waitForOutbound((msg) => msg.method === METHOD.threadUnsubscribe);
      transport.onMessage?.({ jsonrpc: '2.0', id: unsubscribe.id, result: {} });

      const replacementThreadStart = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.threadStart &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { sessionStartSource?: unknown }).sessionStartSource === 'clear',
      );
      expect((replacementThreadStart.params as { cwd?: unknown }).cwd).toBe(repoRoot);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: replacementThreadStart.id,
        result: { thread: { id: replacementThreadId, ephemeral: false } },
      });

      const replacementTurnStart = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.turnStart &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { threadId?: unknown }).threadId === replacementThreadId,
      );
      transport.onMessage?.({ jsonrpc: '2.0', id: replacementTurnStart.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9920,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: replacementThreadId,
          turnId: 'turn-new',
          callId: 'call-done',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9920 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/fresh-clear-await.mjs',
          issues: [],
          cacheHit: false,
          hash: 'fresh-clear-await',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async () => ({
          url: 'http://127.0.0.1:45678',
          close: vi.fn(async () => undefined),
        }),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
  });

  it('invalid clearOnEntry cwd fails before fresh clear cleanup or replacement startup', async () => {
    interface Payload {
      ok: boolean;
    }

    const missingCwd = join(repoRoot, 'missing-worktree');
    const fsmPath = makeFsmFile(repoRoot, 'fresh-clear-invalid-cwd.fsm.ts');
    const m = aharness.machine({
      id: 'fresh-clear-invalid-cwd',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { go: exit<Payload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          clearOnEntry: { cwd: missingCwd },
          exits: { done: exit<Payload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const validator = {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true as const, data: input }),
    };
    const sidecar = { a: { go: validator }, b: { done: validator } };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    const published: ReplayableAppEvent[] = [];
    let transport!: Transport;
    let activeBinding: ActiveThreadBinding | undefined;
    const startupThreadId = 'thread-fresh-clear-invalid-startup';

    const waitForOutbound = async (
      predicate: (envelope: {
        method?: string;
        id?: number;
        params?: unknown;
        result?: unknown;
      }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const initialThreadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: initialThreadStart.id,
        result: { thread: { id: startupThreadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9910,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          callId: 'call-go',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9910 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/fresh-clear-invalid-cwd.mjs',
          issues: [],
          cacheHit: false,
          hash: 'fresh-clear-invalid-cwd',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async () => ({
          url: 'http://127.0.0.1:45678',
          close: vi.fn(async () => undefined),
        }),
        _testOnActiveThreadBinding: (binding) => {
          activeBinding = binding;
        },
        _testOnUiEvent: (event) => published.push(event),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain(
      `state "b" clearOnEntry.cwd does not exist: ${missingCwd}`,
    );
    expect(activeBinding?.isAbandoned(startupThreadId)).toBe(false);
    expect(
      outbound.some(
        (msg) =>
          msg.method === METHOD.turnInterrupt ||
          msg.method === METHOD.threadUnsubscribe ||
          (msg.method === METHOD.threadStart &&
            typeof msg.params === 'object' &&
            msg.params !== null &&
            (msg.params as { sessionStartSource?: unknown }).sessionStartSource === 'clear'),
      ),
    ).toBe(false);
    expect(published.map((entry) => entry.event)).not.toContainEqual(
      expect.objectContaining({ kind: 'FreshClearBoundary' }),
    );
  });

  it('case 18: user-prompt reply in a closed state returns non-2xx and does not start a turn', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'closed-user-prompt.fsm.ts');
    const m = aharness.machine({
      id: 'closed-user-prompt',
      initial: 'work',
      states: {
        work: state({
          entryPrompt: 'closed work',
          exits: { finish: exit<FinishPayload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      work: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    let capturedReplyHandler: StartUiServerOptions['replyHandler'];
    const threadId = 'thread-closed-user-prompt';

    const waitForOutbound = async (
      predicate: (envelope: { method?: string; id?: number; params?: unknown }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound
          .map((message) => message.method ?? `response:${message.id}`)
          .join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: threadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      if (capturedReplyHandler === undefined) {
        throw new Error('reply handler was not captured');
      }
      const beforeReplyTurnStartCount = outbound.filter(
        (msg) => msg.method === METHOD.turnStart,
      ).length;
      const replyResult = await capturedReplyHandler({
        kind: 'user-prompt',
        text: 'must not start',
      });
      expect(replyResult.status).toBeGreaterThanOrEqual(400);
      expect(replyResult.status).toBeLessThan(600);
      expect(outbound.filter((msg) => msg.method === METHOD.turnStart)).toHaveLength(
        beforeReplyTurnStartCount,
      );

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9400,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-closed-user-prompt',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'work', exit: 'finish', data: { ok: true } }),
        },
      });
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/closed-user-prompt.mjs',
          issues: [],
          cacheHit: false,
          hash: 'closed-user-prompt',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          capturedReplyHandler = options.replyHandler;
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
  });

  it('case 19: launches the browser immediately after the UI server is bound so the user sees the pre-React boot screen while codex spawns', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'browser-launch-order.fsm.ts');
    const stdout = makeWritableBuffer();
    const order: string[] = [];
    const threadId = 'thread-browser-launch-order';
    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;

    const waitForOutbound = async (
      predicate: (envelope: { method?: string; id?: number; params?: unknown }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound.map((m) => m.method).join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      order.push('ws-connect');
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      order.push('thread-start-request');
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: threadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9500,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-browser-launch-order',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'greet', exit: 'finish', data: {} }),
        },
      });
    };

    const driverPromise = driver();
    const launchBrowserImpl = vi.fn((url: string) => {
      order.push(`launch:${url}`);
      return { ok: true as const };
    });
    const sidecar = {
      greet: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          ...makeStubLoadFsmResult(),
          sidecar,
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () => {
          order.push('app-server');
          return makeStubAppServer();
        }) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async () => {
          order.push('ui-server');
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
        launchBrowserImpl,
      },
    });
    opts.stdout = {
      write(chunk: string | Uint8Array): boolean {
        if (String(chunk).includes('browser UI available')) order.push('url-print');
        return stdout.sink.write(chunk);
      },
    } as unknown as NodeJS.WritableStream;
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(stdout.text()).toContain('aharness: browser UI available at http://127.0.0.1:45678');
    expect(launchBrowserImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:45678\/\?token=/),
    );
    expect(order).toEqual([
      'ui-server',
      'url-print',
      expect.stringMatching(/^launch:http:\/\/127\.0\.0\.1:45678\/\?token=/),
      'app-server',
      'ws-connect',
      'thread-start-request',
    ]);
  });

  it('case 20: launcher failure warns but the CLI continues booting', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'browser-launch-failure.fsm.ts');
    const threadId = 'thread-browser-launch-failure';
    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;

    const waitForOutbound = async (
      predicate: (envelope: { method?: string; id?: number; params?: unknown }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (let i = outbound.length - 1; i >= 0; i--) {
          const envelope = outbound[i];
          if (envelope && predicate(envelope)) return envelope;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `timeout waiting for outbound; saw ${outbound.map((m) => m.method).join(', ')}`,
      );
    };

    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          outbound.push(envelope);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
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
    };

    const driver = async (): Promise<void> => {
      const threadStart = await waitForOutbound((msg) => msg.method === METHOD.threadStart);
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: threadStart.id,
        result: { thread: { id: threadId, ephemeral: false } },
      });

      const kickoff = await waitForOutbound((msg) => msg.method === METHOD.turnStart);
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9600,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-browser-launch-failure',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'greet', exit: 'finish', data: {} }),
        },
      });
    };

    const driverPromise = driver();
    const sidecar = {
      greet: {
        finish: {
          jsonSchema: { type: 'object' },
          validate: (input: unknown) => ({ ok: true as const, data: input }),
        },
      },
    };
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          ...makeStubLoadFsmResult(),
          sidecar,
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async () => ({
          url: 'http://127.0.0.1:45678',
          close: vi.fn(async () => undefined),
        }),
        launchBrowserImpl: () => ({
          ok: false,
          reason: 'spawn-failed',
          message: 'no opener',
        }),
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(stderrBuf.join('')).toContain('aharness: failed to launch browser: no opener');
  });
});
