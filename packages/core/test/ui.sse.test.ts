import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it } from 'vitest';
import {
  RUN_EVENT_SCHEMA,
  type ApiSafeRunEvent,
  type RunEventQueryService,
  type RunEventWithOffset,
} from '../src/runEvents/index.js';
import type { FsmState, RunMeta, Topology } from '../src/ui/events.js';
import {
  RUN_SCOPED_SSE_FALLBACK_EVENT_NAME,
  RUN_SCOPED_SSE_RESYNC_EVENT_NAME,
  drainRunScopedSseEvents,
  readRunScopedSseCursor,
  serializeRunScopedSseEvent,
  streamRunScopedSseEvents,
} from '../src/ui/runScopedSse.js';
import { createUiEventLog, serializeSseEvent } from '../src/ui/sse.js';

const runMeta: RunMeta = {
  runId: 'run-1',
  threadId: 'thread-1',
  repoRoot: '/repo',
  fsmFile: 'agent.fsm.ts',
  fsmHash6: 'abc123',
  codexPin: 'codex-test',
  startedAt: '2026-05-13T00:00:00.000Z',
};

const state: FsmState = {
  path: 'root.working',
  leaf: 'working',
  kind: 'stateful',
  exits: [{ name: 'done', kind: 'submit', branchCount: 1 }],
  visitCount: 2,
};

const topology: Topology = {
  machineId: 'root',
  initial: 'root.working',
  nodes: [{ id: 'root.working', label: 'working', kind: 'stateful' }],
  edges: [
    {
      id: 'root.working::done',
      from: 'root.working',
      to: 'root.done',
      exit: 'done',
      kind: 'submit',
    },
  ],
};

