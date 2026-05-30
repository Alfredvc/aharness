import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyAppEvent,
  applyRunEvent,
  applyVisitRowPage,
  createConnectingUiState,
  hydrateFromBootstrap,
  hydrateFromSnapshot,
  markConnectionLost,
  visibleItems,
} from './store.js';
import {
  deriveActivity,
  formatAggregateStats,
  formatContextWindowLabel,
  formatRunDurationLabel,
  formatTokenBreakdownLabels,
  formatTokenCountLabel,
} from './activity.js';
import {
  isRunScopedBootstrap,
  type RunScopedApiEvent,
  type FsmState,
  type Posture,
  type RunScopedBootstrap,
  type RunScopedCompactRow,
  type RunScopedRowPage,
  type UiSnapshot,
} from '../types/events.js';
import type { Topology } from '../types/topology.js';

const posture: Posture = {
  isTerminal: false,
  isAwaiting: false,
  submittedThisTurn: false,
  open: true,
};

const currentState: FsmState = {
  path: 'workflow.collect',
  leaf: 'collect',
  kind: 'stateful',
  awaitsOwnerText: { messageToUser: 'What should happen next?' },
  exits: [{ name: 'continue', kind: 'submit' }],
  visitCount: 2,
};

const nextState: FsmState = {
  path: 'workflow.review',
  leaf: 'review',
  kind: 'stateful',
  exits: [{ name: 'approve', kind: 'submit' }],
  visitCount: 1,
};

const topology: Topology = {
  machineId: 'workflow',
  initial: 'workflow.collect',
  nodes: [
    { id: 'workflow.collect', label: 'collect', kind: 'stateful' },
    { id: 'workflow.review', label: 'review', kind: 'stateful' },
  ],
  edges: [
    {
      id: 'workflow.collect::continue',
      from: 'workflow.collect',
      to: 'workflow.review',
      exit: 'continue',
      kind: 'submit',
    },
  ],
};

function snapshot(): UiSnapshot {
  return {
    latestEventId: '42',
    state: {
      run: {
        runId: 'run-1',
        threadId: 'thread-1',
        repoRoot: '/repo',
        fsmFile: 'workflow.ts',
        fsmHash6: 'abc123',
        codexPin: 'pin-1',
        startedAt: '2026-05-13T00:00:00.000Z',
      },
      posture,
      currentState,
      transcript: [{ id: 'agent-1', text: 'Hello', reasoning: false }],
      frameworkNotes: [
        {
          kind: 'FrameworkNote',
          id: 'note-1',
          text: 'note',
          variant: 'warn',
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
      pending: {
        ownerInput: null,
      },
    },
  };
}

function runScopedBootstrap(): RunScopedBootstrap {
  return {
    mode: 'inspect',
    run: {
      runId: 'run-1',
      threadId: 'thread-1',
      repoRoot: '/repo',
      fsmFile: 'workflow.ts',
      fsmHash6: 'abc123',
      codexPin: 'pin-1',
      startedAt: '2026-05-13T00:00:00.000Z',
    },
    topology,
    latestEventId: 'run-1:4',
    currentState: {
      path: 'workflow.collect',
      kind: 'stateful',
      visitCount: 2,
      exits: [{ name: 'continue', kind: 'submit' }],
    },
    posture,
    currentStateVisit: {
      id: 'workflow.collect#2',
      path: 'workflow.collect',
      seq: 3,
      time: '2026-05-29T00:00:03.000Z',
      from: null,
      to: 'workflow.collect',
      cause: 'boot',
    },
    stateVisits: [
      {
        id: 'workflow.collect#1',
        path: 'workflow.collect',
        seq: 1,
        time: '2026-05-29T00:00:01.000Z',
        to: 'workflow.collect',
      },
      {
        id: 'workflow.collect#2',
        path: 'workflow.collect',
        seq: 3,
        time: '2026-05-29T00:00:03.000Z',
        from: null,
        to: 'workflow.collect',
        cause: 'boot',
      },
    ],
    statePathVisits: {
      'workflow.collect': ['workflow.collect#1', 'workflow.collect#2'],
    },
    pending: [
      {
        requestId: 'owner-1',
        status: 'pending',
        kind: 'owner-input',
        summary: 'answer one question',
        createdAt: '2026-05-29T00:00:04.000Z',
        updatedAt: '2026-05-29T00:00:04.000Z',
        lastEventId: 'run-1:4',
        pendingCard: {
          kind: 'owner-input',
          id: 'owner-1',
          requestId: 'owner-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Next',
              question: 'What now?',
              isOther: false,
              isSecret: false,
              choices: ['continue'],
            },
          ],
        },
      },
    ],
    aggregateStats: {
      turnCount: 1,
      activeTurnId: 'turn-1',
    },
    recentRows: [
      {
        id: 'row-1',
        eventId: 'run-1:3',
        seq: 3,
        time: '2026-05-29T00:00:03.000Z',
        type: 'state.changed',
        stateVisitId: 'workflow.collect#2',
        kind: 'state_change',
        summary: 'Entered workflow.collect',
      },
    ],
    diagnostics: [],
  };
}

function apiEvent(overrides: Partial<RunScopedApiEvent> = {}): RunScopedApiEvent {
  const type = overrides.type ?? 'model.delta';
  return {
    schema: 'aharness.event.v1',
    runId: 'run-1',
    seq: 5,
    id: 'run-1:5',
    time: '2026-05-29T00:00:05.000Z',
    type,
    offset: 512,
    lineBytes: 128,
    ...overrides,
  };
}

