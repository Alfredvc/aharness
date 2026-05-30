import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { EventLogEntryInput } from '../src/events.js';
import {
  RUN_EVENT_SCHEMA,
  appEventToEnrichedRunEventAppendInput,
  appEventToRunEventAppendInput,
  createLiveRunEventPublisher,
  createRunEventQueryService,
  legacyEventInputToRunEventAppendInput,
} from '../src/runEvents/index.js';
import { createUiEventLog } from '../src/ui/sse.js';
import type { AppEvent, FsmState, RunMeta } from '../src/ui/events.js';
import type { RunDir } from '../src/types.js';

const runMeta: RunMeta = {
  runId: 'run-adapter',
  threadId: 'thread-1',
  repoRoot: '/repo',
  fsmFile: '/repo/demo.fsm.ts',
  fsmHash6: 'abc123',
  codexPin: 'codex-test',
  startedAt: '2026-05-29T00:00:00.000Z',
};

const fsmState: FsmState = {
  path: 'root.work',
  leaf: 'work',
  kind: 'stateful',
  awaitsOwnerText: { messageToUser: 'secret owner-facing prompt' },
  exits: [
    { name: 'done', kind: 'submit', branchCount: 2 },
    { name: 'wait', kind: 'await' },
  ],
  visitCount: 3,
  entryPrompt: 'resolved prompt must stay out',
  context: { secret: 'state context must stay out' },
};

