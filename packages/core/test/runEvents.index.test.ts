import { describe, expect, it } from 'vitest';

import {
  RUN_EVENT_SCHEMA,
  buildRunEventIndex,
  type RunEventEnvelope,
  type RunEventWithOffset,
} from '../src/runEvents/index.js';

const RUN_ID = 'run-index';

function event(
  seq: number,
  type: string,
  overrides: Partial<RunEventEnvelope> = {},
): RunEventEnvelope {
  return {
    schema: RUN_EVENT_SCHEMA,
    runId: RUN_ID,
    seq,
    id: `${RUN_ID}:${seq}`,
    time: `2026-05-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    ...overrides,
  };
}

function withOffsets(events: ReadonlyArray<RunEventEnvelope>): RunEventWithOffset[] {
  let offset = 0;
  return events.map((runEvent) => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(runEvent)}\n`, 'utf8');
    const entry = { event: runEvent, offset, lineBytes };
    offset += lineBytes;
    return entry;
  });
}

function fixtureEvents(): RunEventWithOffset[] {
  return withOffsets([
    event(1, 'run.started', { data: { startedAt: '2026-05-29T00:00:01.000Z' } }),
    event(2, 'turn.started', { turnId: 'turn-1' }),
    event(3, 'state.changed', {
      stateVisitId: 'visit-plan-1',
      data: { from: null, to: 'plan', path: 'plan', cause: 'boot' },
    }),
    event(4, 'model.message', {
      stateVisitId: 'visit-plan-1',
      turnId: 'turn-1',
      itemId: 'item-msg-1',
      data: { row: { kind: 'message', label: 'Assistant', text: 'Hello plan' } },
      raw: { upstream: { content: 'full model payload' } },
    }),
    event(5, 'request.created', {
      stateVisitId: 'visit-plan-1',
      turnId: 'turn-1',
      itemId: 'item-request-1',
      requestId: 'request-1',
      data: {
        kind: 'owner-input',
        summary: 'Approve the plan?',
        pendingCard: {
          kind: 'owner-input',
          id: 'request-1',
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Approval',
              question: 'Approve the plan?',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      },
      raw: { question: { isSecret: true, text: 'secret prompt' } },
    }),
    event(6, 'reply.submitted', {
      requestId: 'request-1',
      data: { summary: 'Owner replied' },
    }),
    event(7, 'token.updated', {
      data: {
        total: {
          totalTokens: 100,
          inputTokens: 70,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 128000,
      },
    }),
    event(8, 'turn.completed', { turnId: 'turn-1' }),
    event(9, 'turn.started', { turnId: 'turn-2' }),
    event(10, 'state.changed', {
      stateVisitId: 'visit-implementation-1',
      data: { from: 'plan', to: 'implementation', path: 'implementation', cause: 'submit' },
    }),
    event(11, 'item.completed', {
      stateVisitId: 'visit-implementation-1',
      turnId: 'turn-2',
      itemId: 'item-tool-1',
      data: {
        row: {
          kind: 'tool',
          label: 'Shell',
          status: 'completed',
          summary: 'pnpm test',
          elapsedMs: 42,
          data: { command: 'pnpm test' },
        },
      },
      raw: { tool: { output: 'full output stays in event page' } },
    }),
    event(12, 'turn.completed', { turnId: 'turn-2' }),
    event(13, 'reply.resolved', {
      requestId: 'request-1',
      data: { status: 'accepted' },
    }),
    event(14, 'run.completed', { data: { status: 'success' } }),
  ]);
}

describe('canonical run event index', () => {
  it('tracks state visits, state paths, visit rows, recent rows, and current state', () => {
    const index = buildRunEventIndex({ events: fixtureEvents() });

    expect(index.currentState).toEqual(
      expect.objectContaining({
        id: 'visit-implementation-1',
        path: 'implementation',
        to: 'implementation',
        cause: 'submit',
      }),
    );
    expect(index.stateVisits.map((visit) => visit.id)).toEqual([
      'visit-plan-1',
      'visit-implementation-1',
    ]);
    expect(index.getStateVisitsByPath('plan')).toEqual(['visit-plan-1']);
    expect(index.getStateVisitRows('visit-plan-1').rows).toEqual([
      expect.objectContaining({
        eventId: 'run-index:4',
        kind: 'message',
        label: 'Assistant',
        text: 'Hello plan',
      }),
    ]);
    expect(index.getStateVisitRows('visit-implementation-1').rows).toEqual([
      expect.objectContaining({
        eventId: 'run-index:11',
        kind: 'tool',
        label: 'Shell',
        status: 'completed',
        summary: 'pnpm test',
        elapsedMs: 42,
        data: { command: 'pnpm test' },
      }),
    ]);

    const firstRecentPage = index.getRecentRows({ limit: 1 });
    expect(firstRecentPage.rows.map((row) => row.eventId)).toEqual(['run-index:4']);
    expect(firstRecentPage.nextCursor).toBe('run-index:4:row');
    expect(index.getRecentRows({ cursor: firstRecentPage.nextCursor, limit: 2 }).rows).toEqual([
      expect.objectContaining({ eventId: 'run-index:11' }),
    ]);
  });

  it('tracks turn, item, and request event ranges', () => {
    const index = buildRunEventIndex({ events: fixtureEvents() });

    expect(index.getTurnRange('turn-1')).toEqual({
      firstSeq: 2,
      lastSeq: 8,
      eventIds: ['run-index:2', 'run-index:4', 'run-index:5', 'run-index:8'],
    });
    expect(index.getItemRange('item-msg-1')).toEqual({
      firstSeq: 4,
      lastSeq: 4,
      eventIds: ['run-index:4'],
    });
    expect(index.getRequestRange('request-1')).toEqual({
      firstSeq: 5,
      lastSeq: 13,
      eventIds: ['run-index:5', 'run-index:6', 'run-index:13'],
    });
  });

  it('pages event envelopes with raw payloads preserved', () => {
    const index = buildRunEventIndex({ events: fixtureEvents() });

    const page = index.getEventPage({ after: 'run-index:10', limit: 1 });

    expect(page.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          id: 'run-index:11',
          raw: { tool: { output: 'full output stays in event page' } },
        }),
      }),
    ]);
    expect(page.nextCursor).toBe('run-index:11');
  });

  it('event pages use the immutable event set captured at index construction', () => {
    const events = fixtureEvents();
    const index = buildRunEventIndex({ events });
    events.push(
      withOffsets([
        event(99, 'model.message', {
          data: { row: { kind: 'message', text: 'late mutation' } },
        }),
      ])[0]!,
    );

    expect(index.events.map((entry) => entry.event.id)).not.toContain('run-index:99');
    expect(index.getEventPage({ after: 'run-index:98' }).events).toEqual([]);
  });

  it('builds pending request summaries until resolution events remove them', () => {
    const pendingIndex = buildRunEventIndex({ events: fixtureEvents().slice(0, 6) });

    expect(pendingIndex.getPendingRequests()).toEqual([
      {
        requestId: 'request-1',
        status: 'submitted',
        kind: 'owner-input',
        summary: 'Owner replied',
        createdAt: '2026-05-29T00:00:05.000Z',
        updatedAt: '2026-05-29T00:00:06.000Z',
        stateVisitId: 'visit-plan-1',
        turnId: 'turn-1',
        itemId: 'item-request-1',
        lastEventId: 'run-index:6',
        pendingCard: {
          kind: 'owner-input',
          id: 'request-1',
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Approval',
              question: 'Approve the plan?',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      },
    ]);

    const resolvedIndex = buildRunEventIndex({ events: fixtureEvents() });
    expect(resolvedIndex.getPendingRequests()).toEqual([]);
  });

  it('keeps pending requests after failed reply resolution attempts', () => {
    const pendingCard = {
      kind: 'owner-input',
      id: 'request-1',
      requestId: 'request-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Approval',
          question: 'Approve the plan?',
          isOther: false,
          isSecret: false,
        },
      ],
    };
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'request.created', {
          requestId: 'request-1',
          data: { kind: 'owner-input', summary: 'Approve the plan?', pendingCard },
        }),
        event(2, 'reply.submitted', {
          requestId: 'request-1',
          data: { kind: 'owner-input', status: 'submitted' },
        }),
        event(3, 'reply.resolved', {
          requestId: 'request-1',
          data: {
            kind: 'owner-input',
            status: 'failed',
            ok: false,
            httpStatus: 400,
            error: 'missing-owner-input-answer',
          },
        }),
      ]),
    });

    expect(index.getPendingRequests()).toEqual([
      expect.objectContaining({
        requestId: 'request-1',
        status: 'pending',
        kind: 'owner-input',
        summary: 'Approve the plan?',
        lastEventId: 'run-index:3',
        pendingCard,
      }),
    ]);
  });

  it('updates pending-card data on request updates and removes it after accepted resolution', () => {
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'request.created', {
          requestId: 'file-1',
          data: {
            kind: 'file-approval',
            summary: '1 change',
            pendingCard: {
              kind: 'file-approval',
              id: 'file-1',
              requestId: 'file-1',
              method: 'item/fileChange/requestApproval',
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-file',
              reason: 'initial reason',
              grantRoot: '/repo',
              changes: [{ path: 'old.ts', kind: { type: 'add' } }],
            },
          },
        }),
        event(2, 'request.updated', {
          requestId: 'file-1',
          data: {
            kind: 'file-approval',
            summary: '2 changes',
            pendingCard: {
              kind: 'file-approval',
              id: 'file-1',
              requestId: 'file-1',
              method: 'item/fileChange/requestApproval',
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-file',
              changes: [
                { path: 'new.ts', kind: { type: 'add' } },
                { path: 'old.ts', kind: { type: 'delete' } },
              ],
            },
          },
        }),
        event(3, 'reply.submitted', {
          requestId: 'file-1',
          data: { kind: 'approval', status: 'submitted' },
        }),
        event(4, 'reply.resolved', {
          requestId: 'file-1',
          data: { kind: 'approval', status: 'failed', ok: false },
        }),
      ]),
    });

    expect(index.getPendingRequests()).toEqual([
      expect.objectContaining({
        requestId: 'file-1',
        status: 'pending',
        summary: '2 changes',
        pendingCard: expect.objectContaining({
          kind: 'file-approval',
          reason: 'initial reason',
          grantRoot: '/repo',
          changes: [
            { path: 'new.ts', kind: { type: 'add' } },
            { path: 'old.ts', kind: { type: 'delete' } },
          ],
        }),
      }),
    ]);

    const resolvedIndex = buildRunEventIndex({
      events: withOffsets([
        event(1, 'request.created', {
          requestId: 'file-1',
          data: {
            kind: 'file-approval',
            pendingCard: {
              kind: 'file-approval',
              id: 'file-1',
              requestId: 'file-1',
              method: 'item/fileChange/requestApproval',
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-file',
              changes: [],
            },
          },
        }),
        event(2, 'reply.resolved', {
          requestId: 'file-1',
          data: { kind: 'approval', status: 'accepted', ok: true },
        }),
      ]),
    });
    expect(resolvedIndex.getPendingRequests()).toEqual([]);
  });

  it('folds latest posture from posture, request, reply, state, and terminal events', () => {
    const pendingIndex = buildRunEventIndex({
      events: withOffsets([
        event(1, 'posture.changed', { data: { posture: { open: true } } }),
        event(2, 'request.created', {
          requestId: 'request-1',
          data: { kind: 'owner-input', summary: 'question' },
        }),
        event(3, 'reply.submitted', {
          requestId: 'request-1',
          data: { kind: 'owner-input', status: 'submitted' },
        }),
      ]),
    });
    expect(pendingIndex.posture).toEqual({
      isTerminal: false,
      isAwaiting: true,
      submittedThisTurn: true,
      open: true,
    });

    const failedReplyIndex = buildRunEventIndex({
      events: withOffsets([
        event(1, 'request.created', {
          requestId: 'request-1',
          data: { kind: 'owner-input', summary: 'question' },
        }),
        event(2, 'reply.submitted', {
          requestId: 'request-1',
          data: { kind: 'owner-input', status: 'submitted' },
        }),
        event(3, 'reply.resolved', {
          requestId: 'request-1',
          data: { kind: 'owner-input', status: 'failed', ok: false },
        }),
      ]),
    });
    expect(failedReplyIndex.posture).toEqual({
      isTerminal: false,
      isAwaiting: true,
      submittedThisTurn: false,
      open: false,
    });

    const terminalIndex = buildRunEventIndex({
      events: withOffsets([
        event(1, 'posture.changed', {
          data: { posture: { open: true, isAwaiting: true, submittedThisTurn: true } },
        }),
        event(2, 'state.changed', {
          data: { path: 'done', to: 'done', kind: 'final' },
        }),
      ]),
    });
    expect(terminalIndex.posture).toEqual({
      isTerminal: true,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    });
  });

  it('does not create pending requests from failed replies for unknown request ids', () => {
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'reply.submitted', {
          requestId: 'stale-request',
          data: { kind: 'owner-input', status: 'submitted' },
        }),
        event(2, 'reply.resolved', {
          requestId: 'stale-request',
          data: {
            kind: 'owner-input',
            status: 'failed',
            ok: false,
            httpStatus: 409,
            error: 'no-pending-owner-input',
          },
        }),
      ]),
    });

    expect(index.getPendingRequests()).toEqual([]);
  });

  it('folds aggregate run and token stats while omitting absent optional fields', () => {
    const index = buildRunEventIndex({ events: fixtureEvents() });

    expect(index.aggregateStats).toEqual({
      status: 'success',
      startedAt: '2026-05-29T00:00:01.000Z',
      endedAt: '2026-05-29T00:00:14.000Z',
      turnCount: 2,
      totalTokens: 100,
      inputTokens: 70,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 10,
      modelContextWindow: 128000,
    });

    const sparseIndex = buildRunEventIndex({
      events: withOffsets([
        event(1, 'run.started'),
        event(2, 'turn.started', { turnId: 'turn-1' }),
      ]),
    });
    expect(sparseIndex.aggregateStats).toEqual({
      status: 'running',
      startedAt: '2026-05-29T00:00:01.000Z',
      turnCount: 1,
      activeTurnId: 'turn-1',
    });
  });

  it('folds token totals from normalized data without reading raw token payloads', () => {
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'token.updated', {
          data: {
            total: {
              totalTokens: 25,
              inputTokens: 20,
              cachedInputTokens: 5,
              outputTokens: 4,
              reasoningOutputTokens: 1,
            },
            modelContextWindow: 200000,
          },
          raw: {
            params: {
              tokenUsage: {
                total: {
                  totalTokens: 999,
                  inputTokens: 999,
                },
              },
            },
          },
        }),
      ]),
    });

    expect(index.aggregateStats).toEqual({
      turnCount: 0,
      totalTokens: 25,
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 4,
      reasoningOutputTokens: 1,
      modelContextWindow: 200000,
    });
  });

  it('does not count sub-thread turn events as parent aggregate turns', () => {
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'turn.started', { turnId: 'parent-turn' }),
        event(2, 'subthread.turn.started', {
          threadId: 'child-thread',
          turnId: 'child-turn',
          data: { parentThreadId: 'parent-thread', correlationKnown: true },
          raw: { params: { threadId: 'child-thread', turn: { id: 'child-turn' } } },
        }),
      ]),
    });

    expect(index.aggregateStats.turnCount).toBe(1);
    expect(index.getTurnRange('child-turn')).toEqual({
      firstSeq: 2,
      lastSeq: 2,
      eventIds: ['run-index:2'],
    });
  });

  it('does not fold sub-thread token events into parent aggregate stats', () => {
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'token.updated', {
          data: {
            total: { totalTokens: 10, inputTokens: 8 },
            modelContextWindow: 128000,
          },
        }),
        event(2, 'subthread.token.updated', {
          threadId: 'child-thread',
          turnId: 'child-turn',
          data: {
            total: { totalTokens: 999, inputTokens: 999 },
            modelContextWindow: 200000,
          },
          raw: { params: { threadId: 'child-thread' } },
        }),
      ]),
    });

    expect(index.aggregateStats).toEqual({
      turnCount: 0,
      totalTokens: 10,
      inputTokens: 8,
      modelContextWindow: 128000,
    });
  });

  it('omits compact rows when normalized row data is absent instead of parsing raw', () => {
    const index = buildRunEventIndex({
      events: withOffsets([
        event(1, 'model.message', {
          stateVisitId: 'visit-1',
          raw: { upstream: { content: 'this should not become a row' } },
        }),
      ]),
    });

    expect(index.getRecentRows().rows).toEqual([]);
    expect(index.getEventPage().events[0]?.event.raw).toEqual({
      upstream: { content: 'this should not become a row' },
    });
  });
});
