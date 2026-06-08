import { describe, expect, it } from 'vitest';

import {
  RUN_EVENT_SCHEMA,
  buildRunCompletionStats,
  type RunEventEnvelope,
  type RunEventWithOffset,
} from '../src/runEvents/index.js';

const RUN_ID = 'run-completion';

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
    const line = `${JSON.stringify(runEvent)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const entry = { event: runEvent, offset, lineBytes };
    offset += lineBytes;
    return entry;
  });
}

function stats(events: ReadonlyArray<RunEventEnvelope>, topology?: object) {
  return buildRunCompletionStats({
    events: withOffsets(events),
    getRunMeta: () => ({
      runId: RUN_ID,
      repoRoot: '/secret/repo-root',
      fsmFile: '/secret/repo-root/workflow/demo.fsm.ts',
      codexPin: 'codex-secret-pin',
    }),
    topology,
  });
}

describe('run completion stats projection', () => {
  it('returns null for active runs', () => {
    expect(
      stats([
        event(1, 'run.started', { data: { startedAt: '2026-05-29T00:00:01.000Z' } }),
        event(2, 'state.changed', { data: { path: 'root.plan', kind: 'stateful' } }),
      ]),
    ).toBeNull();
  });

  it('projects terminal success stats without sensitive raw fields', () => {
    const projected = stats([
      event(1, 'run.started', {
        data: {
          startedAt: '2026-05-29T00:00:01.000Z',
          fsmFile: '/secret/raw-run-start.fsm.ts',
          codexPin: 'raw-codex-pin',
        },
      }),
      event(2, 'state.changed', {
        stateVisitId: 'visit-plan',
        data: { path: 'root.plan', stateVisitId: 'visit-plan', kind: 'stateful' },
        raw: { transcript: 'RAW_TRANSCRIPT_SECRET', ownerInput: 'OWNER_INPUT_SECRET' },
      }),
      event(3, 'turn.started', { turnId: 'turn-1' }),
      event(4, 'token.updated', {
        threadId: 'main-thread-secret',
        data: {
          total: { totalTokens: 100, inputTokens: 70, cachedInputTokens: 20, outputTokens: 30 },
        },
      }),
      event(5, 'token.updated', {
        threadId: 'main-thread-secret',
        data: {
          total: { totalTokens: 125, inputTokens: 80, cachedInputTokens: 25, outputTokens: 45 },
        },
      }),
      event(6, 'fresh_clear.boundary'),
      event(7, 'git.diff.recorded', {
        data: {
          status: 'available',
          from: '0123456789abcdef',
          to: 'fedcba9876543210',
          filesChanged: 3,
          linesAdded: 20,
          linesDeleted: 4,
        },
      }),
      event(8, 'state.changed', {
        stateVisitId: 'visit-work',
        data: { path: 'root.work', stateVisitId: 'visit-work', kind: 'stateful' },
      }),
      event(9, 'subthread.turn.started', {
        threadId: 'child-thread-secret',
        turnId: 'child-turn',
        data: { parentTurnId: 'turn-1' },
      }),
      event(10, 'subthread.token.updated', {
        threadId: 'child-thread-secret',
        turnId: 'child-turn',
        data: {
          parentTurnId: 'turn-1',
          total: { totalTokens: 40, inputTokens: 30, outputTokens: 10 },
        },
        raw: { toolOutput: 'RAW_TOOL_OUTPUT_SECRET' },
      }),
      event(11, 'run.completed', { data: { endedAt: '2026-05-29T00:00:11.000Z' } }),
    ]);

    expect(projected).toEqual(
      expect.objectContaining({
        outcome: 'success',
        fsmDisplayName: 'demo.fsm',
        duration: {
          startedAt: '2026-05-29T00:00:01.000Z',
          endedAt: '2026-05-29T00:00:11.000Z',
          elapsedMs: 10_000,
        },
        transitionCount: 2,
        freshClearCount: 1,
        mainTurnCount: 1,
        subthreadTurnCount: 1,
        topologyStatus: 'fallback',
        workDelta: { status: 'available', filesChanged: 3, linesAdded: 20, linesDeleted: 4 },
      }),
    );
    expect(projected?.tokenTotals).toEqual(
      expect.objectContaining({
        totalTokens: 165,
        inputTokens: 110,
        cachedInputTokens: 25,
        outputTokens: 55,
        mainTokens: 125,
        subthreadTokens: 40,
      }),
    );
    expect(JSON.stringify(projected)).not.toContain('/secret');
    expect(JSON.stringify(projected)).not.toContain(RUN_ID);
    expect(JSON.stringify(projected)).not.toContain('codex-secret-pin');
    expect(JSON.stringify(projected)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(projected)).not.toContain('fedcba9876543210');
    expect(JSON.stringify(projected)).not.toContain('RAW_TRANSCRIPT_SECRET');
    expect(JSON.stringify(projected)).not.toContain('RAW_TOOL_OUTPUT_SECRET');
    expect(JSON.stringify(projected)).not.toContain('OWNER_INPUT_SECRET');
  });

  it('uses latest terminal evidence and supports historical terminal-state-only logs', () => {
    expect(
      stats([event(1, 'state.changed', { data: { path: 'root.done', kind: 'terminal' } })])
        ?.outcome,
    ).toBe('unknown');
    expect(stats([event(1, 'run.completed'), event(2, 'run.failed')])?.outcome).toBe('failure');
    expect(stats([event(1, 'run.completed'), event(2, 'run.cancelled')])?.outcome).toBe(
      'cancelled',
    );
  });

  it('sanitizes missing or unusable FSM names', () => {
    const projected = buildRunCompletionStats({
      events: withOffsets([event(1, 'run.completed')]),
      getRunMeta: () => ({ fsmFile: '/tmp/!!!.ts' }),
    });
    const windowsPathProjected = buildRunCompletionStats({
      events: withOffsets([event(1, 'run.completed')]),
      getRunMeta: () => ({ fsmFile: 'C:\\Users\\secret\\workflow\\windows-demo.fsm.ts' }),
    });

    expect(projected?.fsmDisplayName).toBe('FSM Run');
    expect(windowsPathProjected?.fsmDisplayName).toBe('windows-demo.fsm');
    expect(JSON.stringify(windowsPathProjected)).not.toContain('Users');
    expect(JSON.stringify(windowsPathProjected)).not.toContain('secret');
  });

  it('reports unavailable duration and work deltas for partial or old logs', () => {
    const projected = stats([
      event(1, 'run.started', { data: { startedAt: 'not-a-date' } }),
      event(2, 'git.diff.recorded', {
        data: { status: 'unavailable', reason: 'not-a-git-repository' },
      }),
      event(3, 'run.failed', { data: { endedAt: 'also-not-a-date' } }),
    ]);

    expect(projected?.duration).toEqual({});
    expect(projected?.workDelta).toEqual({
      status: 'unavailable',
      reason: 'not-a-git-repository',
    });
    expect(stats([event(1, 'run.completed')])?.workDelta).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
    const malformedReason = stats([
      event(1, 'git.diff.recorded', {
        data: { status: 'unavailable', reason: '/secret/repo/raw stderr should not leak' },
      }),
      event(2, 'run.completed'),
    ]);
    expect(malformedReason?.workDelta).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(JSON.stringify(malformedReason)).not.toContain('raw stderr should not leak');
  });

  it('rolls buckets through topology and keeps unmapped subthread work unattributed', () => {
    const projected = stats(
      [
        event(1, 'run.started'),
        event(2, 'state.changed', {
          stateVisitId: 'visit-child',
          data: { path: 'root.embed.child', stateVisitId: 'visit-child', kind: 'stateful' },
        }),
        event(3, 'item.started', { itemId: 'item-1' }),
        event(4, 'subthread.token.updated', {
          threadId: 'child-thread',
          data: {
            parentItemId: 'item-1',
            total: { totalTokens: 9, inputTokens: 5, outputTokens: 4 },
          },
        }),
        event(5, 'turn.started', { threadId: 'parent-thread', turnId: 'parent-turn' }),
        event(6, 'subthread.token.updated', {
          threadId: 'child-thread-parent-only',
          data: {
            parentThreadId: 'parent-thread',
            total: { totalTokens: 4, inputTokens: 2, outputTokens: 2 },
          },
        }),
        event(7, 'subthread.token.updated', {
          threadId: 'orphan-thread',
          data: { total: { totalTokens: 7, inputTokens: 7 } },
        }),
        event(8, 'state.changed', {
          stateVisitId: 'visit-review',
          data: { path: 'root.review', stateVisitId: 'visit-review', kind: 'stateful' },
        }),
        event(9, 'token.updated', {
          data: { total: { totalTokens: 5, inputTokens: 4, outputTokens: 1 } },
        }),
        event(10, 'run.completed'),
      ],
      {
        nodes: [
          { id: 'root.embed', label: 'Embedded Worker', kind: 'embed' },
          { id: 'root.embed.child', label: 'Child', kind: 'stateful', parent: 'root.embed' },
          { id: 'root.review', label: 'Review', kind: 'stateful' },
        ],
      },
    );

    expect(projected?.topologyStatus).toBe('available');
    expect(projected?.stateBuckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'state:root.embed',
          label: 'Embedded Worker',
          tokenTotals: expect.objectContaining({ totalTokens: 13 }),
        }),
        expect.objectContaining({
          id: 'state:root.review',
          label: 'Review',
          tokenTotals: expect.objectContaining({ totalTokens: 5 }),
        }),
        expect.objectContaining({
          id: 'unattributed',
          label: 'Unattributed',
          tokenTotals: expect.objectContaining({ totalTokens: 7 }),
        }),
      ]),
    );
    expect(projected?.tokenTotals.unattributedTokens).toBe(7);
  });
});