function tempRunDir(runId = 'run-adapter'): RunDir {
  const root = mkdtempSync(join(tmpdir(), 'aharness-run-events-adapter-'));
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(artifactsDir);
  return {
    runId,
    root,
    snapshotPath: join(root, 'snapshot.json'),
    eventsPath: join(root, 'events.jsonl'),
    artifactsDir,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoSensitivePayload(value: unknown): void {
  const text = json(value);
  for (const forbidden of [
    'tool arguments must stay out',
    'tool output must stay out',
    'rm -rf /secret',
    '/secret/cwd',
    'command-action-secret',
    'network-context-secret',
    'secret owner-facing prompt',
    'state context must stay out',
    'resolved prompt must stay out',
    'question text must stay out',
    'choice-secret',
    'permission-profile-secret',
    'diff --secret',
    'elicitation schema secret',
    'https://secret.example.test',
    'submitted elicitation value',
    'raw request payload',
  ]) {
    expect(text).not.toContain(forbidden);
  }
}

describe('run event adapter', () => {
  it.each([
    [
      'AgentMessageDelta',
      { kind: 'AgentMessageDelta', id: 'msg-1', delta: 'visible text', reasoning: true },
      'model.delta',
    ],
    [
      'ItemStarted function call',
      {
        kind: 'ItemStarted',
        id: 'call-1',
        type: 'function_call',
        name: 'bash',
        arguments: 'tool arguments must stay out',
      },
      'item.started',
    ],
    [
      'ItemStarted function output',
      {
        kind: 'ItemStarted',
        id: 'call-1:output',
        type: 'function_call_output',
        name: 'bash',
        output: 'tool output must stay out',
        ok: false,
      },
      'item.completed',
    ],
    [
      'ItemStarted agent message',
      { kind: 'ItemStarted', id: 'agent-1', type: 'agent_message', text: 'assistant text' },
      'item.started',
    ],
    [
      'ItemStarted user message',
      { kind: 'ItemStarted', id: 'user-1', type: 'user_message', text: 'user text' },
      'item.started',
    ],
    [
      'ItemStarted reasoning',
      { kind: 'ItemStarted', id: 'reason-1', type: 'reasoning', text: 'reasoning text' },
      'item.started',
    ],
    ['TurnStarted', { kind: 'TurnStarted', turnId: 'turn-1' }, 'turn.started'],
    [
      'TurnCompleted',
      { kind: 'TurnCompleted', turnId: 'turn-1', finishReason: 'stop' },
      'turn.completed',
    ],
    [
      'StateChange',
      {
        kind: 'StateChange',
        from: null,
        to: 'root.work',
        cause: 'boot',
        newState: fsmState,
      },
      'state.changed',
    ],
    [
      'FrameworkNote',
      { kind: 'FrameworkNote', id: 'note-1', text: 'diagnostic', variant: 'warn' },
      'framework.note',
    ],
    [
      'FreshClearBoundary',
      {
        kind: 'FreshClearBoundary',
        id: 'fresh-1',
        reason: 'clearOnEntry',
        previousThreadId: 'thread-old',
        nextThreadId: 'thread-new',
        statePath: 'root.work',
      },
      'fresh_clear.boundary',
    ],
    [
      'AbandonedThreadDiagnostic',
      {
        kind: 'AbandonedThreadDiagnostic',
        id: 'diag-1',
        threadId: 'thread-old',
        source: 'turnCompleted',
        message: 'old turn ignored',
      },
      'diagnostic.abandoned_thread',
    ],
    ['PostureChange', { kind: 'PostureChange', posture: { isAwaiting: true } }, 'posture.changed'],
    [
      'owner-input ServerRequest',
      {
        kind: 'ServerRequest',
        id: 'owner-1',
        method: 'item/tool/requestUserInput',
        questions: [
          {
            id: 'q1',
            header: 'Header',
            question: 'question text must stay out',
            isOther: true,
            isSecret: true,
            choices: ['choice-secret'],
          },
        ],
      },
      'request.created',
    ],
    [
      'file approval ServerRequest',
      {
        kind: 'ServerRequest',
        id: 'file-1',
        requestId: 'file-1',
        method: 'item/fileChange/requestApproval',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-file',
        reason: 'reason label',
        grantRoot: '/repo',
        changes: [{ path: 'src/file.ts', kind: { type: 'add' }, diff: 'diff --secret' }],
      },
      'request.created',
    ],
    [
      'command approval ServerRequest',
      {
        kind: 'ServerRequest',
        id: 'cmd-1',
        requestId: 'cmd-1',
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-cmd',
        approvalId: 'approval-1',
        command: 'rm -rf /secret',
        cwd: '/secret/cwd',
        commandActions: ['command-action-secret'],
        networkApprovalContext: { label: 'network-context-secret' },
      },
      'request.created',
    ],
    [
      'permission approval ServerRequest',
      {
        kind: 'ServerRequest',
        id: 'permission-1',
        requestId: 'permission-1',
        method: 'item/permissions/requestApproval',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-permission',
        cwd: '/secret/cwd',
        permissions: { network: { label: 'permission-profile-secret' }, fileSystem: null },
      },
      'request.created',
    ],
    [
      'elicitation ServerRequest',
      {
        kind: 'ServerRequest',
        id: 'elicitation-1',
        requestId: 'elicitation-1',
        method: 'mcpServer/elicitation/request',
        threadId: 'thread-1',
        turnId: null,
        serverName: 'server',
        mode: 'url',
        message: 'raw request payload',
        url: 'https://secret.example.test',
        elicitationId: 'elicit-1',
        requestedSchema: { label: 'elicitation schema secret' },
        _meta: { submitted: 'submitted elicitation value' },
      },
      'request.created',
    ],
    [
      'FileApprovalUpdated',
      {
        kind: 'FileApprovalUpdated',
        id: 'file-1',
        requestId: 'file-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-file',
        changes: [
          { path: 'src/file.ts', kind: { type: 'update', move_path: null }, diff: 'diff --secret' },
        ],
      },
      'request.updated',
    ],
    [
      'ApprovalRequestResolved',
      { kind: 'ApprovalRequestResolved', id: 'file-1', requestId: 'file-1' },
      'request.resolved',
    ],
    ['OwnerInputResolved', { kind: 'OwnerInputResolved', id: 'owner-1' }, 'request.resolved'],
  ] satisfies Array<[string, AppEvent, string]>)(
    'maps %s to sanitized canonical append input',
    (_name, event, type) => {
      const input = appEventToRunEventAppendInput(event);

      expect(input).toEqual(expect.objectContaining({ type }));
      expect(input).not.toHaveProperty('raw');
      expectNoSensitivePayload(input);
    },
  );

  it('derives state visit ids from state path and visit count without persisting prompt or context', () => {
    const input = appEventToRunEventAppendInput({
      kind: 'StateChange',
      from: 'root.plan',
      to: 'root.work',
      cause: 'submit',
      newState: fsmState,
    });

    expect(input).toEqual(
      expect.objectContaining({
        type: 'state.changed',
        stateVisitId: 'root.work#3',
        data: expect.objectContaining({
          stateVisitId: 'root.work#3',
          path: 'root.work',
          leaf: 'work',
          kind: 'stateful',
          visitCount: 3,
          exits: [
            { name: 'done', kind: 'submit', branchCount: 2 },
            { name: 'wait', kind: 'await' },
          ],
        }),
      }),
    );
    expectNoSensitivePayload(input);
  });

  it('does not persist synthetic ResyncRequired events', () => {
    expect(
      appEventToRunEventAppendInput({
        kind: 'ResyncRequired',
        reason: 'unknown-last-event-id',
        requestedLastEventId: '999',
      }),
    ).toBeNull();
  });

  it('can enrich sanitized AppEvent mappings with raw and meta payloads', () => {
    const input = appEventToEnrichedRunEventAppendInput(
      {
        kind: 'ServerRequest',
        id: 'owner-1',
        method: 'item/tool/requestUserInput',
        questions: [
          {
            id: 'q1',
            header: 'Header',
            question: 'question text must stay out',
            isOther: false,
            isSecret: true,
          },
        ],
      },
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        requestId: 'owner-1',
        raw: {
          params: {
            itemId: 'owner-1',
            questions: [{ id: 'q1', question: 'question text is raw', isSecret: true }],
          },
        },
        meta: { source: 'item/tool/requestUserInput' },
      },
    );

    expect(input).toEqual(
      expect.objectContaining({
        type: 'request.created',
        threadId: 'thread-1',
        turnId: 'turn-1',
        requestId: 'owner-1',
        meta: { source: 'item/tool/requestUserInput' },
        raw: {
          params: {
            itemId: 'owner-1',
            questions: [{ id: 'q1', question: 'question text is raw', isSecret: true }],
          },
        },
      }),
    );
    expect(JSON.stringify(input?.data)).not.toContain('question text is raw');
  });

  it('caps abandoned diagnostic fields in every persisted copy', () => {
    const long = 'x'.repeat(2_000);

    const input = appEventToRunEventAppendInput({
      kind: 'AbandonedThreadDiagnostic',
      id: 'diag-long',
      threadId: 'thread-old',
      source: long,
      message: long,
    });

    expect(input).toEqual(expect.objectContaining({ type: 'diagnostic.abandoned_thread' }));
    const data = input?.data;
    if (data === undefined) throw new Error('expected diagnostic data');
    const row = data['row'] as Record<string, unknown> | undefined;
    expect(Buffer.byteLength(String(data['source']), 'utf8')).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(String(data['message']), 'utf8')).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(String(row?.['label']), 'utf8')).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(String(row?.['text']), 'utf8')).toBeLessThanOrEqual(512);
    expect(String(data['source'])).toContain('[truncated]');
    expect(String(data['message'])).toContain('[truncated]');
  });

  it.each([
    ['hook', { kind: 'hook', name: 'PreToolUse', payloadDigest: 'abc123' }, 'hook.observed'],
    [
      'submit',
      { kind: 'submit', stateId: 'root.work', accepted: false, error: 'bad payload' },
      'submit.recorded',
    ],
    [
      'transition',
      { kind: 'transition', from: 'root.plan', to: 'root.work', eventType: 'SUBMIT' },
      'transition.recorded',
    ],
    ['artifact', { kind: 'artifact', relPath: 'report.txt', bytes: 5 }, 'artifact.written'],
    ['terminal', { kind: 'terminal', state: 'done', terminal: 'success' }, 'run.completed'],
    [
      'abandonedThreadResidue',
      {
        kind: 'abandonedThreadResidue',
        threadId: 'thread-old',
        source: 'turnCompleted',
        message: 'ignored',
      },
      'diagnostic.abandoned_thread',
    ],
  ] satisfies Array<[string, EventLogEntryInput, string]>)(
    'maps legacy %s audit input to canonical compatibility type',
    (_name, entry, type) => {
      expect(legacyEventInputToRunEventAppendInput(entry)).toEqual(
        expect.objectContaining({ type }),
      );
    },
  );
});

