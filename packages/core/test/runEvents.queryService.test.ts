import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RUN_EVENT_SCHEMA,
  createRunEventQueryService,
  type RunEventEnvelope,
  type RunEventWithOffset,
} from '../src/runEvents/index.js';

const RUN_ID = 'run-query';

function tempEventsPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'aharness-run-events-query-')), 'events.jsonl');
}

function event(
  seq: number,
  type: string,
  overrides: Partial<RunEventEnvelope> = {},
): RunEventEnvelope {
  const runId = overrides.runId ?? RUN_ID;
  return {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq,
    id: `${runId}:${seq}`,
    time: `2026-05-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    ...overrides,
  };
}

function withOffsets(events: ReadonlyArray<RunEventEnvelope>): RunEventWithOffset[] {
  let offset = 0;
  return events.map((runEvent) => {
    const line = `${JSON.stringify(runEvent)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const entry = { event: runEvent, offset, lineBytes };
    offset += lineBytes;
    return entry;
  });
}

function writeJsonl(eventsPath: string, ...events: ReadonlyArray<RunEventEnvelope>): void {
  writeFileSync(eventsPath, events.map((runEvent) => JSON.stringify(runEvent)).join('\n') + '\n');
}

function fixtureEvents(): RunEventEnvelope[] {
  return [
    event(1, 'run.started', { data: { startedAt: '2026-05-29T00:00:01.000Z' } }),
    event(2, 'turn.started', {
      turnId: 'turn-1',
      raw: { turnCount: 99, status: 'raw must not affect aggregate' },
    }),
    event(3, 'state.changed', {
      stateVisitId: 'root.plan#1',
      data: {
        from: null,
        to: 'root.plan',
        cause: 'boot',
        stateVisitId: 'root.plan#1',
        path: 'root.plan',
        leaf: 'plan',
        kind: 'stateful',
        visitCount: 1,
        exits: [{ name: 'done', kind: 'submit', branchCount: 2 }],
        row: {
          kind: 'state_change',
          label: 'root.plan',
          status: 'boot',
          summary: 'root.plan',
        },
      },
      raw: {
        path: 'raw.plan',
        leaf: 'raw',
        entryPrompt: 'resolved prompt must stay raw',
        context: { secret: true },
      },
    }),
    event(4, 'model.message', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'item-message-1',
      data: { row: { kind: 'message', label: 'Assistant', text: 'Hello from data' } },
      raw: { row: { kind: 'message', text: 'raw row must not render' } },
    }),
    event(5, 'request.created', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'request-1',
      requestId: 'request-1',
      data: {
        kind: 'owner-input',
        summary: 'Approve from data?',
        pendingCard: {
          kind: 'owner-input',
          id: 'request-1',
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Approval',
              question: 'Approve from normalized data?',
              isOther: false,
              isSecret: false,
              choices: ['accept', 'decline'],
            },
          ],
        },
      },
      raw: { kind: 'raw-kind', summary: 'Approve from raw?', answer: 'raw answer sentinel' },
    }),
    event(6, 'posture.changed', {
      data: { posture: { open: true } },
    }),
    event(7, 'token.updated', {
      data: {
        total: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 128000,
      },
      raw: { total: { totalTokens: 999 } },
    }),
    event(8, 'state.changed', {
      stateVisitId: 'root.work#2',
      data: {
        from: 'root.plan',
        to: 'root.work',
        cause: 'submit',
        stateVisitId: 'root.work#2',
        path: 'root.work',
        leaf: 'work',
        kind: 'stateful',
        visitCount: 2,
        exits: [{ name: 'done', kind: 'submit' }],
      },
      raw: { path: 'raw.work', entryPrompt: 'raw prompt' },
    }),
  ];
}

