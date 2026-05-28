import { describe, expect, it } from 'vitest';
import type { FsmState, RunMeta, Topology } from '../src/ui/events.js';
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
