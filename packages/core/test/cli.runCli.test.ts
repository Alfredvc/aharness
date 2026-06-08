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

import { aharness, createFsm, state, exit, terminal, skill } from '../src/index.js';
import { runCliForTest, type RunCliForTestOpts, type RunCliTestHooks } from '../src/cli/runCli.js';
import type { AppServerHandle, SpawnAppServerOptions } from '../src/appServer/index.js';
import { JsonRpcClient, type Transport } from '../src/jsonrpc/client.js';
import { METHOD } from '../src/protocol/methodNames.js';
import { flushHeadlessSnapshotEnvelope } from '../src/runtime/snapshotEnvelope.js';
import {
  RUN_EVENT_SCHEMA,
  type GitFactSyncExec,
  type RunEventAppendInput,
  type RunEventEnvelope,
  type RunEventRecorder,
} from '../src/runEvents/index.js';
import type { ActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import type { ReplayableAppEvent } from '../src/ui/events.js';
import { startUiServer, type StartUiServerOptions, type UiServerHandle } from '../src/ui/server.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';

const AUTO_REVIEW_OVERRIDES = [
  ['approval_policy', '"on-request"'],
  ['approvals_reviewer', '"auto_review"'],
] as const;
const ASK_OVERRIDES = [
  ['approval_policy', '"on-request"'],
  ['approvals_reviewer', '"user"'],
] as const;
const YOLO_OVERRIDES = [
  ['approval_policy', '"never"'],
  ['sandbox_mode', '"danger-full-access"'],
] as const;
const TEST_GIT_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';

const EMPTY_SKILL_ORIGIN_MANIFEST = {
  rootSourceDir: '/tmp',
  sourceDirPrefixes: [],
  availableSkills: [],
} as const;

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

function sameHeadGitFactExec(): GitFactSyncExec {
  return (_file, args) => {
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') return 'true\n';
    if (args.join(' ') === 'rev-parse HEAD') return `${TEST_GIT_HEAD}\n`;
    if (args[0] === 'diff') return '';
    throw new Error(`unexpected git fact command: ${args.join(' ')}`);
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
    skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
    _testGitFactSyncExec: sameHeadGitFactExec(),
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
    let capturedRunId: string | undefined;
    let capturedPosture: Record<string, unknown> | undefined;
    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      const bootstrap = options.runScoped?.service.getBootstrap({
        getRunMeta: options.runScoped.getRunMeta,
        topology: options.runScoped.topology,
      });
      if (bootstrap?.ok) {
        capturedRunId = (bootstrap.bootstrap.run as { runId?: string }).runId;
        capturedPosture = bootstrap.bootstrap.posture as Record<string, unknown>;
      }
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
    expect(capturedRunId).not.toBe(existingRunId);
    expect(capturedPosture).not.toHaveProperty('pendingClear');
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
    expect(outboundMethods.slice(0, 4)).toEqual([
      METHOD.initialize,
      METHOD.skillsExtraRootsSet,
      METHOD.skillsList,
      METHOD.threadStart,
    ]);
  });

  it('fails skill catalog preflight before thread/start for missing required catalog skills', async () => {
    const fsmName = 'skill-preflight-missing.fsm.ts';
    const fsmPath = makeFsmFile(repoRoot, fsmName);
    const machine = aharness.machine({
      id: 'skill-preflight-missing',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'needs skill',
          skills: [skill('required-skill')],
          exits: { done: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const outboundMethods: string[] = [];
    let transport!: Transport;
    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as { id?: number; method?: string; params?: unknown };
          if (envelope.method) outboundMethods.push(envelope.method);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { serverInfo: { name: 'stub', version: '0.0.0' } },
              }),
            );
          } else if (envelope.method === METHOD.skillsExtraRootsSet) {
            queueMicrotask(() =>
              transport.onMessage?.({ jsonrpc: '2.0', id: envelope.id, result: {} }),
            );
          } else if (envelope.method === METHOD.skillsList) {
            const params = envelope.params as { cwds?: readonly string[] };
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { data: [{ cwd: params.cwds?.[0] ?? repoRoot, skills: [], errors: [] }] },
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
        loadFsmImpl: (async () => ({
          machine,
          sidecar: {},
          modulePath: '/tmp/skill-preflight-missing.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'skill-preflight-missing',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('aharness: skill preflight failed');
    expect(stderrBuf.join('')).toContain("name 'required-skill' is missing");
    expect(outboundMethods).toEqual([
      METHOD.initialize,
      METHOD.skillsExtraRootsSet,
      METHOD.skillsList,
    ]);
  });

  it('injects catalog name and path state skills as structured kickoff turn input', async () => {
    const fsmName = 'skill-structured-kickoff.fsm.ts';
    const fsmPath = makeFsmFile(repoRoot, fsmName);
    const pathSkill = join(repoRoot, 'skills', 'path-skill', 'SKILL.md');
    const machine = aharness.machine({
      id: 'skill-structured-kickoff',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'needs skills',
          skills: [skill('catalog-skill'), skill({ path: './skills/path-skill/SKILL.md' })],
          exits: { done: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const outboundMethods: string[] = [];
    let turnStartInput: unknown;
    let transport!: Transport;
    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as { id?: number; method?: string; params?: unknown };
          if (envelope.method) outboundMethods.push(envelope.method);
          if (envelope.method === METHOD.initialize) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { serverInfo: { name: 'stub', version: '0.0.0' } },
              }),
            );
          } else if (envelope.method === METHOD.skillsExtraRootsSet) {
            queueMicrotask(() =>
              transport.onMessage?.({ jsonrpc: '2.0', id: envelope.id, result: {} }),
            );
          } else if (envelope.method === METHOD.skillsList) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: {
                  data: [
                    {
                      cwd: repoRoot,
                      errors: [],
                      skills: [
                        {
                          name: 'catalog-skill',
                          path: '/codex/skills/catalog-skill/SKILL.md',
                          enabled: true,
                        },
                        { name: 'path-skill', path: pathSkill, enabled: true },
                      ],
                    },
                  ],
                },
              }),
            );
          } else if (envelope.method === METHOD.threadStart) {
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                result: { thread: { id: 'thread-1', ephemeral: false } },
              }),
            );
          } else if (envelope.method === METHOD.turnStart) {
            turnStartInput = (envelope.params as { input?: unknown }).input;
            queueMicrotask(() =>
              transport.onMessage?.({
                jsonrpc: '2.0',
                id: envelope.id,
                error: { code: -32000, message: 'stop after kickoff turn input captured' },
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
        loadFsmImpl: (async () => ({
          machine,
          sidecar: {},
          modulePath: '/tmp/skill-structured-kickoff.mjs',
          issues: [],
          skillOriginManifest: {
            rootSourceDir: repoRoot,
            sourceDirPrefixes: [],
            availableSkills: [],
          },
          cacheHit: false,
          hash: 'skill-structured-kickoff',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
      },
    });

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(outboundMethods.slice(0, 5)).toEqual([
      METHOD.initialize,
      METHOD.skillsExtraRootsSet,
      METHOD.skillsList,
      METHOD.threadStart,
      METHOD.turnStart,
    ]);
    expect(turnStartInput).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('[aharness] Now in state "a".'),
      }),
      { type: 'skill', name: 'catalog-skill', path: '/codex/skills/catalog-skill/SKILL.md' },
      { type: 'skill', name: 'path-skill', path: pathSkill },
    ]);
    const text = (turnStartInput as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).not.toContain('<skill');
    expect(text).not.toContain('"type":"skill"');
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
        METHOD.threadTokenUsageUpdated,
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
    expect(err).toContain('Example: aharness run pipeline.fsm.ts --topic <string>');
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it('passes CLI-coerced input flag values and defaults into ActorHost', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'coerced-input.fsm.ts');
    let capturedInput: Record<string, unknown> | undefined;
    const machine = aharness.machine({
      context: ({ input }: { input: Record<string, unknown> }) => {
        capturedInput = input;
        return {};
      },
      initial: 'greet',
      states: {
        greet: state({
          entryPrompt: 'stub',
          exits: { finish: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:45678',
      close: vi.fn(async () => undefined),
    }));
    const spawnAppServer = vi.fn(async () => {
      throw new Error('test-abort-after-input-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          ...makeStubLoadFsmResult(),
          machine,
          inputSchema: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
              runs: { type: 'number' },
              flag: { type: 'boolean' },
              mode: { type: 'string' },
            },
            required: ['topic'],
            additionalProperties: false,
          },
          inputFlags: {
            topic: { description: 'Project topic' },
            runs: { default: 3 },
            flag: { default: false },
            mode: { default: 'standard' },
          },
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        startUiServerImpl: startUiServerImpl as unknown as RunCliTestHooks['startUiServerImpl'],
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;
    opts.inputArgs = ['--topic', 'auth', '--runs', '5', '--flag'];

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(capturedInput).toEqual(
      expect.objectContaining({
        topic: 'auth',
        runs: 5,
        flag: true,
        mode: 'standard',
      }),
    );
    expect(capturedInput?.runId).toEqual(expect.any(String));
    expect(capturedInput?.runDir).toEqual(expect.objectContaining({ root: expect.any(String) }));
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
  });

  it('passes auto-review approval overrides for a default zero-hook run', async () => {
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
    expect(capturedOverrides).toEqual(AUTO_REVIEW_OVERRIDES);
  });

  it('passes ask approval overrides for an ask-mode zero-hook run', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ask.fsm.ts');
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
    opts.permissionMode = 'ask';

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual(ASK_OVERRIDES);
  });

  it('passes auto-review approval overrides before mock-model provider overrides', async () => {
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
      ...AUTO_REVIEW_OVERRIDES,
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
    opts.permissionMode = 'yolo';

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(capturedOverrides).toEqual(YOLO_OVERRIDES);
    expect(capturedOverrides?.some(([key]) => key === 'approvals_reviewer')).toBe(false);
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
    opts.permissionMode = 'yolo';
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
      ...AUTO_REVIEW_OVERRIDES,
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
    expect(capturedOverrides).toEqual(AUTO_REVIEW_OVERRIDES);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
      ...AUTO_REVIEW_OVERRIDES,
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
    let capturedBootstrap:
      | {
          run: { runId: string; repoRoot: string; fsmFile: string };
          currentState: unknown;
          topology: unknown;
          posture: Record<string, unknown>;
          latestEventId: string | null;
        }
      | undefined;

    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      order.push('ui-server');
      const bootstrap = options.runScoped?.service.getBootstrap({
        getRunMeta: options.runScoped.getRunMeta,
        topology: options.runScoped.topology,
      });
      expect(bootstrap?.ok).toBe(true);
      if (bootstrap?.ok) {
        capturedBootstrap = bootstrap.bootstrap as typeof capturedBootstrap;
      }
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
    expect(capturedBootstrap?.run).toMatchObject({
      runId: expect.stringMatching(/^[0-9a-f]{6}-[0-9a-f]{6}$/),
      repoRoot,
      fsmFile: fsmPath,
    });
    expect(capturedBootstrap?.currentState).toMatchObject({
      path: 'greet',
      leaf: 'greet',
      kind: 'stateful',
    });
    expect(capturedBootstrap?.topology).toMatchObject({
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
    expect(capturedBootstrap?.posture).toMatchObject({
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    });
    expect(capturedBootstrap?.latestEventId).toBe(`${capturedBootstrap?.run.runId}:4`);
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

  it('wires run-scoped JSONL endpoints to live canonical runtime events and topology', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'run-scoped-live.fsm.ts');
    const m = aharness.machine({
      id: 'runScopedLive',
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
    let transport!: Transport;
    let uiHandle: UiServerHandle | undefined;
    let uiUrl: string | undefined;
    let uiToken: string | undefined;
    let runId: string | undefined;

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

    const readRunScopedJson = async (path: string): Promise<unknown> => {
      if (uiUrl === undefined || uiToken === undefined || runId === undefined) {
        throw new Error('UI server was not captured');
      }
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetch(`${uiUrl}/api/runs/${runId}${path}${separator}token=${uiToken}`);
      expect(response.status).toBe(200);
      return response.json();
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
      const threadId = 'thread-run-scoped-live';
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
        id: 9100,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId,
          turnId: 'turn-owner',
          itemId: 'owner-live-1',
          questions: [
            {
              id: 'owner',
              header: 'Owner',
              question: 'What next?',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      });

      await vi.waitFor(async () => {
        const bootstrap = (await readRunScopedJson('/bootstrap')) as {
          run: { threadId?: string };
          topology: unknown;
          latestEventId: string;
          currentStateVisit: { id: string; path: string } | null;
          recentRows: ReadonlyArray<{ eventId: string; kind: string }>;
          pending: ReadonlyArray<{ requestId: string; status: string }>;
          aggregateStats: { turnCount: number };
        };
        expect(bootstrap.run.threadId).toBe(threadId);
        expect(bootstrap.topology).toEqual(
          expect.objectContaining({
            machineId: 'runScopedLive',
            initial: 'greet',
            nodes: expect.arrayContaining([
              expect.objectContaining({ id: 'greet', kind: 'stateful' }),
              expect.objectContaining({ id: 'done', kind: 'terminal' }),
            ]),
          }),
        );
        expect(bootstrap.latestEventId).toMatch(new RegExp(`^${runId}:\\d+$`));
        expect(bootstrap.currentStateVisit).toEqual(
          expect.objectContaining({ id: 'greet#1', path: 'greet' }),
        );
        expect(bootstrap.recentRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'state_change' }),
            expect.objectContaining({ kind: 'request' }),
          ]),
        );
        expect(bootstrap.pending).toEqual([
          expect.objectContaining({ requestId: 'owner-live-1', status: 'pending' }),
        ]);
        expect(bootstrap.aggregateStats).toEqual(expect.objectContaining({ turnCount: 0 }));
      });

      const events = (await readRunScopedJson(`/events?after=${runId}:1&limit=10`)) as {
        events: ReadonlyArray<{ id: string; type: string; requestId?: string }>;
        nextCursor: string | null;
      };
      expect(events.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `${runId}:3`, type: 'state.changed' }),
          expect.objectContaining({
            type: 'request.created',
            requestId: 'owner-live-1',
          }),
        ]),
      );
      expect(events.events.slice(0, 2)).toEqual([
        expect.objectContaining({ id: `${runId}:2`, type: 'git.snapshot.recorded' }),
        expect.objectContaining({ id: `${runId}:3`, type: 'state.changed' }),
      ]);

      if (uiUrl === undefined || uiToken === undefined || runId === undefined) {
        throw new Error('UI server was not captured');
      }
      const replyResponse = await fetch(`${uiUrl}/api/runs/${runId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': uiToken },
        body: JSON.stringify({
          kind: 'owner-input',
          requestId: 'owner-live-1',
          answers: { owner: 'continue' },
        }),
      });
      expect(replyResponse.status).toBe(200);
      await waitForOutbound((msg) => msg.id === 9100 && msg.result !== undefined);

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9200,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-finish',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'greet', exit: 'finish', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9200 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/run-scoped-live.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'run-scoped-live',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          expect(options.runScoped).toBeDefined();
          expect(options.eventLog).toBeUndefined();
          expect(options.runScoped?.topology).toEqual(
            expect.objectContaining({ machineId: 'runScopedLive' }),
          );
          runId = options.runScoped?.activeRunId;
          uiToken = options.uiToken;
          uiHandle = await startUiServer(options);
          uiUrl = uiHandle.url;
          return uiHandle;
        },
      },
    });
    opts.stderr = stderrSink;

    try {
      const r = await runCliForTest(opts);
      await driverPromise;
      expect(r.exitCode, `stderr: ${stderrBuf.join('')}`).toBe(0);
    } finally {
      await uiHandle?.close().catch(() => undefined);
    }
  }, 10_000);

  it('keeps the browser useful when canonical runtime append fails', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'ui-append-warning.fsm.ts');
    const published: ReplayableAppEvent[] = [];
    let capturedRunScoped: StartUiServerOptions['runScoped'];
    const spawnAppServer = vi.fn(async () => {
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        _testRunEventRecorder: failingRunEventRecorder(),
        _testOnUiEvent: (event) => published.push(event),
        startUiServerImpl: async (options) => {
          capturedRunScoped = options.runScoped;
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
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
    expect(capturedRunScoped?.service.getEventPage()).toEqual({
      ok: true,
      events: [],
      nextCursor: null,
      diagnostics: [],
    });
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
      'git.snapshot.recorded',
      'state.changed',
      'context.initialized',
      'git.snapshot.recorded',
      'git.diff.recorded',
      'run.failed',
    ]);
    expect(eventEntries[1]).toEqual(
      expect.objectContaining({
        type: 'git.snapshot.recorded',
        data: { phase: 'start', status: 'available', head: TEST_GIT_HEAD },
      }),
    );
    expect(eventEntries[3]).toEqual(
      expect.objectContaining({
        type: 'context.initialized',
        data: { context: {} },
      }),
    );
    expect(eventEntries[4]).toEqual(
      expect.objectContaining({
        type: 'git.snapshot.recorded',
        data: { phase: 'terminal', status: 'available', head: TEST_GIT_HEAD },
      }),
    );
    expect(eventEntries[5]).toEqual(
      expect.objectContaining({
        type: 'git.diff.recorded',
        data: {
          status: 'available',
          from: TEST_GIT_HEAD,
          to: TEST_GIT_HEAD,
          filesChanged: 0,
          linesAdded: 0,
          linesDeleted: 0,
        },
      }),
    );
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

  it('records normalized unavailable git facts without blocking terminal failure publication', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'git-unavailable-terminal-fail.fsm.ts');
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
        _testGitFactSyncExec: () => 'false\n',
        startUiServerImpl,
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    expect(eventEntries.map((entry) => entry.type)).toEqual([
      'run.started',
      'git.snapshot.recorded',
      'state.changed',
      'context.initialized',
      'git.snapshot.recorded',
      'git.diff.recorded',
      'run.failed',
    ]);
    expect(
      eventEntries
        .filter((entry) => entry.type === 'git.snapshot.recorded')
        .map((entry) => entry.data),
    ).toEqual([
      { phase: 'start', status: 'unavailable', reason: 'not-a-git-repository' },
      { phase: 'terminal', status: 'unavailable', reason: 'not-a-git-repository' },
    ]);
    expect(eventEntries.find((entry) => entry.type === 'git.diff.recorded')?.data).toEqual({
      status: 'unavailable',
      reason: 'object-unavailable',
    });
    expect(eventEntries.at(-1)?.type).toBe('run.failed');
  });

  it('records the stripped public boot context after the initial state change', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'boot-public-context.fsm.ts');
    const m = aharness.machine({
      id: 'bootPublicContext',
      initial: 'greet',
      context: () => ({
        publicValue: 'boot',
        __aharness_hidden: 'secret',
        aharness: { hidden: true },
      }),
      states: {
        greet: state({
          entryPrompt: 'stub',
          exits: { finish: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const spawnAppServer = vi.fn(async () => {
      throw new Error('test-abort-after-spawn-args-captured');
    });
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar: {},
          modulePath: '/tmp/boot-public-context.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'boot-public-context',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: spawnAppServer as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    expect(eventEntries.map((entry) => entry.type).slice(0, 4)).toEqual([
      'run.started',
      'git.snapshot.recorded',
      'state.changed',
      'context.initialized',
    ]);
    expect(eventEntries[3]?.data).toEqual({ context: { publicValue: 'boot' } });
    expect(JSON.stringify(eventEntries[3])).not.toContain('__aharness_hidden');
    expect(JSON.stringify(eventEntries[3])).not.toContain('"aharness"');
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
          const envelope = msg as { id?: number; method?: string; params?: unknown };
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
        'git.snapshot.recorded',
        'state.changed',
        'request.created',
        'reply.submitted',
        'request.resolved',
        'reply.resolved',
        'git.diff.recorded',
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
        raw: {
          params: expect.objectContaining({
            itemId: 'item-owner-1',
            questions: [
              expect.objectContaining({
                question: 'What should happen next?',
                isSecret: false,
              }),
            ],
          }),
        },
      }),
    );
    expect(
      eventEntries.find(
        (entry) => entry.type === 'reply.submitted' && entry.requestId === 'item-owner-1',
      ),
    ).toEqual(
      expect.objectContaining({
        raw: {
          payload: {
            kind: 'owner-input',
            requestId: 'item-owner-1',
            answers: { owner: 'alice' },
          },
        },
      }),
    );
    const submittedSeq = eventEntries.find((entry) => entry.type === 'reply.submitted')?.seq ?? 0;
    const requestResolvedSeq =
      eventEntries.find((entry) => entry.type === 'request.resolved')?.seq ?? 0;
    const resolvedSeq = eventEntries.find((entry) => entry.type === 'reply.resolved')?.seq ?? 0;
    expect(submittedSeq).toBeGreaterThan(0);
    expect(requestResolvedSeq).toBeGreaterThan(submittedSeq);
    expect(resolvedSeq).toBeGreaterThan(requestResolvedSeq);
    const runStartedSeq = eventEntries.find((entry) => entry.type === 'run.started')?.seq ?? 0;
    const startSnapshotSeq =
      eventEntries.find(
        (entry) =>
          entry.type === 'git.snapshot.recorded' &&
          entry.data?.phase === 'start' &&
          entry.data.status === 'available',
      )?.seq ?? 0;
    const terminalSnapshotSeq =
      eventEntries.find(
        (entry) =>
          entry.type === 'git.snapshot.recorded' &&
          entry.data?.phase === 'terminal' &&
          entry.data.status === 'available',
      )?.seq ?? 0;
    const diffSeq = eventEntries.find((entry) => entry.type === 'git.diff.recorded')?.seq ?? 0;
    const completedSeq = eventEntries.find((entry) => entry.type === 'run.completed')?.seq ?? 0;
    expect(startSnapshotSeq).toBeGreaterThan(runStartedSeq);
    expect(terminalSnapshotSeq).toBeGreaterThan(startSnapshotSeq);
    expect(diffSeq).toBeGreaterThan(terminalSnapshotSeq);
    expect(completedSeq).toBeGreaterThan(diffSeq);
    expect(eventEntries.find((entry) => entry.type === 'git.diff.recorded')).toEqual(
      expect.objectContaining({
        data: {
          status: 'available',
          from: TEST_GIT_HEAD,
          to: TEST_GIT_HEAD,
          filesChanged: 0,
          linesAdded: 0,
          linesDeleted: 0,
        },
      }),
    );
    const gitFactJson = JSON.stringify(
      eventEntries.filter(
        (entry) => entry.type === 'git.snapshot.recorded' || entry.type === 'git.diff.recorded',
      ),
    );
    expect(gitFactJson).not.toContain(repoRoot);
    expect(gitFactJson).not.toContain(fsmPath);
    expect(gitFactJson).not.toContain('feature/branch');
    expect(gitFactJson).not.toContain('git@github.com');
    expect(gitFactJson).not.toContain('secret-file.ts');
    expect(gitFactJson).not.toContain('stderr');
    expect(gitFactJson).not.toContain('git diff');
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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

  it('records compact rows plus raw dynamic tool, token, parent item, and sub-thread payloads in canonical JSONL', async () => {
    interface FinishPayload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'raw-runtime-events.fsm.ts');
    const m = aharness.machine({
      id: 'raw-runtime-events',
      initial: 'greet',
      states: {
        greet: state({
          entryPrompt: 'hello',
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
    let transport!: Transport;
    const threadId = 'thread-raw-runtime';

    const waitForOutbound = async (
      predicate: (envelope: {
        method?: string;
        id?: number;
        params?: unknown;
        result?: unknown;
      }) => boolean,
      timeoutMs = 2_000,
    ): Promise<{ id?: number; method?: string; params?: unknown; result?: unknown }> => {
      const describeOutbound = () =>
        outbound
          .map(
            (message) => `${message.id ?? '<no-id>'}:${message.method ?? `response:${message.id}`}`,
          )
          .join(', ');
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
        method: METHOD.threadTokenUsageUpdated,
        params: {
          threadId,
          turnId: 'turn-raw',
          tokenUsage: {
            total: {
              totalTokens: 100,
              inputTokens: 70,
              cachedInputTokens: 40,
              outputTokens: 20,
              reasoningOutputTokens: 10,
            },
            last: { inputTokens: 70, cachedInputTokens: 40 },
            modelContextWindow: 128000,
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.threadStarted,
        params: {
          thread: {
            id: 'child-thread',
            ephemeral: false,
            agentNickname: 'Researcher',
            agentRole: 'review',
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemStarted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'spawnAgentToolCall',
            id: 'spawn-1',
            receiverThreadIds: ['child-thread'],
            arguments: { prompt: 'inspect this' },
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemStarted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'commandExecution',
            id: 'cmd-compact',
            command: 'pnpm test',
            cwd: '/sentinel/cwd-must-stay-out',
            commandActions: [{ label: 'command-action-must-stay-out' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'commandExecution',
            id: 'cmd-compact',
            command: 'pnpm test',
            aggregatedOutput: 'test output\nall green',
            durationMs: 1234,
            request: { payload: 'hidden-request-payload-must-stay-out' },
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemStarted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-pending',
            status: 'inProgress',
            changes: [
              {
                path: 'src/old.ts',
                kind: { type: 'update', move_path: 'src/new.ts' },
                diff: '@@\n-old line\n+new line\n+++ b/src/new.ts\n--- a/src/old.ts\n+second line\n',
              },
            ],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-failed',
            status: 'failed',
            changes: [{ path: 'src/failed.ts', kind: { type: 'update' }, diff: '-failed\n' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-completed',
            status: 'completed',
            changes: [
              {
                path: 'src/add.ts',
                kind: { type: 'add' },
                diff: 'added first\n\n',
              },
              {
                path: 'src/delete.ts',
                kind: { type: 'delete' },
                diff: 'removed first\r\nremoved second',
              },
              { path: 123, kind: { type: 'add' }, diff: 'malformed-change-must-stay-out' },
            ],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-in-progress',
            status: 'inProgress',
            changes: [{ path: 'src/pending.ts', kind: { type: 'update' }, diff: '+pending\n' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-declined',
            status: 'declined',
            changes: [{ path: 'src/declined.ts', kind: { type: 'delete' }, diff: 'removed\n' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-unknown-ok',
            status: 'mystery',
            changes: 'malformed-changes-must-stay-out',
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'fileChange',
            id: 'file-change-unknown-failed',
            status: 'mystery',
            error: 'file change error',
            changes: [{ path: 'src/error.ts', kind: { type: 'add' }, diff: 'error diff\n' }],
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemStarted,
        params: {
          threadId: 'child-thread',
          turnId: 'child-turn',
          item: { type: 'agentMessage', id: 'child-message', text: 'child output' },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.threadTokenUsageUpdated,
        params: {
          threadId: 'child-thread',
          turnId: 'child-turn',
          tokenUsage: {
            total: { totalTokens: 999, inputTokens: 900 },
            last: { inputTokens: 900, cachedInputTokens: 100 },
            modelContextWindow: 200000,
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.rawResponseItemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'function_call',
            call_id: 'raw-shell-call',
            name: 'shell',
            arguments: 'raw shell arguments must stay out',
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.rawResponseItemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'function_call_output',
            call_id: 'raw-shell-call',
            output: 'raw shell output',
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9299,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-raw',
          callId: 'call-bad-submit',
          tool: 'aharness_submit',
          arguments: { state: 'greet', exit: 'missing', data: { secret: 'do not show' } },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9298,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-raw',
          callId: 'call-malformed-submit',
          tool: 'aharness_submit',
          arguments: '{"state":"greet","exit":"finish","data":"parser sentinel must stay out"',
        },
      });
      const badSubmitReply = await waitForOutbound(
        (msg) => msg.id === 9299 && msg.result !== undefined,
      );
      await waitForOutbound((msg) => msg.id === 9298 && msg.result !== undefined);
      expect(JSON.stringify(badSubmitReply.result)).not.toContain('publicFailure');
      expect(JSON.stringify(badSubmitReply.result)).not.toContain('do not show');
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId,
          turnId: 'turn-raw',
          item: {
            type: 'dynamicToolCall',
            id: 'call-bad-submit',
            status: 'completed',
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9300,
        method: METHOD.toolDynamicCall,
        params: {
          threadId,
          turnId: 'turn-raw',
          callId: 'call-finish',
          tool: 'aharness_submit',
          arguments: { state: 'greet', exit: 'finish', data: { ok: true } },
        },
      });
      await waitForOutbound((msg) => msg.id === 9300 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/raw-runtime-events.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'raw-runtime-events',
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
    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    expect(eventEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'token.updated',
          data: expect.objectContaining({
            total: expect.objectContaining({ totalTokens: 100, cachedInputTokens: 40 }),
            modelContextWindow: 128000,
          }),
          raw: {
            params: expect.objectContaining({
              tokenUsage: expect.objectContaining({
                last: { inputTokens: 70, cachedInputTokens: 40 },
              }),
            }),
          },
        }),
        expect.objectContaining({
          type: 'item.started',
          itemId: 'spawn-1',
          data: expect.objectContaining({
            receiverThreadIds: ['child-thread'],
            toolName: 'spawn_agent',
            row: expect.objectContaining({
              data: expect.objectContaining({
                displayKind: 'subagent',
                subagentAction: 'spawn',
                agentNickname: 'Researcher',
                agentRole: 'review',
                receiverThreadIds: ['child-thread'],
              }),
            }),
          }),
          raw: {
            params: expect.objectContaining({
              item: expect.objectContaining({ arguments: { prompt: 'inspect this' } }),
            }),
          },
        }),
        expect.objectContaining({
          type: 'item.started',
          itemId: 'cmd-compact',
          data: expect.objectContaining({
            itemType: 'commandExecution',
            toolName: 'bash',
            row: expect.objectContaining({
              kind: 'tool',
              label: 'bash',
              status: 'pending',
              data: {
                displayKind: 'command',
                command: 'pnpm test',
              },
            }),
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'cmd-compact',
          data: expect.objectContaining({
            itemType: 'commandExecution',
            toolName: 'bash',
            row: expect.objectContaining({
              kind: 'tool',
              label: 'bash',
              status: 'completed',
              output: 'test output\nall green',
              elapsedMs: 1234,
              data: {
                displayKind: 'command',
                command: 'pnpm test',
              },
            }),
          }),
        }),
        expect.objectContaining({
          type: 'item.started',
          itemId: 'file-change-pending',
          data: expect.objectContaining({
            itemType: 'fileChange',
            row: {
              kind: 'fileChange',
              label: 'file change',
              status: 'pending',
              summary: 'Edited src/old.ts (+2 -1)',
              data: {
                changeCount: 1,
                added: 2,
                removed: 1,
                files: [
                  {
                    path: 'src/old.ts',
                    kind: 'update',
                    movePath: 'src/new.ts',
                    added: 2,
                    removed: 1,
                  },
                ],
              },
            },
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'file-change-completed',
          data: expect.objectContaining({
            itemType: 'fileChange',
            row: {
              kind: 'fileChange',
              label: 'file change',
              status: 'completed',
              summary: 'Edited 2 files (+2 -2)',
              data: {
                changeCount: 2,
                added: 2,
                removed: 2,
                files: [
                  { path: 'src/add.ts', kind: 'add', added: 2, removed: 0 },
                  { path: 'src/delete.ts', kind: 'delete', added: 0, removed: 2 },
                ],
              },
            },
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'file-change-in-progress',
          data: expect.objectContaining({
            row: expect.objectContaining({ kind: 'fileChange', status: 'pending' }),
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'file-change-declined',
          data: expect.objectContaining({
            row: expect.objectContaining({ kind: 'fileChange', status: 'declined' }),
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'file-change-failed',
          data: expect.objectContaining({
            row: expect.objectContaining({ kind: 'fileChange', status: 'failed' }),
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'file-change-unknown-ok',
          data: expect.objectContaining({
            row: expect.objectContaining({
              kind: 'fileChange',
              status: 'completed',
              summary: 'File change',
              data: { changeCount: 0, added: 0, removed: 0, files: [] },
            }),
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'file-change-unknown-failed',
          data: expect.objectContaining({
            row: expect.objectContaining({ kind: 'fileChange', status: 'failed' }),
          }),
        }),
        expect.objectContaining({
          type: 'subthread.item.started',
          threadId: 'child-thread',
          itemId: 'child-message',
          data: expect.objectContaining({
            parentThreadId: threadId,
            parentItemId: 'spawn-1',
            correlationKnown: true,
          }),
          raw: {
            params: expect.objectContaining({
              item: expect.objectContaining({ text: 'child output' }),
            }),
          },
        }),
        expect.objectContaining({
          type: 'subthread.token.updated',
          threadId: 'child-thread',
          turnId: 'child-turn',
          data: expect.objectContaining({
            total: expect.objectContaining({ totalTokens: 999 }),
            modelContextWindow: 200000,
            parentThreadId: threadId,
            parentItemId: 'spawn-1',
            correlationKnown: true,
          }),
          raw: {
            params: expect.objectContaining({
              tokenUsage: expect.objectContaining({
                last: { inputTokens: 900, cachedInputTokens: 100 },
              }),
            }),
          },
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'raw-shell-call',
          data: expect.objectContaining({
            itemType: 'function_call_output',
            toolName: 'shell',
            row: expect.objectContaining({
              kind: 'tool',
              label: 'shell',
              output: 'raw shell output',
              ok: true,
              resultId: 'raw-shell-call:output',
              data: { displayKind: 'command' },
            }),
          }),
        }),
        expect.objectContaining({
          type: 'item.started',
          itemId: 'call-finish',
          data: expect.objectContaining({
            itemType: 'dynamicToolCall',
            toolName: 'aharness_submit',
            internal: true,
          }),
          raw: {
            params: expect.objectContaining({
              arguments: { state: 'greet', exit: 'finish', data: { ok: true } },
            }),
          },
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'call-bad-submit',
          data: expect.objectContaining({
            itemType: 'dynamicToolCall',
            toolName: 'aharness_submit',
            internal: true,
            row: expect.objectContaining({
              kind: 'transition_failure',
              summary: expect.stringContaining('Off-exit submit'),
              data: expect.objectContaining({
                toolName: 'aharness_submit',
                state: 'greet',
                exit: 'missing',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          itemId: 'call-malformed-submit',
          data: expect.objectContaining({
            row: expect.objectContaining({
              kind: 'transition_failure',
              summary: 'Transition failed',
            }),
          }),
        }),
      ]),
    );
    const compactRows = eventEntries.map((entry) => entry.data?.row).filter(Boolean);
    expect(JSON.stringify(compactRows)).not.toContain('do not show');
    expect(JSON.stringify(compactRows)).not.toContain('parser sentinel must stay out');
    expect(JSON.stringify(compactRows)).not.toContain('/sentinel/cwd-must-stay-out');
    expect(JSON.stringify(compactRows)).not.toContain('command-action-must-stay-out');
    expect(JSON.stringify(compactRows)).not.toContain('hidden-request-payload-must-stay-out');
    expect(JSON.stringify(compactRows)).not.toContain('raw shell arguments must stay out');
    expect(JSON.stringify(compactRows)).not.toContain('old line');
    expect(JSON.stringify(compactRows)).not.toContain('new line');
    expect(JSON.stringify(compactRows)).not.toContain('added first');
    expect(JSON.stringify(compactRows)).not.toContain('removed first');
    expect(JSON.stringify(compactRows)).not.toContain('malformed-change-must-stay-out');
    expect(JSON.stringify(compactRows)).not.toContain('malformed-changes-must-stay-out');
    expect(JSON.stringify(compactRows)).not.toContain('error diff');
    expect(JSON.stringify(compactRows)).not.toContain('diff');
    expect(JSON.stringify(compactRows)).not.toContain('changes');
    expect(JSON.stringify(compactRows)).not.toContain('patch');
    expect(JSON.stringify(compactRows)).not.toContain('unified_diff');
    expect(compactRows.map((row) => row.kind)).not.toContain('dynamicToolCall');
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
    let readBootstrap: (() => unknown) | undefined;
    let activeBinding: ActiveThreadBinding | undefined;
    let readPendingOwnerInputRequestCount: (() => number) | undefined;
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
      await vi.waitFor(() => expect(readPendingOwnerInputRequestCount?.()).toBe(1));

      activeBinding.set(replacementThreadId);
      const abandonedOwnerReply = await waitForOutbound(
        (msg) => msg.id === 9400 && msg.result !== undefined,
      );
      expect(abandonedOwnerReply.result).toEqual({
        answers: { owner: { answers: ['(declined)'] } },
      });
      await vi.waitFor(() => expect(readPendingOwnerInputRequestCount?.()).toBe(0));
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
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 9401,
        method: METHOD.toolRequestUserInput,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-owner-ignored',
          itemId: 'owner-ignored-1',
          questions: [
            {
              id: 'owner',
              header: 'Owner',
              question: 'This abandoned request should not be persisted as pending.',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      });
      const inactiveOwnerReply = await waitForOutbound(
        (msg) => msg.id === 9401 && msg.result !== undefined,
      );
      expect(inactiveOwnerReply.result).toEqual({
        answers: { owner: { answers: ['(declined)'] } },
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'active-binding-routing',
        })) as unknown as RunCliTestHooks['loadFsmImpl'],
        spawnAppServer: (async () =>
          makeStubAppServer()) as unknown as RunCliTestHooks['spawnAppServer'],
        connectHeadlessWsImpl: connectStub as unknown as RunCliTestHooks['connectHeadlessWsImpl'],
        startUiServerImpl: async (options) => {
          capturedReplyHandler = options.replyHandler;
          readBootstrap = () =>
            options.runScoped?.service.getBootstrap({
              getRunMeta: options.runScoped.getRunMeta,
              topology: {},
            });
          return {
            url: 'http://127.0.0.1:45678',
            close: vi.fn(async () => undefined),
          };
        },
        _testOnActiveThreadBinding: (binding) => {
          activeBinding = binding;
        },
        _testReadPendingOwnerInputRequestCount: (read) => {
          readPendingOwnerInputRequestCount = read;
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
    expect(stdout.text()).not.toContain('new delta');
    expect(published.map((entry) => entry.event)).toContainEqual({
      kind: 'AgentMessageDelta',
      id: 'new-delta',
      delta: 'new delta',
    });
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
            itemId?: string;
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
    expect(
      eventEntries.some(
        (entry) => entry.type === 'request.created' && entry.itemId === 'owner-ignored-1',
      ),
    ).toBe(false);
    expect(eventEntries.every((entry) => !('kind' in entry) && !('ts' in entry))).toBe(true);
    expect(existsSync(join(repoRoot, '.aharness', 'runs', runId, 'snapshot.json'))).toBe(false);
    expect(readBootstrap?.()).toEqual(
      expect.objectContaining({
        ok: true,
        bootstrap: expect.objectContaining({
          run: expect.objectContaining({ threadId: replacementThreadId }),
          recentRows: expect.arrayContaining([
            expect.objectContaining({
              kind: 'diagnostic',
              text: expect.stringContaining(
                'turnCompleted notification ignored for abandoned thread',
              ),
            }),
          ]),
        }),
      }),
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
          model: { name: 'gpt-5.1-codex', effort: 'high' },
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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

      const preflightModelList = await waitForOutbound((msg) => msg.method === METHOD.modelList);
      expect(preflightModelList.params).toEqual({ includeHidden: true });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: preflightModelList.id,
        result: {
          data: [
            {
              model: 'gpt-5.1-codex',
              supportedReasoningEfforts: [
                { reasoningEffort: 'high', description: 'High' },
                { reasoningEffort: 'medium', description: 'Medium' },
              ],
              defaultReasoningEffort: 'medium',
              isDefault: true,
            },
          ],
          nextCursor: null,
        },
      });

      const interrupt = await waitForOutbound((msg) => msg.method === METHOD.turnInterrupt);
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          item: { type: 'dynamicToolCall', id: 'call-go' },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.threadTokenUsageUpdated,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old-drain',
          tokenUsage: {
            total: { totalTokens: 42, inputTokens: 40, outputTokens: 2 },
            last: { inputTokens: 40, outputTokens: 2 },
            modelContextWindow: 128000,
          },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.turnCompleted,
        params: {
          threadId: startupThreadId,
          turn: { id: 'turn-old-drain', status: 'completed' },
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.fileChangePatchUpdated,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old-drain',
          itemId: 'patch-old-drain',
          changes: [],
        },
      });
      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.serverRequestResolved,
        params: {
          threadId: startupThreadId,
          requestId: 'request-old-drain',
        },
      });
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
      expect(replacementThreadStart.params).toEqual(
        expect.objectContaining({
          cwd: repoRoot,
          model: 'gpt-5.1-codex',
          config: { model_reasoning_effort: 'high' },
          sessionStartSource: 'clear',
        }),
      );
      expect(outbound.some((msg) => msg.method === METHOD.threadSettingsUpdate)).toBe(false);
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
      expect(replacementTurnStart.params).toEqual({
        threadId: replacementThreadId,
        input: expect.any(Array),
      });
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
        method: METHOD.threadTokenUsageUpdated,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old-late',
          tokenUsage: {
            total: { totalTokens: 99, inputTokens: 90, outputTokens: 9 },
            last: { inputTokens: 90, outputTokens: 9 },
            modelContextWindow: 128000,
          },
        },
      });

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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    const freshClearBoundary = eventEntries.find(
      (entry) =>
        entry.type === 'fresh_clear.boundary' && entry.data?.previousThreadId === startupThreadId,
    );
    expect(freshClearBoundary).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          previousThreadId: startupThreadId,
          nextThreadId: replacementThreadId,
          reason: 'clearOnEntry',
          statePath: 'b',
        }),
      }),
    );
    expect(
      eventEntries.some(
        (entry) =>
          entry.type === 'turn.completed' &&
          entry.threadId === startupThreadId &&
          (entry.turnId === 'turn-old' || entry.turnId === 'turn-old-drain'),
      ),
    ).toBe(false);
    const drainDiagnosticSources = eventEntries
      .filter(
        (entry) =>
          entry.type === 'diagnostic.abandoned_thread' &&
          entry.threadId === startupThreadId &&
          (entry.data?.source === 'fileChangeThreadItem' ||
            entry.data?.source === 'turnCompleted' ||
            entry.data?.source === 'fileChangePatchUpdated' ||
            entry.data?.source === 'serverRequestResolved'),
      )
      .map((entry) => entry.data?.source);
    expect(drainDiagnosticSources).toEqual([]);
    const tokenDiagnostics = eventEntries.filter(
      (entry) =>
        entry.type === 'diagnostic.abandoned_thread' &&
        entry.threadId === startupThreadId &&
        entry.data?.source === 'tokenUsageUpdated',
    );
    expect(tokenDiagnostics).toHaveLength(1);
    expect(tokenDiagnostics[0]?.seq).toBeGreaterThan(freshClearBoundary?.seq ?? 0);
  });

  it('applies initial-state model via thread/settings/update before first turn/start', async () => {
    interface Payload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'initial-model-thread-settings-update.fsm.ts');
    const m = aharness.machine({
      id: 'initial-model-thread-settings-update',
      initial: 'a',
      states: {
        a: state({
          model: { name: 'gpt-5.1-codex' },
          entryPrompt: 'state a active',
          exits: { go: exit<Payload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      a: { go: { jsonSchema: { type: 'object' }, validate: () => ({ ok: true }) } },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    const startupThreadId = 'thread-initial-model-startup';

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
        `timeout waiting for outbound: saw ${outbound
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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

      const modelUpdate = await waitForOutbound(
        (msg) => msg.method === METHOD.threadSettingsUpdate,
      );
      expect(modelUpdate.params).toEqual({
        threadId: startupThreadId,
        model: 'gpt-5.1-codex',
      });
      transport.onMessage?.({ jsonrpc: '2.0', id: modelUpdate.id, result: {} });

      const kickoff = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.turnStart &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { threadId?: unknown }).threadId === startupThreadId,
      );
      expect(kickoff.params).toEqual(
        expect.objectContaining({ threadId: startupThreadId, input: expect.any(Array) }),
      );
      transport.onMessage?.({ jsonrpc: '2.0', id: kickoff.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 1000,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-start',
          callId: 'call-go',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } }),
        },
      });
      const submitReply = await waitForOutbound(
        (msg) => msg.id === 1000 && msg.result !== undefined,
      );
      expect(submitReply.result).toEqual({
        success: true,
        contentItems: [{ type: 'inputText', text: 'Run complete. Terminal: success.' }],
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
          modulePath: '/tmp/initial-model-thread-settings-update.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'initial-model-thread-settings-update',
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
    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    const kickoffIndex = outbound.findIndex(
      (msg) =>
        msg.method === METHOD.turnStart &&
        typeof msg.params === 'object' &&
        msg.params !== null &&
        (msg.params as { threadId?: unknown }).threadId === startupThreadId,
    );
    const modelUpdateIndex = outbound.findIndex(
      (msg) => msg.method === METHOD.threadSettingsUpdate,
    );
    expect(modelUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(modelUpdateIndex).toBeLessThan(kickoffIndex);
  });

  it('cross-state submit into non-clear model state sends thread/settings/update before next aharness turn/start', async () => {
    interface Payload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'cross-state-model-update.fsm.ts');
    const m = aharness.machine({
      id: 'cross-state-model-update',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { go: exit<Payload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          model: { name: 'gpt-5.1-codex' },
          exits: { done: exit<Payload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      a: { go: { jsonSchema: { type: 'object' }, validate: () => ({ ok: true }) } },
      b: { done: { jsonSchema: { type: 'object' }, validate: () => ({ ok: true }) } },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    const startupThreadId = 'thread-cross-state-model-startup';
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
      const summary = outbound
        .map(
          (message) => `${message.id ?? '<no-id>'}:${message.method ?? `response:${message.id}`}`,
        )
        .join(', ');
      throw new Error(`timeout waiting for outbound in cross-state model test; saw ${summary}`);
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: kickoff.id,
        result: {},
      });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 2000,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          callId: 'call-go',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 2000 && msg.result !== undefined);

      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          item: { type: 'dynamicToolCall', id: 'call-go' },
        },
      });

      const interrupt = await waitForOutbound((msg) => msg.method === METHOD.turnInterrupt);
      transport.onMessage?.({ jsonrpc: '2.0', id: interrupt.id, result: {} });
      const modelUpdate = await waitForOutbound(
        (msg) => msg.method === METHOD.threadSettingsUpdate,
      );
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: modelUpdate.id,
        result: {},
      });
      const orientation = await waitForOutbound(
        (msg) =>
          msg.method === METHOD.turnStart &&
          typeof msg.id === 'number' &&
          msg.id > (interrupt.id as number),
      );
      expect(modelUpdate.params).toEqual({
        threadId: startupThreadId,
        model: 'gpt-5.1-codex',
      });
      const modelIndex = outbound.findIndex((msg) => msg.method === METHOD.threadSettingsUpdate);
      const turnStartIndex = outbound.findIndex(
        (msg, i) =>
          msg.method === METHOD.turnStart &&
          i > modelIndex &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { threadId?: unknown }).threadId === startupThreadId,
      );
      expect(modelIndex).toBeGreaterThan(0);
      expect(turnStartIndex).toBeGreaterThan(modelIndex);

      transport.onMessage?.({ jsonrpc: '2.0', id: orientation.id, result: {} });

      transport.onMessage?.({
        jsonrpc: '2.0',
        id: 2002,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-b',
          callId: 'call-done',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'b', exit: 'done', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 2002 && msg.result !== undefined);
    };

    const driverPromise = driver();
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine: m,
          sidecar,
          modulePath: '/tmp/cross-state-model-update.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'cross-state-model-update',
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
    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(0);
    expect(outbound.some((msg) => msg.method === METHOD.threadSettingsUpdate)).toBe(true);
    expect(
      outbound.some(
        (msg) =>
          msg.method === METHOD.clearOnEntry &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { clearOnEntry?: unknown }).clearOnEntry === true,
      ),
    ).toBe(false);
  });

  it('thread/settings/update failure in cross-state path fails the run', async () => {
    interface Payload {
      ok: boolean;
    }

    const fsmPath = makeFsmFile(repoRoot, 'cross-state-model-update-failure.fsm.ts');
    const m = aharness.machine({
      id: 'cross-state-model-update-failure',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'state a active',
          exits: { go: exit<Payload>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'state b active',
          model: { name: 'gpt-5.1-codex' },
          exits: { done: exit<Payload>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const sidecar = {
      a: { go: { jsonSchema: { type: 'object' }, validate: () => ({ ok: true }) } },
      b: { done: { jsonSchema: { type: 'object' }, validate: () => ({ ok: true }) } },
    };

    const outbound: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> =
      [];
    let transport!: Transport;
    const startupThreadId = 'thread-cross-state-model-failure';
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
      const summary = outbound
        .map(
          (message) => `${message.id ?? '<no-id>'}:${message.method ?? `response:${message.id}`}`,
        )
        .join(', ');
      throw new Error(`timeout waiting for outbound in settings failure test; saw ${summary}`);
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
        id: 2100,
        method: METHOD.toolDynamicCall,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          callId: 'call-go',
          tool: 'aharness_submit',
          arguments: JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } }),
        },
      });
      await waitForOutbound((msg) => msg.id === 2100 && msg.result !== undefined);

      transport.onMessage?.({
        jsonrpc: '2.0',
        method: METHOD.itemCompleted,
        params: {
          threadId: startupThreadId,
          turnId: 'turn-old',
          item: { type: 'dynamicToolCall', id: 'call-go' },
        },
      });

      const interrupt = await waitForOutbound((msg) => msg.method === METHOD.turnInterrupt);
      transport.onMessage?.({ jsonrpc: '2.0', id: interrupt.id, result: {} });
      const modelUpdate = await waitForOutbound(
        (msg) => msg.method === METHOD.threadSettingsUpdate,
      );
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: modelUpdate.id,
        error: { code: -32603, message: 'settings backend exploded' },
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
          modulePath: '/tmp/cross-state-model-update-failure.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'cross-state-model-update-failure',
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

    const runPromise = runCliForTest(opts);
    const r = await Promise.race([
      runPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('run did not fail after settings update error')), 500);
      }),
    ]);
    await driverPromise;

    expect(r.exitCode).toBe(1);
    expect(stderrBuf.join('')).toContain('state model settings failure');
    expect(stderrBuf.join('')).toContain('settings backend exploded');
    const eventEntries = expectCanonicalRunEventStream(repoRoot);
    expect(eventEntries.at(-1)).toEqual(
      expect.objectContaining({
        type: 'run.failed',
        data: expect.objectContaining({
          status: 'failed',
          message: 'state-model update failed; shutting down',
        }),
      }),
    );
    const modelUpdateIndex = outbound.findIndex(
      (msg) => msg.method === METHOD.threadSettingsUpdate,
    );
    expect(modelUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(
      outbound.slice(modelUpdateIndex + 1).some((msg) => msg.method === METHOD.turnStart),
    ).toBe(false);
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
      {
        name: 'post-transition-function-effort-only',
        clearOnEntry: () => ({
          cwd: (data: Readonly<Ctx>) => data.currentWorktreeDir,
        }),
        model: { effort: 'high' as const },
        expectReasoningEffort: 'high' as const,
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
            model: scenario.model,
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
            replyToSkillPreflightIfNeeded(transport, envelope);
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

        if ('expectReasoningEffort' in scenario) {
          const configRead = await waitForOutbound((msg) => msg.method === METHOD.configRead);
          expect(configRead.params).toEqual({ cwd: worktreeDir });
          transport.onMessage?.({
            jsonrpc: '2.0',
            id: configRead.id,
            result: { config: { model: null } },
          });

          const modelList = await waitForOutbound((msg) => msg.method === METHOD.modelList);
          expect(modelList.params).toEqual({ includeHidden: true });
          transport.onMessage?.({
            jsonrpc: '2.0',
            id: modelList.id,
            result: {
              data: [
                {
                  model: 'catalog-default',
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'high', description: 'High' },
                    { reasoningEffort: 'medium', description: 'Medium' },
                  ],
                  defaultReasoningEffort: 'medium',
                  isDefault: true,
                },
              ],
              nextCursor: null,
            },
          });
        }

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
        if ('expectReasoningEffort' in scenario) {
          expect(replacementThreadStart.params).toEqual(
            expect.objectContaining({
              config: { model_reasoning_effort: scenario.expectReasoningEffort },
            }),
          );
        }
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
            skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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

  it('fails runtime preflight for unsupported effort before replacement thread/start', async () => {
    interface Ctx {
      currentWorktreeDir: string;
    }
    interface Payload {
      worktreeDir: string;
    }

    const worktreeDir = join(repoRoot, 'worktree-unsupported-effort');
    mkdirSync(worktreeDir, { recursive: true });
    const fsmPath = makeFsmFile(repoRoot, 'fresh-clear-unsupported-effort.fsm.ts');
    const m = aharness.machine({
      id: 'fresh-clear-unsupported-effort',
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
          model: { effort: 'xhigh' },
          clearOnEntry: {
            cwd: (data: Readonly<Ctx>) => data.currentWorktreeDir,
          },
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
    let activeBinding: ActiveThreadBinding | undefined;
    const startupThreadId = 'thread-unsupported-effort-startup';

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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          arguments: JSON.stringify({
            state: 'a',
            exit: 'go',
            data: { worktreeDir },
          }),
        },
      });
      await waitForOutbound((msg) => msg.id === 9910 && msg.result !== undefined);

      const configRead = await waitForOutbound((msg) => msg.method === METHOD.configRead);
      expect(configRead.params).toEqual({ cwd: worktreeDir });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: configRead.id,
        result: { config: { model: 'unsupported-effort-model' } },
      });

      const modelList = await waitForOutbound((msg) => msg.method === METHOD.modelList);
      expect(modelList.params).toEqual({ includeHidden: true });
      transport.onMessage?.({
        jsonrpc: '2.0',
        id: modelList.id,
        result: {
          data: [
            {
              model: 'unsupported-effort-model',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Low' },
                { reasoningEffort: 'medium', description: 'Medium' },
              ],
              defaultReasoningEffort: 'medium',
              isDefault: true,
            },
          ],
          nextCursor: null,
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
          modulePath: '/tmp/fresh-clear-unsupported-effort.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'fresh-clear-unsupported-effort',
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
      },
    });
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);
    await driverPromise;

    expect(r.exitCode).toBe(1);
    expect(activeBinding?.current()).toBe(startupThreadId);
    expect(
      outbound.some(
        (msg) =>
          msg.method === METHOD.threadStart &&
          typeof msg.params === 'object' &&
          msg.params !== null &&
          (msg.params as { sessionStartSource?: unknown }).sessionStartSource === 'clear',
      ),
    ).toBe(false);
    const stderrText = stderrBuf.join('');
    expect(stderrText).toContain('state "b"');
    expect(stderrText).toContain('xhigh');
    expect(stderrText).toContain('unsupported-effort-model');
    expect(stderrText).toContain('low, medium');
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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
    expect(stdout.text()).toMatch(
      /aharness: browser UI available at http:\/\/127\.0\.0\.1:45678\/\?token=[^&\s]+&runId=[^&\s]+/,
    );
    const launchedUrl = new URL(launchBrowserImpl.mock.calls[0]?.[0] ?? '');
    expect(launchedUrl.searchParams.get('token')).toBeTruthy();
    expect(launchedUrl.searchParams.get('runId')).toBeTruthy();
    expect(order).toEqual([
      'ui-server',
      'url-print',
      expect.stringMatching(/^launch:http:\/\/127\.0\.0\.1:45678\/\?token=[^&]+&runId=/),
      'app-server',
      'ws-connect',
      'thread-start-request',
    ]);
  });

  it('case 19b: noOpen suppresses browser launch while keeping the UI URL available', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'browser-no-open.fsm.ts');
    const stdoutBuf: string[] = [];
    const stdoutSink = {
      write(chunk: string | Uint8Array): boolean {
        stdoutBuf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const launchBrowserImpl = vi.fn(() => ({ ok: true as const }));
    const closeUiServer = vi.fn(async () => undefined);
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        startUiServerImpl: async () => ({
          url: 'http://127.0.0.1:45678',
          close: closeUiServer,
        }),
        launchBrowserImpl,
        spawnAppServer: (async () => {
          throw new Error('stop after UI server');
        }) as unknown as RunCliTestHooks['spawnAppServer'],
      },
    });
    opts.noOpen = true;
    opts.stdout = stdoutSink;
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(1);
    expect(stdoutBuf.join('')).toMatch(
      /aharness: browser UI available at http:\/\/127\.0\.0\.1:45678\/\?token=[^&\s]+&runId=[^&\s]+/,
    );
    expect(launchBrowserImpl).not.toHaveBeenCalled();
    expect(closeUiServer).toHaveBeenCalledOnce();
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
          replyToSkillPreflightIfNeeded(transport, envelope);
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

  it('runs an onEntry sidecar through the CLI live engine without rerouting parent turns', async () => {
    const fsmPath = makeFsmFile(repoRoot, 'cli-sidecar-live-engine.fsm.ts');
    const base = createFsm<{ status: string }>();
    const fsm = base.withEvents({
      sidecarDone: base.event<{ status: string }>(),
    });
    const machine = fsm.machine({
      id: 'cli-sidecar-live-engine',
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
    let activeBinding: ActiveThreadBinding | undefined;
    let threadStartCount = 0;
    let sidecarTurnCount = 0;
    const parentSnapshots: string[] = [];
    const parentTurnStarts: unknown[] = [];
    let transport!: Transport;
    const connectStub = async (opts: ConnectHeadlessWsOptions) => {
      transport = {
        send(msg: unknown) {
          const envelope = msg as {
            readonly id?: number;
            readonly method?: string;
            readonly params?: unknown;
          };
          replyToSkillPreflightIfNeeded(transport, envelope);
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
            const threadId =
              threadStartCount === 1 ? 'parent-thread' : `sidecar-thread-${threadStartCount - 1}`;
            if (threadStartCount > 1) {
              parentSnapshots.push(activeBinding?.current() ?? '<unset>');
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
              parentTurnStarts.push(envelope.params);
            }
            if (
              typeof params.threadId === 'string' &&
              params.threadId.startsWith('sidecar-thread-')
            ) {
              parentSnapshots.push(activeBinding?.current() ?? '<unset>');
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
                  method: METHOD.agentMessageDelta,
                  params: {
                    threadId: params.threadId,
                    turnId,
                    itemId: 'assistant',
                    delta: 'done',
                  },
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
    const opts = buildOpts({
      cwd: repoRoot,
      fsmPath,
      hooks: {
        loadFsmImpl: (async () => ({
          machine,
          sidecar: {},
          modulePath: '/tmp/cli-sidecar-live-engine.mjs',
          issues: [],
          skillOriginManifest: EMPTY_SKILL_ORIGIN_MANIFEST,
          cacheHit: false,
          hash: 'cli-sidecar-live-engine',
          sourceLocations: {
            states: { work: { sourceFile: fsmPath, line: 1 } },
            exits: {},
            whenBranches: {},
            stateSkills: {},
            availableSkills: [],
          },
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
      },
    });
    opts.noOpen = true;
    opts.stderr = stderrSink;

    const r = await runCliForTest(opts);

    expect(r.exitCode).toBe(0);
    expect(parentTurnStarts).toEqual([]);
    expect(parentSnapshots).toEqual(['parent-thread', 'parent-thread']);
    const events = expectCanonicalRunEventStream(repoRoot);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'sidecar.thread.started',
        'sidecar.turn.completed',
        'sidecar.thread.closed',
        'run.completed',
      ]),
    );
  });
});