describe('run event query service', () => {
  it('builds bootstrap projections from replayed JSONL and late-bound run metadata', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, ...fixtureEvents());
    let threadId = 'thread-before-start';
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const bootstrap = service.getBootstrap({
      getRunMeta: () => ({
        runId: RUN_ID,
        threadId,
        repoRoot: '/repo',
        fsmFile: '/repo/demo.fsm.ts',
        fsmHash6: 'abc123',
        codexPin: 'codex-test',
        startedAt: '2026-05-29T00:00:00.000Z',
      }),
      topology: { machineId: 'demo', initial: 'root.plan', nodes: [], edges: [] },
      recentLimit: 10,
    });

    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.bootstrap.run.threadId).toBe('thread-before-start');
    expect(bootstrap.bootstrap.topology).toEqual({
      machineId: 'demo',
      initial: 'root.plan',
      nodes: [],
      edges: [],
    });
    expect(bootstrap.bootstrap.latestEventId).toBe('run-query:8');
    expect(bootstrap.bootstrap.currentState).toEqual({
      path: 'root.work',
      leaf: 'work',
      kind: 'stateful',
      visitCount: 2,
      exits: [{ name: 'done', kind: 'submit' }],
    });
    expect(bootstrap.bootstrap.currentStateVisit).toEqual(
      expect.objectContaining({ id: 'root.work#2', path: 'root.work', to: 'root.work' }),
    );
    expect(bootstrap.bootstrap.stateVisits.map((visit) => visit.id)).toEqual([
      'root.plan#1',
      'root.work#2',
    ]);
    expect(bootstrap.bootstrap.statePathVisits).toEqual({
      'root.plan': ['root.plan#1'],
      'root.work': ['root.work#2'],
    });
    expect(bootstrap.bootstrap.pending).toEqual([
      expect.objectContaining({
        requestId: 'request-1',
        kind: 'owner-input',
        summary: 'Approve from data?',
        pendingCard: {
          kind: 'owner-input',
          id: 'request-1',
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Approval',
              question: 'Approve from normalized data?',
              isOther: false,
              isSecret: false,
              choices: ['accept', 'decline'],
            },
          ],
        },
      }),
    ]);
    expect(bootstrap.bootstrap.posture).toEqual({
      isTerminal: false,
      isAwaiting: true,
      submittedThisTurn: false,
      open: true,
    });
    expect(bootstrap.bootstrap.aggregateStats).toEqual(
      expect.objectContaining({
        status: 'running',
        turnCount: 1,
        totalTokens: 15,
        modelContextWindow: 128000,
      }),
    );
    expect(bootstrap.bootstrap.recentRows.map((row) => row.text ?? row.summary)).toEqual([
      'root.plan',
      'Hello from data',
    ]);
    expect(JSON.stringify(bootstrap.bootstrap)).not.toContain('raw row must not render');
    expect(JSON.stringify(bootstrap.bootstrap)).not.toContain('resolved prompt must stay raw');
    expect(JSON.stringify(bootstrap.bootstrap)).not.toContain('raw answer sentinel');

    threadId = 'thread-after-start';
    const changed = service.getBootstrap({ getRunMeta: () => ({ runId: RUN_ID, threadId }) });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.bootstrap.run.threadId).toBe('thread-after-start');
  });

  it('keeps historical current-state exit kinds from persisted JSONL', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(
      eventsPath,
      event(1, 'state.changed', {
        stateVisitId: 'root.legacy#1',
        data: {
          path: 'root.legacy',
          leaf: 'legacy',
          kind: 'stateful',
          visitCount: 1,
          exits: [{ name: 'wait', kind: 'await' }],
        },
      }),
    );
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const bootstrap = service.getBootstrap({ getRunMeta: () => ({ runId: RUN_ID }) });

    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.bootstrap.currentState).toEqual({
      path: 'root.legacy',
      leaf: 'legacy',
      kind: 'stateful',
      visitCount: 1,
      exits: [{ name: 'wait', kind: 'await' }],
    });
  });

  it('serves owner-choice pending cards and failed reply rows from bootstrap', () => {
    const eventsPath = tempEventsPath();
    const requestId = 'owner-choice:root.pick#2';
    writeJsonl(
      eventsPath,
      event(1, 'state.changed', {
        stateVisitId: 'root.pick#2',
        data: {
          from: null,
          to: 'root.pick',
          path: 'root.pick',
          leaf: 'pick',
          kind: 'choice',
          visitCount: 2,
        },
      }),
      event(2, 'request.updated', {
        stateVisitId: 'root.pick#2',
        requestId,
        data: {
          kind: 'owner-choice',
          requestId,
          pendingCard: {
            kind: 'owner-choice',
            id: requestId,
            requestId,
            state: 'root.pick',
            visitCount: 2,
            question: 'Pick one',
            options: [{ label: 'A' }, { label: 'B' }],
          },
          row: {
            kind: 'request',
            label: 'owner choice',
            status: 'pending',
            summary: '2 options',
          },
        },
      }),
      event(3, 'reply.resolved', {
        stateVisitId: 'root.pick#2',
        requestId,
        data: {
          kind: 'owner-choice',
          requestId,
          status: 'failed',
          ok: false,
          row: {
            kind: 'reply',
            label: 'owner choice',
            status: 'failed',
            summary: 'A',
          },
        },
      }),
    );
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const bootstrap = service.getBootstrap({
      getRunMeta: () => ({ runId: RUN_ID }),
      recentLimit: 10,
    });

    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.bootstrap.currentState).toEqual({
      path: 'root.pick',
      leaf: 'pick',
      kind: 'choice',
      visitCount: 2,
    });
    expect(bootstrap.bootstrap.pending).toEqual([
      expect.objectContaining({
        requestId,
        status: 'pending',
        pendingCard: expect.objectContaining({
          kind: 'owner-choice',
          state: 'root.pick',
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B' }],
        }),
      }),
    ]);
    expect(bootstrap.bootstrap.recentRows).toEqual([
      expect.objectContaining({ type: 'request.updated', label: 'owner choice' }),
      expect.objectContaining({ type: 'reply.resolved', label: 'owner choice', status: 'failed' }),
    ]);
  });

  it('attaches the latest context snapshot to the current state projection', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(
      eventsPath,
      event(1, 'run.started'),
      event(2, 'state.changed', {
        stateVisitId: 'root.plan#1',
        data: {
          path: 'root.plan',
          leaf: 'plan',
          kind: 'stateful',
          visitCount: 1,
          exits: [{ name: 'done', kind: 'submit' }],
        },
      }),
      event(3, 'context.initialized', {
        data: { context: { draft: 'one' } },
      }),
      event(4, 'context.changed', {
        data: { context: { draft: 'two', count: 2 } },
      }),
    );
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const bootstrap = service.getBootstrap({
      getRunMeta: () => ({ runId: RUN_ID }),
    });

    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.bootstrap.currentState).toEqual(
      expect.objectContaining({
        path: 'root.plan',
        context: { draft: 'two', count: 2 },
      }),
    );
  });

  it('omits context from old state-only logs', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, event(1, 'state.changed', { data: { path: 'root.plan' } }));
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const bootstrap = service.getBootstrap({ getRunMeta: () => ({ runId: RUN_ID }) });

    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.bootstrap.currentState).toEqual({ path: 'root.plan' });
    expect(bootstrap.bootstrap.currentState).not.toHaveProperty('context');
  });

  it('keeps a malformed final line warning queryable and exposes replay diagnostics', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(
      eventsPath,
      fixtureEvents()
        .slice(0, 2)
        .map((runEvent) => JSON.stringify(runEvent))
        .join('\n') + '\n{ "schema":',
    );

    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });
    const bootstrap = service.getBootstrap({ getRunMeta: () => ({ runId: RUN_ID }) });

    expect(service.available).toBe(true);
    expect(service.getDiagnostics()).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'malformed-final-line' }),
    ]);
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.bootstrap.latestEventId).toBe('run-query:2');
    expect(bootstrap.bootstrap.diagnostics).toEqual([
      expect.objectContaining({ code: 'malformed-final-line' }),
    ]);
  });

  it.each([
    ['malformed non-final line', 'not json\n', 'malformed-non-final-line'],
    [
      'wrong schema',
      `${JSON.stringify({ ...event(1, 'test.event'), schema: 'other.schema' })}\n`,
      'wrong-schema',
    ],
    [
      'wrong run id',
      `${JSON.stringify(event(1, 'test.event', { runId: 'other-run', id: 'other-run:1' }))}\n`,
      'wrong-run-id',
    ],
    [
      'invalid id',
      `${JSON.stringify(event(1, 'test.event', { id: 'run-query:2' }))}\n`,
      'id-seq-mismatch',
    ],
    [
      'invalid seq',
      `${JSON.stringify({ ...event(1, 'test.event'), seq: 0, id: 'run-query:0' })}\n`,
      'invalid-seq',
    ],
    [
      'non-increasing seq',
      `${JSON.stringify(event(1, 'test.event'))}\n${JSON.stringify(event(1, 'test.event'))}\n`,
      'non-increasing-seq',
    ],
  ])('marks %s replay corruption unavailable', (_name, body, code) => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, body);

    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });
    const bootstrap = service.getBootstrap({ getRunMeta: () => ({ runId: RUN_ID }) });

    expect(service.available).toBe(false);
    expect(bootstrap).toEqual({
      ok: false,
      error: 'run-event-log-unavailable',
      diagnostics: [expect.objectContaining({ severity: 'corruption', code })],
    });
  });

  it('pages visit rows and recent rows through compact row index behavior', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, ...fixtureEvents());
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const visitRows = service.getStateVisitRows('root.plan#1', { limit: 1 });
    expect(visitRows.ok).toBe(true);
    if (!visitRows.ok) return;
    expect(visitRows.rows).toEqual([
      expect.objectContaining({ eventId: 'run-query:3', kind: 'state_change' }),
    ]);
    expect(visitRows.nextCursor).toBe('run-query:3:row');

    const nextVisitRows = service.getStateVisitRows('root.plan#1', {
      cursor: visitRows.nextCursor,
      limit: 1,
    });
    expect(nextVisitRows.ok).toBe(true);
    if (!nextVisitRows.ok) return;
    expect(nextVisitRows.rows).toEqual([
      expect.objectContaining({ eventId: 'run-query:4', text: 'Hello from data' }),
    ]);

    const recentRows = service.getRecentRows({ limit: 2 });
    expect(recentRows.ok).toBe(true);
    if (!recentRows.ok) return;
    expect(recentRows.rows.map((row) => row.eventId)).toEqual(['run-query:3', 'run-query:4']);
  });

  it('projects compact tool output metadata from normalized row data', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(
      eventsPath,
      event(1, 'state.changed', {
        stateVisitId: 'root.plan#1',
        data: {
          path: 'root.plan',
          to: 'root.plan',
          row: { kind: 'state_change', label: 'root.plan', status: 'boot' },
        },
      }),
      event(2, 'item.completed', {
        stateVisitId: 'root.plan#1',
        itemId: 'call-1',
        data: {
          row: {
            kind: 'tool',
            label: 'bash',
            status: 'completed',
            output: 'done',
            ok: true,
            resultId: 'call-1:output',
          },
        },
      }),
    );
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const visitRows = service.getStateVisitRows('root.plan#1');

    expect(visitRows.ok).toBe(true);
    if (!visitRows.ok) return;
    expect(visitRows.rows).toEqual([
      expect.objectContaining({ kind: 'state_change' }),
      expect.objectContaining({
        kind: 'tool',
        itemId: 'call-1',
        output: 'done',
        ok: true,
        resultId: 'call-1:output',
      }),
    ]);
  });

  it('projects API-safe event pages without raw and validates canonical event cursors', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, ...fixtureEvents());
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const page = service.getEventPage({ after: 'run-query:3', limit: 2 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.events.map((runEvent) => runEvent.id)).toEqual(['run-query:4', 'run-query:5']);
    expect(page.events[0]).toEqual(
      expect.objectContaining({
        id: 'run-query:4',
        offset: expect.any(Number),
        lineBytes: expect.any(Number),
        data: { row: { kind: 'message', label: 'Assistant', text: 'Hello from data' } },
      }),
    );
    expect(page.nextCursor).toBe('run-query:5');
    expect(JSON.stringify(page.events)).not.toContain('raw');

    expect(service.getEventPage({ after: 'bad-cursor' })).toEqual({
      ok: false,
      error: 'invalid-event-cursor',
    });
    expect(service.getEventPage({ after: 'other-run:1' })).toEqual({
      ok: false,
      error: 'invalid-event-cursor',
    });
    expect(service.getEventPage({ after: 'run-query:0' })).toEqual({
      ok: false,
      error: 'invalid-event-cursor',
    });
    expect(service.getEventPage({ after: 'run-query:99' })).toEqual({
      ok: false,
      error: 'event-cursor-out-of-range',
      latestEventId: 'run-query:8',
    });
  });

  it('accepts canonical next appends, rebuilds queries, and notifies subscribers after updates', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, ...fixtureEvents().slice(0, 2));
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });
    const notified: string[] = [];
    const unsubscribe = service.subscribe(() => {
      const latest = service.getLatestEventId();
      if (latest !== null) notified.push(latest);
    });

    const accepted = service.acceptAppend(
      withOffsets([
        event(3, 'model.message', {
          data: { row: { kind: 'message', text: 'accepted append row' } },
        }),
      ])[0]!,
    );

    expect(accepted).toEqual({ ok: true, latestEventId: 'run-query:3' });
    expect(notified).toEqual(['run-query:3']);
    const recent = service.getRecentRows();
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.rows).toEqual([expect.objectContaining({ text: 'accepted append row' })]);

    const rejected = service.acceptAppend(withOffsets([event(3, 'model.message')])[0]!);
    expect(rejected.ok).toBe(false);
    expect(notified).toEqual(['run-query:3']);

    unsubscribe();
    const acceptedAfterUnsubscribe = service.acceptAppend(
      withOffsets([event(4, 'run.completed')])[0]!,
    );
    expect(acceptedAfterUnsubscribe.ok).toBe(true);
    expect(notified).toEqual(['run-query:3']);
  });

  it('does not recover an unavailable corrupted replay service from a later append', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, 'not json\n');
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });
    const notified: string[] = [];
    service.subscribe((entry) => notified.push(entry.event.id));

    const result = service.acceptAppend(withOffsets([event(1, 'run.started')])[0]!);

    expect(result).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({ code: 'malformed-non-final-line' }),
    });
    expect(service.available).toBe(false);
    expect(notified).toEqual([]);
    expect(service.getRecentRows()).toEqual({
      ok: false,
      error: 'run-event-log-unavailable',
      diagnostics: [expect.objectContaining({ code: 'malformed-non-final-line' })],
    });
  });

  it('swallows listener failures while notifying later subscribers', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, event(1, 'run.started'));
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });
    const notified: string[] = [];
    service.subscribe(() => {
      throw new Error('observability failure');
    });
    service.subscribe((entry) => notified.push(entry.event.id));

    const result = service.acceptAppend(withOffsets([event(2, 'run.completed')])[0]!);

    expect(result.ok).toBe(true);
    expect(notified).toEqual(['run-query:2']);
  });

  it('drains all currently indexed events after a cursor across multiple pages', () => {
    const eventsPath = tempEventsPath();
    writeJsonl(eventsPath, ...fixtureEvents());
    const service = createRunEventQueryService({ runId: RUN_ID, eventsPath });

    const drained = service.eventsAfter('run-query:2', { pageLimit: 2 });

    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.events.map((runEvent) => runEvent.id)).toEqual([
      'run-query:3',
      'run-query:4',
      'run-query:5',
      'run-query:6',
      'run-query:7',
      'run-query:8',
    ]);
  });
});