describe('createUiEventLog', () => {
  it('assigns monotonically increasing decimal string IDs starting at 1', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    const first = log.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'booting',
      variant: 'orientation',
    });
    const second = log.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'hello',
    });

    expect(first.id).toBe('1');
    expect(second.id).toBe('2');
  });

  it('returns the latest event ID and accumulated app state in snapshot()', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    log.publish({
      kind: 'StateChange',
      from: null,
      to: 'root.working',
      cause: 'boot',
      newState: state,
    });
    log.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'orientation text',
      variant: 'orientation',
    });
    log.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'Hello\nworld',
      reasoning: true,
    });
    log.publish({
      kind: 'TurnCompleted',
      turnId: 'turn-1',
      finishReason: 'stop',
    });

    expect(log.snapshot()).toEqual({
      latestEventId: '4',
      state: {
        run: runMeta,
        posture: {
          isTerminal: false,
          isAwaiting: false,
          submittedThisTurn: false,
          open: false,
        },
        activeTurn: null,
        currentState: state,
        topology: {
          machineId: '',
          initial: '',
          nodes: [],
          edges: [],
        },
        pending: {
          ownerInput: null,
          ownerChoice: null,
          fileApprovals: [],
          cmdApprovals: [],
          permissionApprovals: [],
          elicitations: [],
        },
        transcript: [{ id: 'msg-1', text: 'Hello\nworld', reasoning: true }],
        frameworkNotes: [
          {
            kind: 'FrameworkNote',
            id: 'note-1',
            text: 'orientation text',
            variant: 'orientation',
          },
        ],
        diagnostics: [],
        completedTurns: [
          {
            kind: 'TurnCompleted',
            turnId: 'turn-1',
            finishReason: 'stop',
          },
        ],
      },
    });
  });

  it('includes run topology in snapshot state', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta, topology });

    expect(log.snapshot().state).toEqual(expect.objectContaining({ topology }));
  });

  it('returns only retained events later than Last-Event-ID', () => {
    const log = createUiEventLog({ capacity: 3, run: runMeta });

    log.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'one',
      variant: 'info',
    });
    log.publish({
      kind: 'FrameworkNote',
      id: 'note-2',
      text: 'two',
      variant: 'info',
    });
    log.publish({
      kind: 'FrameworkNote',
      id: 'note-3',
      text: 'three',
      variant: 'info',
    });

    expect(log.eventsAfter('1').map((event) => event.id)).toEqual(['2', '3']);
  });

  it('returns a resync marker for unknown or too-old Last-Event-ID cursors', () => {
    const log = createUiEventLog({ capacity: 2, run: runMeta });

    log.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'one',
      variant: 'info',
    });
    log.publish({
      kind: 'FrameworkNote',
      id: 'note-2',
      text: 'two',
      variant: 'info',
    });
    log.publish({
      kind: 'FrameworkNote',
      id: 'note-3',
      text: 'three',
      variant: 'info',
    });

    expect(log.eventsAfter('1')[0]).toEqual({
      id: '3',
      event: {
        kind: 'ResyncRequired',
        reason: 'event-buffer-overflow',
        requestedLastEventId: '1',
      },
    });
    expect(log.eventsAfter('99')[0]).toEqual({
      id: '3',
      event: {
        kind: 'ResyncRequired',
        reason: 'unknown-last-event-id',
        requestedLastEventId: '99',
      },
    });
    expect(log.snapshot().latestEventId).toBe('3');
    expect(log.eventsAfter('2').map((event) => event.id)).toEqual(['3']);
  });

  it.each([
    [
      'invalid',
      'not-decimal',
      {
        kind: 'ResyncRequired',
        reason: 'unknown-last-event-id',
        requestedLastEventId: 'not-decimal',
      },
    ],
    [
      'future',
      '99',
      {
        kind: 'ResyncRequired',
        reason: 'unknown-last-event-id',
        requestedLastEventId: '99',
      },
    ],
    [
      'evicted',
      '1',
      {
        kind: 'ResyncRequired',
        reason: 'event-buffer-overflow',
        requestedLastEventId: '1',
      },
    ],
  ])('returns a synthetic resync marker for %s cursors', (_name, cursor, expectedEvent) => {
    const log = createUiEventLog({ capacity: 1, run: runMeta });

    log.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'evicted',
      variant: 'info',
    });
    log.publish({
      kind: 'FrameworkNote',
      id: 'note-2',
      text: 'retained',
      variant: 'info',
    });

    expect(log.eventsAfter(cursor)).toEqual([
      {
        id: '2',
        event: expectedEvent,
      },
    ]);
  });

  it('does not advance latestEventId when emitting synthetic resync markers', () => {
    const log = createUiEventLog({ capacity: 1, run: runMeta });

    log.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'retained',
      variant: 'info',
    });

    const beforeInvalidCursor = log.snapshot().latestEventId;
    const invalidCursorEvents = log.eventsAfter('invalid');
    const futureCursorEvents = log.eventsAfter('9');

    expect(beforeInvalidCursor).toBe('1');
    expect(invalidCursorEvents[0]?.id).toBe('1');
    expect(futureCursorEvents[0]?.id).toBe('1');
    expect(log.snapshot().latestEventId).toBe('1');
    expect(log.eventsAfter('1')).toEqual([]);
  });

  it('applies published posture updates to the app-state snapshot', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    log.publish({
      kind: 'PostureChange',
      posture: {
        isAwaiting: true,
        submittedThisTurn: true,
      },
    });

    expect(log.snapshot().state.posture).toEqual({
      isTerminal: false,
      isAwaiting: true,
      submittedThisTurn: true,
      open: false,
    });
  });

  it('tracks the active turn in the replayable snapshot', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    log.publish({ kind: 'TurnStarted', turnId: 'turn-1' });
    expect(log.snapshot().state.activeTurn).toEqual({ turnId: 'turn-1' });

    log.publish({ kind: 'TurnCompleted', turnId: 'turn-1', finishReason: 'stop' });
    expect(log.snapshot().state.activeTurn).toBeNull();
  });

  it('fresh-clear boundary clears active transcript turns and pending state while preserving run state', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta, topology });

    log.publish({
      kind: 'StateChange',
      from: null,
      to: 'root.working',
      cause: 'boot',
      newState: state,
    });
    log.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-old',
      delta: 'old conversation',
    });
    log.publish({
      kind: 'TurnCompleted',
      turnId: 'turn-old',
      finishReason: 'stop',
    });
    log.publish({
      kind: 'ServerRequest',
      id: 'cmd-1',
      requestId: 'cmd-1',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-old',
      turnId: 'turn-old',
      itemId: 'cmd-1',
      command: 'echo old',
    });
    log.publish({
      kind: 'FreshClearBoundary',
      id: 'clear-1',
      reason: 'clearOnEntry',
      previousThreadId: 'thread-old',
      nextThreadId: 'thread-new',
      statePath: 'root.working',
    });

    expect(log.snapshot().state).toMatchObject({
      run: runMeta,
      currentState: state,
      topology,
      transcript: [],
      completedTurns: [],
      pending: {
        ownerInput: null,
        fileApprovals: [],
        cmdApprovals: [],
        permissionApprovals: [],
        elicitations: [],
      },
    });
  });

  it('stores abandoned-thread diagnostics separately from active transcript and keeps the newest 100', () => {
    const log = createUiEventLog({ capacity: 130, run: runMeta });

    for (let i = 0; i < 101; i += 1) {
      log.publish({
        kind: 'AbandonedThreadDiagnostic',
        id: `diag-${i}`,
        threadId: 'thread-old',
        source: 'agentMessageDelta',
        message: `old thread residue ${i}`,
      });
    }

    const snapshot = log.snapshot();
    expect(snapshot.state.transcript).toEqual([]);
    expect(snapshot.state.diagnostics).toHaveLength(100);
    expect(snapshot.state.diagnostics[0]?.id).toBe('diag-1');
    expect(snapshot.state.diagnostics.at(-1)?.id).toBe('diag-100');
  });

  it('stores owner-input requests in the replayable snapshot pending state', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    const request = {
      kind: 'ServerRequest',
      id: 'item-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Decision',
          question: 'Ship it?',
          isOther: false,
          isSecret: false,
        },
      ],
    } as const;

    log.publish(request);

    expect(log.snapshot().state.pending.ownerInput).toEqual(request);
  });

  it('stores approval and elicitation requests in pending buckets', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    const fileRequest = {
      kind: 'ServerRequest',
      id: 'patch-1',
      requestId: 'patch-1',
      method: 'item/fileChange/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [],
    } as const;
    const cmdRequest = {
      kind: 'ServerRequest',
      id: 'cmd-1',
      requestId: 'cmd-1',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      command: 'npm test',
    } as const;
    const permissionRequest = {
      kind: 'ServerRequest',
      id: 'perm-1',
      requestId: 'perm-1',
      method: 'item/permissions/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'perm-1',
      cwd: '/repo',
      permissions: { network: null, fileSystem: null },
    } as const;
    const elicitation = {
      kind: 'ServerRequest',
      id: 'elicit-1',
      requestId: 'elicit-1',
      method: 'mcpServer/elicitation/request',
      threadId: 'thread-1',
      turnId: null,
      serverName: 'srv',
      mode: 'url',
      message: 'open',
      url: 'https://example.test',
      elicitationId: 'elicit-1',
    } as const;

    log.publish(fileRequest);
    log.publish(cmdRequest);
    log.publish(permissionRequest);
    log.publish(elicitation);

    expect(log.snapshot().state.pending.fileApprovals).toEqual([fileRequest]);
    expect(log.snapshot().state.pending.cmdApprovals).toEqual([cmdRequest]);
    expect(log.snapshot().state.pending.permissionApprovals).toEqual([permissionRequest]);
    expect(log.snapshot().state.pending.elicitations).toEqual([elicitation]);
  });

  it('updates file approval changes and clears resolved approval requests', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    log.publish({
      kind: 'ServerRequest',
      id: 'patch-1',
      requestId: 'patch-1',
      method: 'item/fileChange/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [],
    });
    log.publish({
      kind: 'FileApprovalUpdated',
      id: 'patch-1',
      requestId: 'patch-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [{ path: 'src/file.ts', kind: { type: 'add' }, diff: '+x\n' }],
    });

    expect(log.snapshot().state.pending.fileApprovals[0]?.changes).toEqual([
      { path: 'src/file.ts', kind: { type: 'add' }, diff: '+x\n' },
    ]);

    log.publish({ kind: 'ApprovalRequestResolved', id: 'patch-1', requestId: 'patch-1' });

    expect(log.snapshot().state.pending.fileApprovals).toEqual([]);
  });

  it('clears a matching owner-input request after an accepted browser reply event', () => {
    const log = createUiEventLog({ capacity: 8, run: runMeta });

    log.publish({
      kind: 'ServerRequest',
      id: 'item-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Decision',
          question: 'Ship it?',
          isOther: false,
          isSecret: false,
        },
      ],
    });
    log.publish({ kind: 'OwnerInputResolved', id: 'item-1' });

    expect(log.snapshot().state.pending.ownerInput).toBeNull();
  });
});

