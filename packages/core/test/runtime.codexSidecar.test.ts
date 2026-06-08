import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { METHOD, type ToolRequestUserInputParams } from '../src/protocol/index.js';
import { CodexSidecarError } from '../src/state/codexSidecar.js';
import {
  createCodexSidecarManager,
  type CodexSidecarManagerDiagnostic,
  type CodexSidecarNotificationHandler,
} from '../src/runtime/codexSidecar.js';
import type { ResolvedRuntimeSkill } from '../src/runtime/skillCatalog.js';

type RequestRecord = { method: string; params: unknown };
type DeferredResponse = {
  readonly resolve: (response: unknown) => void;
};

class FakeSidecarClient {
  readonly requests: RequestRecord[] = [];
  private readonly notificationHandlers = new Map<string, Set<CodexSidecarNotificationHandler>>();
  private threadSeq = 0;
  private turnSeq = 0;
  private nextResponses: Array<{
    readonly method: string;
    readonly response: unknown | Promise<unknown>;
    readonly reject?: boolean;
  }> = [];

  queueResponse(method: string, response: unknown, opts: { reject?: boolean } = {}): void {
    this.nextResponses.push({ method, response, reject: opts.reject });
  }

  deferResponse(method: string): DeferredResponse {
    let resolveResponse: (response: unknown) => void = () => undefined;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    this.nextResponses.push({ method, response });
    return { resolve: resolveResponse };
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    const queuedIndex = this.nextResponses.findIndex((entry) => entry.method === method);
    if (queuedIndex >= 0) {
      const [queued] = this.nextResponses.splice(queuedIndex, 1);
      const response = await queued?.response;
      if (queued?.reject) throw response;
      return response as T;
    }
    if (method === METHOD.threadStart) {
      this.threadSeq += 1;
      return {
        thread: { id: `thread-${this.threadSeq}`, ephemeral: true },
      } as T;
    }
    if (method === METHOD.turnStart) {
      this.turnSeq += 1;
      return { turn: { id: `turn-${this.turnSeq}` } } as T;
    }
    if (method === METHOD.turnInterrupt) {
      return {} as T;
    }
    if (method === METHOD.threadUnsubscribe) {
      return { status: 'unsubscribed' } as T;
    }
    return {} as T;
  }

  onNotification(method: string, handler: CodexSidecarNotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers.get(method) ?? []) {
      handler(params);
    }
  }

  requestsFor(method: string): RequestRecord[] {
    return this.requests.filter((request) => request.method === method);
  }
}

const resolvedThreadSkills: readonly ResolvedRuntimeSkill[] = [
  {
    source: 'thread',
    stateId: '',
    index: 0,
    threadSkillKey: 'reviewer',
    name: 'reviewing-code',
    path: '/skills/reviewing-code/SKILL.md',
  },
  {
    source: 'thread',
    stateId: '',
    index: 0,
    threadSkillKey: 'driver',
    name: 'driver',
    path: '/repo/.agents/skills/driver/SKILL.md',
  },
  {
    source: 'state',
    stateId: 'active',
    index: 0,
    name: 'state-only',
    path: '/skills/state-only/SKILL.md',
  },
];