describe('live run event publisher', () => {
  it('persists canonical events before publishing current AppEvent shapes to the UI log', () => {
    const runDir = tempRunDir();
    const uiEventLog = createUiEventLog({ run: runMeta });
    const observed: unknown[] = [];
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta,
      uiEventLog,
      onUiEvent: (event) => observed.push(event),
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    });

    publisher.publishRunStarted();
    publisher.publish({
      kind: 'StateChange',
      from: null,
      to: fsmState.path,
      cause: 'boot',
      newState: fsmState,
    });
    publisher.publish({ kind: 'AgentMessageDelta', id: 'msg-1', delta: 'hello' });
    publisher.publish({
      kind: 'ServerRequest',
      id: 'owner-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Next',
          question: 'question text must stay out',
          isOther: false,
          isSecret: false,
        },
      ],
    });
    publisher.publish({ kind: 'OwnerInputResolved', id: 'owner-1' });
    publisher.publish({
      kind: 'ResyncRequired',
      reason: 'unknown-last-event-id',
      requestedLastEventId: '999',
    });

    expect(uiEventLog.snapshot().state.currentState).toEqual(fsmState);
    expect(uiEventLog.snapshot().state.transcript).toEqual([
      { id: 'msg-1', text: 'hello', reasoning: false },
    ]);
    expect(uiEventLog.snapshot().state.pending.ownerInput).toBeNull();
    expect(observed).toHaveLength(5);

    const envelopes = readFileSync(runDir.eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(envelopes.map((entry) => entry['schema'])).toEqual(
      Array(envelopes.length).fill(RUN_EVENT_SCHEMA),
    );
    expect(envelopes.map((entry) => entry['id'])).toEqual([
      `${runDir.runId}:1`,
      `${runDir.runId}:2`,
      `${runDir.runId}:3`,
      `${runDir.runId}:4`,
      `${runDir.runId}:5`,
    ]);
    expect(envelopes.map((entry) => entry['type'])).toEqual([
      'run.started',
      'state.changed',
      'model.delta',
      'request.created',
      'request.resolved',
    ]);
    expect(envelopes.every((entry) => !('kind' in entry) && !('ts' in entry))).toBe(true);
    expectNoSensitivePayload(envelopes);
  });

  it('records enriched canonical inputs without publishing browser events', () => {
    const runDir = tempRunDir('run-direct-record');
    const uiEventLog = createUiEventLog({ run: { ...runMeta, runId: runDir.runId } });
    const observed: unknown[] = [];
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta: { ...runMeta, runId: runDir.runId },
      uiEventLog,
      onUiEvent: (event) => observed.push(event),
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    });

    publisher.record({
      type: 'reply.submitted',
      requestId: 'request-1',
      data: { kind: 'owner-input', status: 'submitted' },
      raw: { payload: { kind: 'owner-input', answers: { secret: 'stored raw' } } },
    });

    expect(observed).toEqual([]);
    expect(uiEventLog.snapshot().latestEventId).toBeNull();
    const [envelope] = readFileSync(runDir.eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(envelope).toEqual(
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        type: 'reply.submitted',
        raw: { payload: { kind: 'owner-input', answers: { secret: 'stored raw' } } },
      }),
    );
  });

  it('notifies the live index hook with only event, offset, and lineBytes after successful appends', () => {
    const runDir = tempRunDir('run-live-hook');
    const uiEventLog = createUiEventLog({ run: { ...runMeta, runId: runDir.runId } });
    const observed: unknown[] = [];
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta: { ...runMeta, runId: runDir.runId },
      uiEventLog,
      onCanonicalAppend: (entry) => observed.push(entry),
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    });

    publisher.publishRunStarted();
    publisher.publish({
      kind: 'StateChange',
      from: null,
      to: fsmState.path,
      cause: 'boot',
      newState: fsmState,
    });

    expect(observed).toHaveLength(2);
    expect(Object.keys(observed[0] as Record<string, unknown>)).toEqual([
      'event',
      'offset',
      'lineBytes',
    ]);
    expect(observed[0]).toEqual({
      event: expect.objectContaining({
        id: `${runDir.runId}:1`,
        type: 'run.started',
      }),
      offset: 0,
      lineBytes: expect.any(Number),
    });
    expect(observed[0]).not.toHaveProperty('envelope');
    expect(observed[0]).not.toHaveProperty('ok');
    expect(observed[1]).toEqual({
      event: expect.objectContaining({
        id: `${runDir.runId}:2`,
        type: 'state.changed',
      }),
      offset: expect.any(Number),
      lineBytes: expect.any(Number),
    });
  });

  it('warns without blocking UI publication when canonical append fails', () => {
    const runDir = tempRunDir('run-warning');
    const uiEventLog = createUiEventLog({ run: { ...runMeta, runId: runDir.runId } });
    const queryService = createRunEventQueryService({
      runId: runDir.runId,
      eventsPath: runDir.eventsPath,
    });
    const stderr: string[] = [];
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta: { ...runMeta, runId: runDir.runId },
      uiEventLog,
      recorder: {
        append: () => ({
          ok: false,
          warning: {
            code: 'append-failed',
            message: 'disk full',
            eventsPath: runDir.eventsPath,
            offset: 0,
            envelope: {
              schema: RUN_EVENT_SCHEMA,
              runId: runDir.runId,
              seq: 1,
              id: `${runDir.runId}:1`,
              time: '2026-05-29T00:00:00.000Z',
              type: 'state.changed',
            },
          },
        }),
        nextSeq: () => 1,
        offset: () => 0,
      },
      onCanonicalAppend: (entry) => {
        queryService.acceptAppend(entry);
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });

    publisher.publish({
      kind: 'StateChange',
      from: null,
      to: fsmState.path,
      cause: 'boot',
      newState: fsmState,
    });
    publisher.publish({ kind: 'AgentMessageDelta', id: 'msg-warning', delta: 'still live' });

    expect(uiEventLog.snapshot().state.currentState).toEqual(fsmState);
    expect(uiEventLog.snapshot().state.transcript).toEqual([
      { id: 'msg-warning', text: 'still live', reasoning: false },
    ]);
    expect(uiEventLog.snapshot().state.frameworkNotes).toEqual([
      expect.objectContaining({
        id: 'run-event-warning-1',
        kind: 'FrameworkNote',
        variant: 'warn',
        text: expect.stringContaining('events.jsonl append failed'),
      }),
      expect.objectContaining({
        id: 'run-event-warning-2',
        kind: 'FrameworkNote',
        variant: 'warn',
        text: expect.stringContaining('events.jsonl append failed'),
      }),
    ]);
    expect(stderr.join('')).toContain('events.jsonl append failed');
    expect(queryService.getEventPage()).toEqual({
      ok: true,
      events: [],
      nextCursor: null,
      diagnostics: [],
    });
  });

  it('isolates throwing and rejecting hook failures from flat UI publication', async () => {
    const runDir = tempRunDir('run-hook-failure');
    const uiEventLog = createUiEventLog({ run: { ...runMeta, runId: runDir.runId } });
    const observed: unknown[] = [];
    const stderr: string[] = [];
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta: { ...runMeta, runId: runDir.runId },
      uiEventLog,
      onUiEvent: (event) => observed.push(event),
      onCanonicalAppend: (entry) => {
        if (entry.event.type === 'run.started') {
          throw new Error('sync hook exploded');
        }
        return Promise.reject(new Error('async hook exploded'));
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });

    publisher.publishRunStarted();
    publisher.publish({
      kind: 'StateChange',
      from: null,
      to: fsmState.path,
      cause: 'boot',
      newState: fsmState,
    });
    await Promise.resolve();

    expect(uiEventLog.snapshot().state.currentState).toEqual(fsmState);
    expect(observed).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'StateChange' }),
      }),
    ]);
    expect(stderr.join('')).toContain('sync hook exploded');
    expect(stderr.join('')).toContain('async hook exploded');
  });

  it('warns without blocking UI publication when recorder initialization fails', () => {
    const runDir = tempRunDir('run-scan-failure');
    mkdirSync(runDir.eventsPath);
    const uiEventLog = createUiEventLog({ run: { ...runMeta, runId: runDir.runId } });
    const stderr: string[] = [];
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta: { ...runMeta, runId: runDir.runId },
      uiEventLog,
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });

    expect(() =>
      publisher.publish({
        kind: 'StateChange',
        from: null,
        to: fsmState.path,
        cause: 'boot',
        newState: fsmState,
      }),
    ).not.toThrow();

    expect(uiEventLog.snapshot().state.currentState).toEqual(fsmState);
    expect(uiEventLog.snapshot().state.frameworkNotes).toEqual([
      expect.objectContaining({
        kind: 'FrameworkNote',
        variant: 'warn',
        text: expect.stringContaining('events.jsonl append failed'),
      }),
    ]);
    expect(stderr.join('')).toContain('events.jsonl append failed');
  });
});