describe('serializeSseEvent', () => {
  it('writes id, event, and newline-safe JSON data fields', () => {
    const frame = serializeSseEvent({
      id: '7',
      event: {
        kind: 'AgentMessageDelta',
        id: 'msg-1',
        delta: 'line 1\nline 2',
      },
    });

    expect(frame).toBe(
      'id: 7\n' +
        'event: AgentMessageDelta\n' +
        'data: {\n' +
        'data:   "kind": "AgentMessageDelta",\n' +
        'data:   "id": "msg-1",\n' +
        'data:   "delta": "line 1\\nline 2"\n' +
        'data: }\n\n',
    );
  });
});

function apiSafeRunEvent(
  seq: number,
  type: string,
  overrides: Partial<ApiSafeRunEvent> = {},
): ApiSafeRunEvent {
  return {
    schema: RUN_EVENT_SCHEMA,
    runId: runMeta.runId,
    seq,
    id: `${runMeta.runId}:${seq}`,
    time: `2026-05-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    offset: seq * 100,
    lineBytes: 90,
    ...overrides,
  };
}

function fakeRunEventQueryService(options: {
  readonly runId?: string;
  readonly latestEventId?: string | null;
  readonly eventsAfter?: RunEventQueryService['eventsAfter'];
  readonly subscribe?: RunEventQueryService['subscribe'];
}): RunEventQueryService {
  return {
    runId: options.runId ?? runMeta.runId,
    available: true,
    subscribe: options.subscribe ?? (() => () => undefined),
    acceptAppend: () => ({
      ok: false,
      diagnostic: {
        severity: 'corruption',
        code: 'invalid-json-object',
        message: 'fake query service does not accept appends',
        offset: 0,
      },
    }),
    getLatestEventId: () => options.latestEventId ?? null,
    getDiagnostics: () => [],
    getBootstrap: () => ({ ok: false, error: 'run-event-log-unavailable', diagnostics: [] }),
    getStateVisitRows: () => ({ ok: true, rows: [], nextCursor: null }),
    getRecentRows: () => ({ ok: true, rows: [], nextCursor: null }),
    getEventPage: () => ({ ok: true, events: [], nextCursor: null, diagnostics: [] }),
    eventsAfter: options.eventsAfter ?? (() => ({ ok: true, events: [] })),
  };
}

describe('run-scoped SSE helpers', () => {
  it('reads run-scoped cursors from Last-Event-ID before after query params', () => {
    const request = new EventEmitter() as http.IncomingMessage;
    request.headers = { 'last-event-id': `${runMeta.runId}:4` };

    expect(
      readRunScopedSseCursor(
        request,
        new URL(`http://127.0.0.1/api/runs/run-1/stream?after=${runMeta.runId}:2`),
      ),
    ).toBe(`${runMeta.runId}:4`);

    request.headers = {};
    expect(
      readRunScopedSseCursor(
        request,
        new URL(`http://127.0.0.1/api/runs/run-1/stream?after=${runMeta.runId}:2`),
      ),
    ).toBe(`${runMeta.runId}:2`);
  });

  it('serializes API-safe canonical run events with canonical ids and safe event labels', () => {
    const frame = serializeRunScopedSseEvent(
      apiSafeRunEvent(1, 'model.message\nunsafe', {
        data: { text: 'line 1\nline 2' },
      }),
    );

    expect(frame).toContain(`id: ${runMeta.runId}:1\n`);
    expect(frame).toContain(`event: ${RUN_SCOPED_SSE_FALLBACK_EVENT_NAME}\n`);
    expect(frame).toContain('data:   "type": "model.message\\nunsafe",');
    expect(frame).toContain('data:     "text": "line 1\\nline 2"');
    expect(frame).not.toContain('raw');
    expect(frame.split('\n').filter((line) => line.startsWith('event: '))).toEqual([
      `event: ${RUN_SCOPED_SSE_FALLBACK_EVENT_NAME}`,
    ]);
  });

  it.each([
    ['malformed', 'not-a-cursor', 'invalid-event-cursor'],
    ['wrong run', 'other-run:1', 'wrong-run-event-cursor'],
    ['zero', `${runMeta.runId}:0`, 'invalid-event-cursor'],
    ['negative', `${runMeta.runId}:-1`, 'invalid-event-cursor'],
    ['non-integer', `${runMeta.runId}:1.5`, 'invalid-event-cursor'],
  ] as const)(
    'emits a non-persisted resync control frame for %s cursors',
    (_name, cursor, reason) => {
      const frames: string[] = [];
      const result = drainRunScopedSseEvents({
        queryService: fakeRunEventQueryService({ latestEventId: `${runMeta.runId}:2` }),
        afterEventId: cursor,
        write: (frame) => frames.push(frame),
      });

      expect(result).toEqual({
        lastSentId: `${runMeta.runId}:2`,
        framesWritten: 1,
        resync: {
          kind: 'RunScopedResyncRequired',
          control: true,
          requestedEventId: cursor,
          latestEventId: `${runMeta.runId}:2`,
          reason,
        },
      });
      expect(frames[0]).toContain(`id: ${runMeta.runId}:2\n`);
      expect(frames[0]).toContain(`event: ${RUN_SCOPED_SSE_RESYNC_EVENT_NAME}\n`);
      expect(frames[0]).toContain(`data:   "requestedEventId": "${cursor}",`);
      expect(frames[0]).toContain(`data:   "reason": "${reason}"`);
    },
  );

  it('emits a resync control frame for future cursors without advancing ids', () => {
    const frames: string[] = [];
    const result = drainRunScopedSseEvents({
      queryService: fakeRunEventQueryService({
        latestEventId: `${runMeta.runId}:3`,
        eventsAfter: () => ({
          ok: false,
          error: 'event-cursor-out-of-range',
          latestEventId: `${runMeta.runId}:3`,
        }),
      }),
      afterEventId: `${runMeta.runId}:99`,
      write: (frame) => frames.push(frame),
    });

    expect(result.resync).toEqual({
      kind: 'RunScopedResyncRequired',
      control: true,
      requestedEventId: `${runMeta.runId}:99`,
      latestEventId: `${runMeta.runId}:3`,
      reason: 'future-event-cursor',
    });
    expect(result.lastSentId).toBe(`${runMeta.runId}:3`);
    expect(frames[0]).toContain(`id: ${runMeta.runId}:3\n`);
    expect(frames[0]).toContain(`event: ${RUN_SCOPED_SSE_RESYNC_EVENT_NAME}\n`);
  });

  it('streams by subscribing before the initial drain and then draining after notifications', () => {
    const calls: string[] = [];
    let listener: ((entry: RunEventWithOffset) => void) | null = null;
    let availableEvents = [apiSafeRunEvent(1, 'run.started')];
    const request = new EventEmitter() as http.IncomingMessage;
    request.headers = {};
    const written: string[] = [];
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: () => undefined,
      flushHeaders: () => undefined,
      write: (frame: string) => {
        written.push(frame);
        return true;
      },
      end: () => undefined,
    } as unknown as http.ServerResponse;

    const cleanup = streamRunScopedSseEvents({
      queryService: fakeRunEventQueryService({
        latestEventId: `${runMeta.runId}:1`,
        subscribe: (nextListener) => {
          calls.push('subscribe');
          listener = nextListener;
          return () => {
            calls.push('unsubscribe');
          };
        },
        eventsAfter: (afterEventId) => {
          calls.push(`eventsAfter:${afterEventId ?? 'null'}`);
          const afterSeq = afterEventId === null ? 0 : Number(afterEventId.split(':').at(-1));
          return {
            ok: true,
            events: availableEvents.filter((event) => event.seq > afterSeq),
          };
        },
      }),
      request,
      response,
      url: new URL('http://127.0.0.1/api/runs/run-1/stream'),
    });

    expect(calls.slice(0, 2)).toEqual(['subscribe', 'eventsAfter:null']);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`id: ${runMeta.runId}:1\n`);
    expect(written[0]).toContain('event: run.started\n');

    availableEvents = [...availableEvents, apiSafeRunEvent(2, 'turn.started')];
    listener?.({
      event: {
        schema: RUN_EVENT_SCHEMA,
        runId: runMeta.runId,
        seq: 2,
        id: `${runMeta.runId}:2`,
        time: '2026-05-29T00:00:02.000Z',
        type: 'turn.started',
      },
      offset: 200,
      lineBytes: 90,
    });

    expect(calls.at(-1)).toBe(`eventsAfter:${runMeta.runId}:1`);
    expect(written).toHaveLength(2);
    expect(written[1]).toContain(`id: ${runMeta.runId}:2\n`);

    cleanup();
    expect(calls.at(-1)).toBe('unsubscribe');
  });

  it('removes request listeners and active stream cleanup hooks on close', () => {
    const request = new EventEmitter() as http.IncomingMessage;
    request.headers = {};
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: () => undefined,
      flushHeaders: () => undefined,
      write: () => true,
      end: () => undefined,
    } as unknown as http.ServerResponse;
    const activeStreams = new Set<() => void>();
    let unsubscribed = false;

    streamRunScopedSseEvents({
      queryService: fakeRunEventQueryService({
        subscribe: () => () => {
          unsubscribed = true;
        },
      }),
      request,
      response,
      url: new URL('http://127.0.0.1/api/runs/run-1/stream'),
      activeStreams,
    });

    expect(activeStreams.size).toBe(1);
    expect(request.listenerCount('close')).toBe(1);

    request.emit('close');

    expect(unsubscribed).toBe(true);
    expect(activeStreams.size).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
  });
});