function createHarness(
  overrides: {
    readonly client?: FakeSidecarClient;
    readonly diagnostics?: CodexSidecarManagerDiagnostic[];
    readonly activeData?: unknown;
    readonly activeSourceDir?: string;
    readonly resolvedSkills?: readonly ResolvedRuntimeSkill[];
  } = {},
) {
  const client = overrides.client ?? new FakeSidecarClient();
  const diagnostics = overrides.diagnostics ?? [];
  const manager = createCodexSidecarManager({
    client,
    defaultCwd: '/repo',
    resolvedSkills: overrides.resolvedSkills ?? resolvedThreadSkills,
    getActiveStateData: () => overrides.activeData ?? { fixture: 'subject' },
    getActiveStateSourceDir: () => overrides.activeSourceDir ?? '/repo/fsm',
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });
  return { client, diagnostics, manager };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createCodexSidecarManager', () => {
  it('creates a sidecar thread with resolved cwd, model, instructions, and no dynamic tools', async () => {
    const { client, manager } = createHarness();

    const thread = await manager.createThread('subject', {
      cwd: './fixtures/subject',
      model: { name: 'gpt-5.1', effort: 'high' },
      instructions: { base: 'base guide', developer: 'developer guide' },
      label: 'Subject',
    });

    expect(thread.key).toBe('subject');
    expect(thread.threadId).toBe('thread-1');
    expect(thread.label).toBe('Subject');
    expect(client.requestsFor(METHOD.threadStart)).toHaveLength(1);
    expect(client.requestsFor(METHOD.threadStart)[0]?.params).toEqual({
      cwd: resolve('/repo/fsm', './fixtures/subject'),
      model: 'gpt-5.1',
      config: { model_reasoning_effort: 'high' },
      baseInstructions: 'base guide',
      developerInstructions: 'developer guide',
    });
    expect(client.requestsFor(METHOD.threadStart)[0]?.params).not.toHaveProperty('dynamicTools');
  });

  it('evaluates function cwd with active state data and resolves relative returns from the source dir', async () => {
    const { client, manager } = createHarness({
      activeData: { fixture: 'function-subject' },
      activeSourceDir: '/repo/workflows/main',
    });

    await manager.createThread<{ fixture: string }>('subject', {
      cwd: (data) => `./fixtures/${data.fixture}`,
    });

    expect(client.requestsFor(METHOD.threadStart)[0]?.params).toMatchObject({
      cwd: resolve('/repo/workflows/main', './fixtures/function-subject'),
    });
  });

  it('rejects invalid create options before thread/start', async () => {
    const { client, manager } = createHarness();

    await expect(manager.createThread('bad-timeout', { defaultTurnTimeoutMs: 0 })).rejects.toThrow(
      "Codex sidecar thread 'bad-timeout' defaultTurnTimeoutMs must be a positive finite number",
    );
    await expect(manager.createThread('bad-skill', { initialSkills: ['missing'] })).rejects.toThrow(
      "Codex sidecar thread 'bad-skill' initialSkills[0] references unknown threadSkills key 'missing'",
    );
    await expect(
      manager.createThread('bad-skill-type', { initialSkills: ['reviewer', 12 as never] }),
    ).rejects.toThrow(
      "Codex sidecar thread 'bad-skill-type' initialSkills[1] must be a string threadSkills key",
    );
    await expect(
      manager.createThread('bad-model', { model: { effort: 'huge' as never } }),
    ).rejects.toThrow(
      "Codex sidecar thread 'bad-model' model.effort must be one of: none, minimal, low, medium, high, xhigh",
    );
    await expect(manager.createThread('bad-label', { label: '' })).rejects.toThrow(
      "Codex sidecar thread 'bad-label' label must be a non-empty string",
    );
    expect(client.requestsFor(METHOD.threadStart)).toHaveLength(0);
  });

  it('uses keyed live handles, rejects duplicate live keys, and allows reuse after close', async () => {
    const { manager } = createHarness();
    const first = await manager.createThread('subject');

    await expect(manager.createThread('subject')).rejects.toThrow(
      "Codex sidecar thread key 'subject' is already live",
    );
    expect(manager.thread('subject')).toBe(first);

    await first.close();
    expect(() => manager.thread('subject')).toThrow(
      "Codex sidecar thread key 'subject' is not live",
    );

    const second = await manager.createThread('subject');
    expect(second.threadId).toBe('thread-2');
    expect(second).not.toBe(first);
    await expect(first.send('late')).resolves.toMatchObject({
      ok: false,
      reason: 'thread_closed',
    });
  });

  it('injects initial skills only on the first accepted turn and returns completed boundaries', async () => {
    const { client, manager } = createHarness();
    const thread = await manager.createThread('subject', {
      initialSkills: ['reviewer', 'driver'],
    });

    const first = thread.send('inspect');
    client.emit(METHOD.agentMessageDelta, {
      threadId: thread.threadId,
      turnId: 'turn-1',
      itemId: 'assistant-1',
      delta: 'done',
    });
    client.emit(METHOD.turnCompleted, {
      threadId: thread.threadId,
      turn: { id: 'turn-1' },
    });

    await expect(first).resolves.toMatchObject({
      ok: true,
      kind: 'completed',
      turn: {
        threadId: thread.threadId,
        turnId: 'turn-1',
        assistantText: 'done',
      },
    });
    expect(client.requestsFor(METHOD.turnStart)[0]?.params).toEqual({
      threadId: thread.threadId,
      input: [
        { type: 'skill', name: 'reviewing-code', path: '/skills/reviewing-code/SKILL.md' },
        { type: 'skill', name: 'driver', path: '/repo/.agents/skills/driver/SKILL.md' },
        { type: 'text', text: 'inspect' },
      ],
    });

    const second = thread.send([{ type: 'mention', name: 'fixture', path: '/repo/fixture.md' }]);
    client.emit(METHOD.turnCompleted, {
      threadId: thread.threadId,
      turn: { id: 'turn-2' },
    });

    await expect(second).resolves.toMatchObject({ ok: true, kind: 'completed' });
    expect(client.requestsFor(METHOD.turnStart)[1]?.params).toEqual({
      threadId: thread.threadId,
      input: [{ type: 'mention', name: 'fixture', path: '/repo/fixture.md' }],
    });
  });

  it('interrupts delayed turn/start after close without committing the closed first turn', async () => {
    const { client, diagnostics, manager } = createHarness();
    const delayedTurnStart = client.deferResponse(METHOD.turnStart);
    const first = await manager.createThread('subject', {
      initialSkills: ['reviewer'],
    });

    const firstSend = first.send('slow start');
    expect(client.requestsFor(METHOD.turnStart)[0]?.params).toEqual({
      threadId: first.threadId,
      input: [
        { type: 'skill', name: 'reviewing-code', path: '/skills/reviewing-code/SKILL.md' },
        { type: 'text', text: 'slow start' },
      ],
    });

    await first.close();
    expect(client.requestsFor(METHOD.turnInterrupt)).toHaveLength(0);

    delayedTurnStart.resolve({ turn: { id: 'turn-delayed' } });
    await expect(firstSend).resolves.toMatchObject({
      ok: false,
      reason: 'thread_closed',
      threadId: first.threadId,
    });
    expect(client.requestsFor(METHOD.turnInterrupt)[0]?.params).toEqual({
      threadId: first.threadId,
      turnId: 'turn-delayed',
    });

    client.emit(METHOD.turnCompleted, {
      threadId: first.threadId,
      turn: { id: 'turn-delayed' },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'sidecar.notification.ignored',
          threadId: first.threadId,
          turnId: 'turn-delayed',
        }),
      ]),
    );

    const second = await manager.createThread('subject', {
      initialSkills: ['reviewer'],
    });
    const secondSend = second.send('fresh start');
    client.emit(METHOD.turnCompleted, {
      threadId: second.threadId,
      turn: { id: 'turn-1' },
    });

    await expect(secondSend).resolves.toMatchObject({
      ok: true,
      kind: 'completed',
      turn: { threadId: second.threadId, turnId: 'turn-1' },
    });
    expect(client.requestsFor(METHOD.turnStart)[1]?.params).toEqual({
      threadId: second.threadId,
      input: [
        { type: 'skill', name: 'reviewing-code', path: '/skills/reviewing-code/SKILL.md' },
        { type: 'text', text: 'fresh start' },
      ],
    });
  });

  it('maps interrupted turn/completed notifications to interrupted boundaries', async () => {
    const { client, manager } = createHarness();
    const thread = await manager.createThread('subject');

    const result = thread.send('interrupt me');
    client.emit(METHOD.turnCompleted, {
      threadId: thread.threadId,
      turn: { id: 'turn-1', status: 'interrupted' },
    });

    await expect(result).resolves.toMatchObject({
      ok: false,
      reason: 'interrupted',
      threadId: thread.threadId,
      turnId: 'turn-1',
      events: [
        {
          type: 'sidecar.turn.completed',
          threadId: thread.threadId,
          turnId: 'turn-1',
          data: { status: 'interrupted' },
        },
      ],
    });
  });

  it('returns needsInput for sidecar request_user_input and answer normalizes responses', async () => {
    const { client, manager } = createHarness();
    const thread = await manager.createThread('subject');

    const send = thread.send('ask if needed');
    const requestParams: ToolRequestUserInputParams = {
      threadId: thread.threadId,
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [
        {
          id: 'direction',
          header: 'Direction',
          question: 'Which path?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'A', description: 'Path A' }],
        },
      ],
    };
    const serverReply = manager.handleRequestUserInput(requestParams);

    const needsInput = await send;
    expect(needsInput).toMatchObject({
      ok: true,
      kind: 'needsInput',
      request: {
        threadId: thread.threadId,
        turnId: 'turn-1',
        itemId: 'input-1',
        questions: [{ id: 'direction', question: 'Which path?' }],
      },
    });
    if (!needsInput.ok || needsInput.kind !== 'needsInput') {
      throw new Error('expected needsInput');
    }

    const answer = thread.answer(needsInput.request.id, {
      direction: 'Use path A',
      notes: ['keep it short', 'cite files'],
    });
    await expect(serverReply).resolves.toEqual({
      answers: {
        direction: { answers: ['Use path A'] },
        notes: { answers: ['keep it short', 'cite files'] },
      },
    });
    client.emit(METHOD.turnCompleted, {
      threadId: thread.threadId,
      turn: { id: 'turn-1' },
    });

    await expect(answer).resolves.toMatchObject({
      ok: true,
      kind: 'completed',
      turn: { turnId: 'turn-1' },
    });
  });

  it('closes pending sidecar input by interrupting and ignoring the parked turn', async () => {
    const { client, diagnostics, manager } = createHarness();
    const thread = await manager.createThread('subject');

    const send = thread.send('ask if needed');
    const serverReply = manager.handleRequestUserInput({
      threadId: thread.threadId,
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [
        {
          id: 'direction',
          question: 'Which path?',
          isOther: false,
          isSecret: false,
        },
      ],
    });

    await expect(send).resolves.toMatchObject({ ok: true, kind: 'needsInput' });
    await thread.close();

    expect(client.requestsFor(METHOD.turnInterrupt)[0]?.params).toEqual({
      threadId: thread.threadId,
      turnId: 'turn-1',
    });
    await expect(serverReply).resolves.toEqual({ answers: {} });

    client.emit(METHOD.turnCompleted, {
      threadId: thread.threadId,
      turn: { id: 'turn-1' },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'sidecar.notification.ignored',
          threadId: thread.threadId,
          turnId: 'turn-1',
        }),
      ]),
    );
  });

  it('rejects overlapping operations on the same sidecar deterministically', async () => {
    const { manager } = createHarness();
    const thread = await manager.createThread('subject');

    const first = thread.send('still running');
    await expect(thread.send('overlap')).resolves.toMatchObject({
      ok: false,
      reason: 'error',
      message: "Codex sidecar thread 'subject' already has an active operation",
    });

    await thread.close();
    await expect(first).resolves.toMatchObject({ ok: false, reason: 'thread_closed' });
  });

  it('times out active turns, interrupts when a turn id is known, and ignores late completion', async () => {
    vi.useFakeTimers();
    const { client, diagnostics, manager } = createHarness();
    const thread = await manager.createThread('subject', { defaultTurnTimeoutMs: 5 });

    const result = thread.send('slow');
    await vi.advanceTimersByTimeAsync(5);

    await expect(result).resolves.toMatchObject({
      ok: false,
      reason: 'timeout',
      threadId: thread.threadId,
      turnId: 'turn-1',
    });
    expect(client.requestsFor(METHOD.turnInterrupt)[0]?.params).toEqual({
      threadId: thread.threadId,
      turnId: 'turn-1',
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'sidecar.turn.timeout',
          threadId: thread.threadId,
          turnId: 'turn-1',
        }),
      ]),
    );

    client.emit(METHOD.turnCompleted, {
      threadId: thread.threadId,
      turn: { id: 'turn-1' },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'sidecar.notification.ignored',
          threadId: thread.threadId,
          turnId: 'turn-1',
        }),
      ]),
    );
  });

  it('maps app-server closure request failures to app_server_closed boundaries', async () => {
    const { client, manager } = createHarness();
    const thread = await manager.createThread('subject');
    client.queueResponse(METHOD.turnStart, new Error('jsonrpc: client closed'), { reject: true });

    await expect(thread.send('closed')).resolves.toMatchObject({
      ok: false,
      reason: 'app_server_closed',
      message: "Codex sidecar thread 'subject' app-server closed during send",
    });
  });

  it('sendOrThrow converts failed boundaries to typed CodexSidecarError', async () => {
    const { manager } = createHarness();
    const thread = await manager.createThread('subject');
    await thread.close();

    await expect(thread.sendOrThrow('late')).rejects.toMatchObject({
      name: 'CodexSidecarError',
      reason: 'thread_closed',
      threadId: 'thread-1',
    } satisfies Partial<CodexSidecarError>);
  });

  it('close is idempotent and shutdown closes all live sidecars before client teardown', async () => {
    const { client, diagnostics, manager } = createHarness();
    const first = await manager.createThread('first');
    const second = await manager.createThread('second');

    const active = first.send('running');
    await Promise.resolve();
    await first.close();
    await first.close();
    await expect(active).resolves.toMatchObject({ ok: false, reason: 'thread_closed' });
    client.emit(METHOD.turnCompleted, {
      threadId: first.threadId,
      turn: { id: 'turn-1' },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'sidecar.notification.ignored',
          threadId: first.threadId,
          turnId: 'turn-1',
        }),
      ]),
    );

    await manager.shutdown();

    expect(client.requestsFor(METHOD.threadUnsubscribe).map((request) => request.params)).toEqual([
      { threadId: first.threadId },
      { threadId: second.threadId },
    ]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'sidecar.thread.closed', threadId: first.threadId }),
        expect.objectContaining({ type: 'sidecar.thread.closed', threadId: second.threadId }),
      ]),
    );
  });
});