function row(
  overrides: Partial<RunScopedCompactRow> & Pick<RunScopedCompactRow, 'id' | 'eventId' | 'seq'>,
): RunScopedCompactRow {
  return {
    time: '2026-05-29T00:00:05.000Z',
    type: 'model.delta',
    kind: 'message',
    text: 'row text',
    ...overrides,
  };
}

function rowPage(rows: RunScopedCompactRow[], nextCursor: string | null = null): RunScopedRowPage {
  return { rows, nextCursor };
}

describe('headless production store helpers', () => {
  it('hydrates the existing store from a validated run-scoped bootstrap conversion', () => {
    const bootstrap = runScopedBootstrap();

    expect(isRunScopedBootstrap(bootstrap)).toBe(true);
    const state = hydrateFromBootstrap(bootstrap);

    expect(state.connection).toBe('live');
    expect(state.mode).toBe('inspect');
    expect(state.devMode).toBe(true);
    expect(state.run?.runId).toBe('run-1');
    expect(state.latestEventId).toBe('run-1:4');
    expect(state.activeTurnId).toBe('turn-1');
    expect(state.state).toEqual({
      path: 'workflow.collect',
      leaf: 'collect',
      kind: 'stateful',
      exits: [{ name: 'continue', kind: 'submit' }],
      visitCount: 2,
    });
    expect(state.topology).toEqual(topology);
    expect(state.pending.ownerInput?.questions[0]).toEqual(
      expect.objectContaining({ id: 'q1', question: 'What now?', choices: ['continue'] }),
    );
    expect(state.statePathVisits).toEqual({
      'workflow.collect': ['workflow.collect#1', 'workflow.collect#2'],
    });
    expect(state.aggregateStats).toEqual({ turnCount: 1, activeTurnId: 'turn-1' });
    expect(state.transcript).toContainEqual(
      expect.objectContaining({
        type: 'state_change',
        stateVisitId: 'workflow.collect#2',
        eventId: 'run-1:3',
      }),
    );
  });

  it('formats aggregate run stats with explicit zero values and omitted missing fields', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      run: {
        ...runScopedBootstrap().run,
        startedAt: '2026-05-29T00:00:00.000Z',
      },
      aggregateStats: {
        status: 'running',
        startedAt: '2026-05-29T00:00:05.000Z',
        turnCount: 1,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 25,
        reasoningOutputTokens: 0,
        modelContextWindow: 128000,
      },
    });

    expect(
      formatAggregateStats({
        aggregateStats: state.aggregateStats,
        run: state.run,
        nowMs: Date.parse('2026-05-29T00:00:15.000Z'),
      }),
    ).toEqual({
      duration: '10s',
      totalTokens: '0 tokens',
      tokenBreakdownLabels: [
        'input 0 tokens',
        'cached input 0 tokens',
        'output 25 tokens',
        'reasoning 0 tokens',
      ],
      contextWindow: 'context 128,000 tokens',
    });
    expect(formatTokenCountLabel(undefined)).toBeNull();
    expect(formatTokenBreakdownLabels({ turnCount: 0 })).toEqual([]);
    expect(formatContextWindowLabel({ turnCount: 0 })).toBeNull();
  });

  it('formats terminal duration from endedAt and omits invalid timestamps', () => {
    expect(
      formatRunDurationLabel({
        aggregateStats: {
          status: 'success',
          startedAt: '2026-05-29T00:00:00.000Z',
          endedAt: '2026-05-29T00:01:05.000Z',
          turnCount: 1,
        },
        run: { startedAt: '2026-05-29T00:00:30.000Z' },
        nowMs: Date.parse('2026-05-29T00:10:00.000Z'),
      }),
    ).toBe('1m 05s');
    expect(
      formatRunDurationLabel({
        aggregateStats: { startedAt: 'not a timestamp', turnCount: 0 },
        run: { startedAt: 'also invalid' },
        nowMs: Date.parse('2026-05-29T00:00:05.000Z'),
      }),
    ).toBeNull();
    expect(
      formatRunDurationLabel({
        aggregateStats: {
          status: 'failed',
          startedAt: '2026-05-29T00:00:00.000Z',
          endedAt: 'invalid',
          turnCount: 0,
        },
        run: null,
        nowMs: Date.parse('2026-05-29T00:00:05.000Z'),
      }),
    ).toBeNull();
    expect(
      formatRunDurationLabel({
        aggregateStats: {
          status: 'success',
          startedAt: '2026-05-29T00:00:10.000Z',
          endedAt: '2026-05-29T00:00:05.000Z',
          turnCount: 0,
        },
        run: null,
        nowMs: Date.parse('2026-05-29T00:00:20.000Z'),
      }),
    ).toBeNull();
  });

  it('rejects malformed run-scoped bootstrap payloads before store hydration', () => {
    const bootstrap = runScopedBootstrap();

    expect(isRunScopedBootstrap({ ...bootstrap, run: {} })).toBe(false);
    expect(isRunScopedBootstrap({ ...bootstrap, pending: {} })).toBe(false);
    expect(
      isRunScopedBootstrap({
        ...bootstrap,
        pending: [{ ...bootstrap.pending[0], pendingCard: { kind: 'unknown' } }],
      }),
    ).toBe(false);
  });

  it('applies canonical run events across state, posture, turn, message, request, diagnostic, token, and ignored classes', () => {
    const initial = hydrateFromBootstrap(runScopedBootstrap());
    const stateChanged = applyRunEvent(
      initial,
      apiEvent({
        type: 'state.changed',
        id: 'run-1:5',
        seq: 5,
        stateVisitId: 'workflow.review#1',
        data: {
          from: 'workflow.collect',
          to: 'workflow.review',
          cause: 'submit',
          stateVisitId: 'workflow.review#1',
          path: 'workflow.review',
          leaf: 'review',
          kind: 'stateful',
          visitCount: 1,
          exits: [{ name: 'approve', kind: 'submit' }],
          row: {
            kind: 'state_change',
            label: 'workflow.review',
            status: 'submit',
            summary: 'workflow.collect -> workflow.review',
          },
        },
      }),
    );
    const postured = applyRunEvent(
      stateChanged,
      apiEvent({
        type: 'posture.changed',
        id: 'run-1:6',
        seq: 6,
        data: { posture: { open: true, submittedThisTurn: true } },
      }),
    );
    const turnStarted = applyRunEvent(
      postured,
      apiEvent({
        type: 'turn.started',
        id: 'run-1:7',
        seq: 7,
        turnId: 'turn-2',
        data: { turnId: 'turn-2' },
      }),
    );
    const messaged = applyRunEvent(
      turnStarted,
      apiEvent({
        type: 'model.delta',
        id: 'run-1:8',
        seq: 8,
        stateVisitId: 'workflow.review#1',
        itemId: 'msg-2',
        data: { itemId: 'msg-2', delta: 'Hello', row: { kind: 'message', text: 'Hello' } },
      }),
    );
    const tooled = applyRunEvent(
      messaged,
      apiEvent({
        type: 'item.started',
        id: 'run-1:9',
        seq: 9,
        stateVisitId: 'workflow.review#1',
        itemId: 'tool-1',
        data: {
          row: { kind: 'tool', label: 'bash', status: 'pending', summary: 'npm test' },
        },
      }),
    );
    const requested = applyRunEvent(
      tooled,
      apiEvent({
        type: 'request.created',
        id: 'run-1:10',
        seq: 10,
        requestId: 'patch-1',
        stateVisitId: 'workflow.review#1',
        data: {
          kind: 'file-approval',
          pendingCard: {
            kind: 'file-approval',
            id: 'patch-1',
            requestId: 'patch-1',
            method: 'item/fileChange/requestApproval',
            threadId: 'thread-1',
            turnId: 'turn-2',
            itemId: 'patch-1',
            changes: [{ path: 'src/file.ts', kind: { type: 'add' }, diff: '+x\n' }],
          },
          row: {
            kind: 'request',
            label: 'file approval',
            status: 'pending',
            summary: 'src/file.ts',
          },
        },
      }),
    );
    const noted = applyRunEvent(
      requested,
      apiEvent({
        type: 'framework.note',
        id: 'run-1:11',
        seq: 11,
        stateVisitId: 'workflow.review#1',
        data: {
          row: { kind: 'framework_note', text: 'framework says hi', status: 'info' },
        },
      }),
    );
    const diagnosed = applyRunEvent(
      noted,
      apiEvent({
        type: 'diagnostic.abandoned_thread',
        id: 'run-1:12',
        seq: 12,
        threadId: 'thread-old',
        data: {
          id: 'diag-2',
          source: 'turnCompleted',
          message: 'ignored old turn',
          row: { kind: 'diagnostic', text: 'ignored old turn', status: 'warn' },
        },
      }),
    );
    const tokened = applyRunEvent(
      diagnosed,
      apiEvent({
        type: 'token.updated',
        id: 'run-1:13',
        seq: 13,
        data: { total: { totalTokens: 99, outputTokens: 7 }, modelContextWindow: 200000 },
      }),
    );
    const ignored = applyRunEvent(
      tokened,
      apiEvent({
        type: 'artifact.written',
        id: 'run-1:14',
        seq: 14,
        data: { artifactId: 'a-1' },
      }),
    );

    expect(ignored.latestEventId).toBe('run-1:14');
    expect(ignored.state?.path).toBe('workflow.review');
    expect(ignored.activeVisitId).toBe('workflow.review#1');
    expect(ignored.statePathVisits['workflow.review']).toEqual(['workflow.review#1']);
    expect(ignored.posture.submittedThisTurn).toBe(true);
    expect(ignored.activeTurnId).toBe('turn-2');
    expect(ignored.pending.fileApprovals[0]?.changes[0]?.path).toBe('src/file.ts');
    expect(ignored.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'diag-2' })]),
    );
    expect(ignored.aggregateStats).toEqual(
      expect.objectContaining({ totalTokens: 99, outputTokens: 7, modelContextWindow: 200000 }),
    );
    expect(ignored.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'msg-2', type: 'agent_message', text: 'Hello' }),
        expect.objectContaining({
          id: 'tool-1',
          type: 'tool_call',
          name: 'bash',
          preview: 'npm test',
        }),
        expect.objectContaining({ type: 'framework_note', text: 'framework says hi' }),
      ]),
    );
  });

  it('converts compact rows to normalized transcript display fields without raw payloads', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [
        row({
          id: 'message-row',
          eventId: 'run-1:5',
          seq: 5,
          stateVisitId: 'workflow.collect#2',
          text: 'model text',
        }),
        row({
          id: 'reasoning-row',
          eventId: 'run-1:6',
          seq: 6,
          stateVisitId: 'workflow.collect#2',
          kind: 'reasoning',
          text: 'thinking',
        }),
        row({
          id: 'tool-row',
          eventId: 'run-1:7',
          seq: 7,
          stateVisitId: 'workflow.collect#2',
          itemId: 'tool-1',
          kind: 'tool',
          label: 'bash',
          status: 'completed',
          summary: 'pnpm test',
          elapsedMs: 42,
          data: { command: 'pnpm test -- --runInBand', raw: { hidden: true } },
        }),
        row({
          id: 'pending-tool-row',
          eventId: 'run-1:8',
          seq: 8,
          stateVisitId: 'workflow.collect#2',
          itemId: 'tool-pending',
          kind: 'tool',
          label: 'python',
          status: 'pending',
          summary: 'python script.py',
        }),
        row({
          id: 'failed-tool-row',
          eventId: 'run-1:9',
          seq: 9,
          stateVisitId: 'workflow.collect#2',
          itemId: 'tool-failed',
          kind: 'tool',
          label: 'eslint',
          status: 'failed',
          summary: 'lint failed',
          elapsedMs: 1200,
        }),
        row({
          id: 'subagent-row',
          eventId: 'run-1:10',
          seq: 10,
          stateVisitId: 'workflow.collect#2',
          itemId: 'subagent-1',
          kind: 'tool',
          label: 'spawn_agent',
          status: 'pending',
          summary: 'worker running',
          data: { itemType: 'spawnAgentToolCall' },
        }),
        row({
          id: 'request-row',
          eventId: 'run-1:11',
          seq: 11,
          stateVisitId: 'workflow.collect#2',
          kind: 'request',
          label: 'command approval',
          status: 'pending',
          summary: 'approve command',
        }),
        row({
          id: 'reply-submitted',
          eventId: 'run-1:12',
          seq: 12,
          stateVisitId: 'workflow.collect#2',
          kind: 'reply',
          label: 'approval',
          status: 'submitted',
          summary: 'request-1',
        }),
        row({
          id: 'reply-failed',
          eventId: 'run-1:13',
          seq: 13,
          stateVisitId: 'workflow.collect#2',
          kind: 'reply',
          label: 'approval',
          status: 'failed',
          summary: 'rejected',
        }),
        row({
          id: 'diagnostic-row',
          eventId: 'run-1:14',
          seq: 14,
          stateVisitId: 'workflow.collect#2',
          kind: 'diagnostic',
          label: 'abandoned',
          text: 'old thread ignored',
          status: 'warn',
        }),
        row({
          id: 'fresh-clear-row',
          eventId: 'run-1:15',
          seq: 15,
          stateVisitId: 'workflow.collect#2',
          kind: 'fresh_clear',
          label: 'workflow.collect',
          data: {
            previousThreadId: 'old-thread',
            nextThreadId: 'new-thread',
          },
        }),
        row({
          id: 'internal-tool',
          eventId: 'run-1:16',
          seq: 16,
          stateVisitId: 'workflow.collect#2',
          kind: 'tool',
          label: 'aharness_submit',
          status: 'completed',
          summary: '{}',
        }),
      ],
    });

    expect(state.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'message-row', type: 'agent_message', text: 'model text' }),
        expect.objectContaining({ id: 'reasoning-row', type: 'reasoning', text: 'thinking' }),
        expect.objectContaining({
          id: 'tool-1',
          type: 'tool_call',
          name: 'bash',
          preview: 'pnpm test -- --runInBand',
          elapsedMs: 42,
          category: 'tool',
        }),
        expect.objectContaining({
          id: 'tool-pending',
          type: 'tool_call',
          name: 'python',
          status: 'pending',
          preview: 'python script.py',
        }),
        expect.objectContaining({
          id: 'tool-failed',
          type: 'tool_call',
          name: 'eslint',
          status: 'failed',
          preview: 'lint failed',
          elapsedMs: 1200,
        }),
        expect.objectContaining({
          id: 'subagent-1',
          type: 'tool_call',
          category: 'subagent',
          preview: 'worker running',
        }),
        expect.objectContaining({
          id: 'request-row',
          type: 'compact_status',
          category: 'request',
          label: 'command approval',
          status: 'pending',
        }),
        expect.objectContaining({
          id: 'reply-submitted',
          type: 'compact_status',
          category: 'reply',
          status: 'submitted',
        }),
        expect.objectContaining({
          id: 'reply-failed',
          type: 'compact_status',
          category: 'reply',
          status: 'failed',
        }),
        expect.objectContaining({
          id: 'diagnostic-row',
          type: 'compact_status',
          category: 'diagnostic',
          summary: 'old thread ignored',
        }),
        expect.objectContaining({
          id: 'fresh-clear-row',
          type: 'fresh_clear_boundary',
          reason: 'clearOnEntry',
          previousThreadId: 'old-thread',
          nextThreadId: 'new-thread',
          statePath: 'workflow.collect',
        }),
      ]),
    );
    expect(JSON.stringify(state.transcript)).not.toContain('"raw"');
    expect(visibleItems(state.transcript, false)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'internal-tool' })]),
    );
    expect(visibleItems(state.transcript, true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'internal-tool' })]),
    );
  });

  it('updates parent aggregate token totals from parent token events and ignores sub-thread token events', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      aggregateStats: {
        turnCount: 1,
        totalTokens: 10,
        inputTokens: 8,
        modelContextWindow: 128000,
      },
    });
    const parentTokened = applyRunEvent(
      initial,
      apiEvent({
        type: 'token.updated',
        id: 'run-1:5',
        seq: 5,
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
      }),
    );
    const childTokened = applyRunEvent(
      parentTokened,
      apiEvent({
        type: 'subthread.token.updated',
        id: 'run-1:6',
        seq: 6,
        threadId: 'child-thread',
        turnId: 'child-turn',
        data: {
          total: {
            totalTokens: 999,
            inputTokens: 999,
            cachedInputTokens: 999,
            outputTokens: 999,
            reasoningOutputTokens: 999,
          },
          modelContextWindow: 300000,
        },
      }),
    );

    expect(parentTokened.aggregateStats).toEqual(
      expect.objectContaining({
        totalTokens: 25,
        inputTokens: 20,
        cachedInputTokens: 5,
        outputTokens: 4,
        reasoningOutputTokens: 1,
        modelContextWindow: 200000,
      }),
    );
    expect(childTokened.aggregateStats).toEqual(parentTokened.aggregateStats);
  });

  it('keeps historical row pages scoped to their own visits and idempotently merges duplicates by row id', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      currentStateVisit: {
        id: 'workflow.collect#2',
        path: 'workflow.collect',
        seq: 3,
        time: '2026-05-29T00:00:03.000Z',
        to: 'workflow.collect',
      },
      stateVisits: [
        {
          id: 'workflow.collect#1',
          path: 'workflow.collect',
          seq: 1,
          time: '2026-05-29T00:00:01.000Z',
          to: 'workflow.collect',
        },
        {
          id: 'workflow.collect#2',
          path: 'workflow.collect',
          seq: 3,
          time: '2026-05-29T00:00:03.000Z',
          to: 'workflow.collect',
        },
      ],
      statePathVisits: { 'workflow.collect': ['workflow.collect#1', 'workflow.collect#2'] },
      recentRows: [],
    });

    const visitOne = rowPage(
      [
        row({
          id: 'row-v1',
          eventId: 'run-1:2',
          seq: 2,
          stateVisitId: 'workflow.collect#1',
          text: 'first visit',
        }),
      ],
      'row-v1',
    );
    const visitTwo = rowPage([
      row({
        id: 'row-v2',
        eventId: 'run-1:4',
        seq: 4,
        stateVisitId: 'workflow.collect#2',
        text: 'second visit',
      }),
    ]);

    const loaded = applyVisitRowPage(
      applyVisitRowPage(initial, 'workflow.collect#1', visitOne),
      'workflow.collect#2',
      visitTwo,
    );
    const duplicate = applyVisitRowPage(loaded, 'workflow.collect#1', visitOne);

    expect(duplicate.activeVisitId).toBe('workflow.collect#2');
    expect(duplicate.rowPageCursors['workflow.collect#1']).toBe('row-v1');
    expect(duplicate.rowPageCursors['workflow.collect#2']).toBeNull();
    expect(duplicate.transcript.filter((item) => item.id === 'row-v1')).toHaveLength(1);
    expect(duplicate.transcript).toEqual([
      expect.objectContaining({ id: 'row-v1', stateVisitId: 'workflow.collect#1' }),
      expect.objectContaining({ id: 'row-v2', stateVisitId: 'workflow.collect#2' }),
    ]);
  });

  it('dedupes row pages against already-applied live events by canonical event id', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      currentStateVisit: {
        id: 'workflow.collect#2',
        path: 'workflow.collect',
        seq: 3,
        time: '2026-05-29T00:00:03.000Z',
        to: 'workflow.collect',
      },
      stateVisits: [
        {
          id: 'workflow.collect#2',
          path: 'workflow.collect',
          seq: 3,
          time: '2026-05-29T00:00:03.000Z',
          to: 'workflow.collect',
        },
      ],
      statePathVisits: { 'workflow.collect': ['workflow.collect#2'] },
      recentRows: [],
    });
    const live = applyRunEvent(
      initial,
      apiEvent({
        type: 'model.delta',
        id: 'run-1:8',
        seq: 8,
        stateVisitId: 'workflow.collect#2',
        itemId: 'msg-live',
        data: { itemId: 'msg-live', delta: 'Hello' },
      }),
    );
    const merged = applyVisitRowPage(
      live,
      'workflow.collect#2',
      rowPage([
        row({
          id: 'row-live',
          eventId: 'run-1:8',
          seq: 8,
          stateVisitId: 'workflow.collect#2',
          text: 'Hello',
        }),
      ]),
    );

    expect(
      merged.transcript.filter(
        (item) => item.eventId === 'run-1:8' || item.eventIds?.includes('run-1:8'),
      ),
    ).toHaveLength(1);
    expect(
      merged.transcript.filter((item) => item.type === 'agent_message' && item.text === 'Hello'),
    ).toHaveLength(1);
    expect(merged.transcript).toContainEqual(
      expect.objectContaining({ id: 'msg-live', eventIds: ['run-1:8'] }),
    );
  });

  it('ignores unsupported compact row kinds with bounded diagnostics instead of throwing', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: Array.from({ length: 30 }, (_, idx) => ({
        id: `unknown-${idx}`,
        eventId: `run-1:${idx + 10}`,
        seq: idx + 10,
        time: '2026-05-29T00:00:06.000Z',
        type: 'unknown.event',
        stateVisitId: 'workflow.collect#2',
        kind: 'not-renderable',
        summary: `unknown ${idx}`,
      })),
    });

    expect(state.transcript).toEqual([]);
    expect(
      state.diagnostics.filter((diagnostic) => diagnostic.source === 'compactRow'),
    ).toHaveLength(25);
  });

  it('remembers loaded row counts when row pages contain only unsupported compact rows', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [],
    });
    const state = applyVisitRowPage(
      initial,
      'workflow.collect#2',
      rowPage([
        row({
          id: 'unsupported-row',
          eventId: 'run-1:20',
          seq: 20,
          stateVisitId: 'workflow.collect#2',
          kind: 'not-renderable',
          summary: 'diagnostic only',
        }),
      ]),
    );

    expect(state.transcript).toEqual([]);
    expect(state.rowLoadStatus['workflow.collect#2']).toEqual({
      loading: false,
      loaded: true,
      error: null,
      storedRows: 1,
    });
    expect(state.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'compactRow' })]),
    );
  });

  it('recovers approval and owner-input buckets from bootstrap pending cards and leaves incomplete summaries as rows', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      pending: [
        ...runScopedBootstrap().pending,
        {
          requestId: 'cmd-1',
          status: 'pending',
          kind: 'command-approval',
          summary: 'npm test',
          createdAt: '2026-05-29T00:00:04.000Z',
          updatedAt: '2026-05-29T00:00:04.000Z',
          lastEventId: 'run-1:5',
          pendingCard: {
            kind: 'command-approval',
            id: 'cmd-1',
            requestId: 'cmd-1',
            method: 'item/commandExecution/requestApproval',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'cmd-1',
            command: 'npm test',
            cwd: '/repo',
          },
        },
        {
          requestId: 'summary-only',
          status: 'pending',
          kind: 'file-approval',
          summary: 'not enough fields',
          createdAt: '2026-05-29T00:00:04.000Z',
          updatedAt: '2026-05-29T00:00:04.000Z',
          lastEventId: 'run-1:6',
        },
      ],
      recentRows: [
        {
          id: 'request-row',
          eventId: 'run-1:6',
          seq: 6,
          time: '2026-05-29T00:00:06.000Z',
          type: 'request.created',
          stateVisitId: 'workflow.collect#2',
          kind: 'request',
          summary: 'not enough fields',
        },
      ],
    });

    expect(state.pending.ownerInput?.id).toBe('owner-1');
    expect(state.pending.cmdApprovals[0]).toEqual(
      expect.objectContaining({ id: 'cmd-1', command: 'npm test' }),
    );
    expect(state.pending.fileApprovals).toEqual([]);
    expect(state.transcript).toContainEqual(
      expect.objectContaining({
        id: 'request-row',
        type: 'compact_status',
        category: 'request',
        summary: 'not enough fields',
      }),
    );
  });

  it('recovers open and awaiting posture from bootstrap and keeps terminal runs terminal after stream close', () => {
    const open = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      posture: { isTerminal: false, isAwaiting: false, submittedThisTurn: false, open: true },
    });
    const awaiting = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      posture: { isTerminal: false, isAwaiting: true, submittedThisTurn: false, open: false },
    });
    const terminal = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      currentState: { path: 'workflow.done', kind: 'terminal', visitCount: 1 },
      currentStateVisit: {
        id: 'workflow.done#1',
        path: 'workflow.done',
        seq: 5,
        time: '2026-05-29T00:00:05.000Z',
        to: 'workflow.done',
      },
      posture: { isTerminal: true, isAwaiting: false, submittedThisTurn: false, open: false },
    });

    expect(open.posture.open).toBe(true);
    expect(awaiting.posture.isAwaiting).toBe(true);
    expect(markConnectionLost(terminal).connection).toBe('live');
    expect(markConnectionLost(terminal).posture.isTerminal).toBe(true);
  });

  it('hydrates UI state from the /api/state snapshot contract', () => {
    const state = hydrateFromSnapshot(snapshot());

    expect(state.connection).toBe('live');
    expect(state.run?.runId).toBe('run-1');
    expect(state.state).toEqual(currentState);
    expect(state.topology).toEqual({ machineId: '', initial: '', nodes: [], edges: [] });
    expect(state.activeVisitId).toBe('workflow.collect#2');
    expect(state.activeTurnId).toBeNull();
    expect(state.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-1',
          type: 'agent_message',
          text: 'Hello',
          streaming: false,
          stateVisitId: 'workflow.collect#2',
        }),
        expect.objectContaining({
          id: 'note-1',
          type: 'framework_note',
          text: 'note',
          variant: 'warn',
          stateVisitId: 'workflow.collect#2',
        }),
      ]),
    );
    expect(state.turns).toEqual([
      expect.objectContaining({
        turnId: 'turn-1',
        finishReason: 'stop',
        stateVisitId: 'workflow.collect#2',
      }),
    ]);
  });

  it('tracks active turns so quiet model work is visible', () => {
    const withTurn = applyAppEvent(hydrateFromSnapshot(snapshot()), {
      kind: 'TurnStarted',
      turnId: 'turn-active',
    });

    expect(withTurn.activeTurnId).toBe('turn-active');
    expect(deriveActivity(withTurn)).toEqual(
      expect.objectContaining({
        kind: 'thinking',
        label: 'model working',
      }),
    );

    const completed = applyAppEvent(withTurn, {
      kind: 'TurnCompleted',
      turnId: 'turn-active',
      finishReason: 'stop',
    });
    expect(completed.activeTurnId).toBeNull();
  });

  it('renders non-reserved tool calls while hiding aharness internal submit calls by default', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const withTool = applyAppEvent(initial, {
      kind: 'ItemStarted',
      id: 'tool-1',
      type: 'function_call',
      name: 'mcp:github/create_issue',
      arguments: '{"title":"bug"}',
    });
    const withInternal = applyAppEvent(withTool, {
      kind: 'ItemStarted',
      id: 'tool-2',
      type: 'function_call',
      name: 'mcp__aharness_fsm__submit',
      arguments: '{}',
    });

    expect(visibleItems(withInternal.transcript, false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call',
          name: 'mcp:github/create_issue',
          preview: '{"title":"bug"}',
          reserved: false,
        }),
      ]),
    );
    expect(visibleItems(withInternal.transcript, false)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call',
          name: 'mcp__aharness_fsm__submit',
        }),
      ]),
    );
  });

  it('hydrates topology from the /api/state snapshot contract', () => {
    const state = hydrateFromSnapshot({
      ...snapshot(),
      state: {
        ...snapshot().state,
        topology,
      },
    });

    expect(state.topology).toEqual(topology);
  });

  it('hydrates inspect-mode snapshots with dev mode enabled by default', () => {
    const state = hydrateFromSnapshot({
      ...snapshot(),
      state: {
        ...snapshot().state,
        mode: 'inspect',
        topology,
      },
    });

    expect(state.mode).toBe('inspect');
    expect(state.devMode).toBe(true);
    expect(state.topology).toEqual(topology);
  });

  it('hydrates abandoned-thread diagnostics from the /api/state snapshot contract', () => {
    const state = hydrateFromSnapshot({
      ...snapshot(),
      state: {
        ...snapshot().state,
        diagnostics: [
          {
            kind: 'AbandonedThreadDiagnostic',
            id: 'diag-1',
            threadId: 'thread-old',
            source: 'turnCompleted',
            message: 'ignored old turn',
          },
        ],
      },
    });

    expect(state.diagnostics).toEqual([
      expect.objectContaining({ id: 'diag-1', source: 'turnCompleted' }),
    ]);
    expect(state.transcript.some((item) => item.id === 'diag-1')).toBe(false);
  });

  it('hydrates pending owner input from the /api/state snapshot contract', () => {
    const state = hydrateFromSnapshot({
      ...snapshot(),
      state: {
        ...snapshot().state,
        pending: {
          ownerInput: {
            kind: 'ServerRequest',
            id: 'owner-1',
            method: 'item/tool/requestUserInput',
            questions: [
              {
                id: 'q1',
                header: 'Next',
                question: 'What now?',
                isOther: false,
                isSecret: false,
              },
            ],
          },
        },
      },
    });

    expect(state.pending.ownerInput?.id).toBe('owner-1');
    expect(state.pending.ownerInput?.questions[0]?.question).toBe('What now?');
  });

  it('hydrates approval buckets from the /api/state snapshot contract', () => {
    const state = hydrateFromSnapshot({
      ...snapshot(),
      state: {
        ...snapshot().state,
        pending: {
          ownerInput: null,
          fileApprovals: [
            {
              kind: 'ServerRequest',
              id: 'patch-1',
              requestId: 'patch-1',
              method: 'item/fileChange/requestApproval',
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'patch-1',
              changes: [{ path: 'src/file.ts', kind: { type: 'add' }, diff: '+x\n' }],
            },
          ],
          cmdApprovals: [],
          permissionApprovals: [],
          elicitations: [],
        },
      },
    });

    expect(state.pending.fileApprovals[0]?.changes[0]?.path).toBe('src/file.ts');
  });

  it('applies streamed StateChange events to transition state and history', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const state = applyAppEvent(initial, {
      kind: 'StateChange',
      from: 'workflow.collect',
      to: 'workflow.review',
      cause: 'submit',
      newState: nextState,
    });

    expect(state.state).toEqual(nextState);
    expect(state.activeVisitId).toBe('workflow.review#1');
    expect(state.scopedPath).toBeNull();
    expect(state.history).toContainEqual(
      expect.objectContaining({
        from: 'workflow.collect',
        to: 'workflow.review',
        cause: 'submit',
        visitId: 'workflow.review#1',
      }),
    );
  });

  it('accumulates streamed AgentMessageDelta payloads by transcript id', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const state = applyAppEvent(initial, {
      kind: 'AgentMessageDelta',
      id: 'agent-1',
      delta: ' world',
      reasoning: false,
    });

    expect(state.transcript).toContainEqual(
      expect.objectContaining({
        id: 'agent-1',
        type: 'agent_message',
        text: 'Hello world',
        streaming: true,
      }),
    );
  });

  it('creates streamed AgentMessageDelta transcript entries when the id is new', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const first = applyAppEvent(initial, {
      kind: 'AgentMessageDelta',
      id: 'reasoning-1',
      delta: 'Thinking',
      reasoning: true,
    });
    const state = applyAppEvent(first, {
      kind: 'AgentMessageDelta',
      id: 'reasoning-1',
      delta: ' aloud',
      reasoning: true,
    });

    expect(state.transcript).toContainEqual(
      expect.objectContaining({
        id: 'reasoning-1',
        type: 'reasoning',
        text: 'Thinking aloud',
        streaming: true,
        stateVisitId: 'workflow.collect#2',
      }),
    );
  });

  it('merges streamed PostureChange payloads into posture without dropping existing fields', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const state = applyAppEvent(initial, {
      kind: 'PostureChange',
      posture: {
        isAwaiting: true,
        submittedThisTurn: true,
      },
    });

    expect(state.posture).toEqual({
      ...posture,
      isAwaiting: true,
      submittedThisTurn: true,
    });
  });

  it('hydrates pending owner composer from streamed owner-input ServerRequest events', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const state = applyAppEvent(initial, {
      kind: 'ServerRequest',
      id: 'owner-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Next',
          question: 'What now?',
          isOther: false,
          isSecret: false,
        },
      ],
    });

    expect(state.pending.ownerInput?.id).toBe('owner-1');
    expect(state.pending.ownerInput?.questions[0]?.id).toBe('q1');
    expect(state.posture.isAwaiting).toBe(true);
  });

  it('clears matching pending owner input from streamed OwnerInputResolved events', () => {
    const withPending = applyAppEvent(hydrateFromSnapshot(snapshot()), {
      kind: 'ServerRequest',
      id: 'owner-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Next',
          question: 'What now?',
          isOther: false,
          isSecret: false,
        },
      ],
    });

    const state = applyAppEvent(withPending, {
      kind: 'OwnerInputResolved',
      id: 'owner-1',
    });

    expect(state.pending.ownerInput).toBeNull();
    expect(state.posture.isAwaiting).toBe(false);
  });

  it('updates and resolves streamed approval requests', () => {
    const withApproval = applyAppEvent(hydrateFromSnapshot(snapshot()), {
      kind: 'ServerRequest',
      id: 'patch-1',
      requestId: 'patch-1',
      method: 'item/fileChange/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [],
    });
    const updated = applyAppEvent(withApproval, {
      kind: 'FileApprovalUpdated',
      id: 'patch-1',
      requestId: 'patch-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [{ path: 'src/file.ts', kind: { type: 'add' }, diff: '+x\n' }],
    });

    expect(updated.pending.fileApprovals[0]?.changes).toEqual([
      { path: 'src/file.ts', kind: { type: 'add' }, diff: '+x\n' },
    ]);

    const resolved = applyAppEvent(updated, {
      kind: 'ApprovalRequestResolved',
      id: 'patch-1',
      requestId: 'patch-1',
    });

    expect(resolved.pending.fileApprovals).toEqual([]);
  });

  it('reduces FreshClearBoundary to a boundary marker and clears active conversation surfaces', () => {
    const withConversation = applyAppEvent(
      applyAppEvent(
        applyAppEvent(hydrateFromSnapshot(snapshot()), {
          kind: 'AgentMessageDelta',
          id: 'agent-old',
          delta: 'old text',
        }),
        {
          kind: 'ServerRequest',
          id: 'owner-old',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Next',
              question: 'What now?',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      ),
      { kind: 'TurnCompleted', turnId: 'turn-old', finishReason: 'stop' },
    );

    const state = applyAppEvent(withConversation, {
      kind: 'FreshClearBoundary',
      id: 'fresh-1',
      reason: 'clearOnEntry',
      previousThreadId: 'thread-old',
      nextThreadId: 'thread-new',
      statePath: 'workflow.collect',
    });

    expect(state.transcript).toEqual([
      expect.objectContaining({
        id: 'fresh-1',
        type: 'fresh_clear_boundary',
        previousThreadId: 'thread-old',
        nextThreadId: 'thread-new',
      }),
    ]);
    expect(state.pending).toEqual({
      fileApprovals: [],
      cmdApprovals: [],
      permissionApprovals: [],
      elicitations: [],
      ownerInput: null,
    });
    expect(state.turns).toEqual([]);
    expect(state.posture.isAwaiting).toBe(false);
  });

  it('stores AbandonedThreadDiagnostic separately from visible transcript items', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const state = applyAppEvent(initial, {
      kind: 'AbandonedThreadDiagnostic',
      id: 'diag-1',
      threadId: 'thread-old',
      source: 'agentMessageDelta',
      message: 'ignored old delta',
    });

    expect(state.diagnostics).toEqual([
      expect.objectContaining({ id: 'diag-1', threadId: 'thread-old' }),
    ]);
    expect(state.transcript).toEqual(initial.transcript);
    expect(visibleItems(state.transcript, true)).toEqual(visibleItems(initial.transcript, true));
  });

  it('marks the connection lost when the stream adapter reports a lost connection', () => {
    const state = markConnectionLost(createConnectingUiState());

    expect(state.connection).toBe('lost');
    expect(state.run).toBeNull();
    expect(state.state).toBeNull();
    expect(state.topology.nodes).toHaveLength(0);
  });

  it('keeps terminal runs in the terminal view after the stream closes', () => {
    const terminal = applyAppEvent(hydrateFromSnapshot(snapshot()), {
      kind: 'StateChange',
      from: 'writeVictoryArtifact',
      to: 'victory',
      cause: 'submit',
      newState: {
        path: 'victory',
        leaf: 'victory',
        kind: 'terminal',
        exits: [],
        visitCount: 1,
      },
    });

    const state = markConnectionLost(terminal);

    expect(state.connection).toBe('live');
    expect(state.posture.isTerminal).toBe(true);
    expect(state.state?.path).toBe('victory');
  });

  it('returns the connection to live when hydrating after a lost connection', () => {
    const lost = markConnectionLost(createConnectingUiState());
    const state = hydrateFromSnapshot(snapshot());

    expect(lost.connection).toBe('lost');
    expect(state.connection).toBe('live');
  });

  it('returns the connection to live when a valid event arrives after a lost connection', () => {
    const lost = markConnectionLost(hydrateFromSnapshot(snapshot()));
    const state = applyAppEvent(lost, {
      kind: 'PostureChange',
      posture: { open: true },
    });

    expect(lost.connection).toBe('lost');
    expect(state.connection).toBe('live');
    expect(state.posture.open).toBe(true);
  });

  it('keeps the production entry import graph isolated from fixture modules', () => {
    const srcRoot = resolve(process.cwd(), 'packages/web-ui/src');
    const productionEntry = join(srcRoot, 'main.tsx');
    const visited = collectLocalImports(productionEntry, srcRoot);
    const fixtureImports = visited
      .map((file) => normalize(relative(srcRoot, file)))
      .filter((file) => file.startsWith('fixtures/'));

    expect(fixtureImports).toEqual([]);
  });
});

const importSpecifierPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"](?<specifier>\.{1,2}\/[^'"]+)['"]/g;

function collectLocalImports(entry: string, srcRoot: string): string[] {
  const visited = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importSpecifierPattern)) {
      const specifier = match.groups?.['specifier'];
      if (!specifier) continue;

      const imported = resolveImport(dirname(file), specifier, srcRoot);
      if (imported && !visited.has(imported)) {
        pending.push(imported);
      }
    }
  }

  return Array.from(visited).sort();
}

function resolveImport(fromDir: string, specifier: string, srcRoot: string): string | null {
  const candidate = resolve(fromDir, specifier);
  const relativeToRoot = relative(srcRoot, candidate);
  if (relativeToRoot.startsWith('..') || relativeToRoot === '') {
    return null;
  }

  for (const resolved of candidatePaths(candidate)) {
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      return resolved;
    }
  }

  return null;
}

function candidatePaths(candidate: string): string[] {
  return [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.jsx`,
    join(candidate, 'index.ts'),
    join(candidate, 'index.tsx'),
  ];
}
