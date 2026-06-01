import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRecentRowPage,
  applyRunEvent,
  applyVisitRowPage,
  createConnectingUiState,
  displayItems,
  hasVisibleContent,
  hydrateFromBootstrap,
  markConnectionLost,
  visibleItems,
} from './store.js';
import { applyAppEvent, hydrateFromSnapshot } from './legacyFlatEvents.js';
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
  isRunScopedEventPage,
  isRunScopedRowPage,
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
      context: { draft: 'boot' },
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

function currentContractReplayEvents(): RunScopedApiEvent[] {
  return [
    apiEvent({
      id: 'run-1:1',
      seq: 1,
      type: 'run.started',
      data: { startedAt: '2026-05-29T00:00:01.000Z' },
    }),
    apiEvent({
      id: 'run-1:2',
      seq: 2,
      type: 'state.changed',
      stateVisitId: 'workflow.collect#2',
      data: {
        from: null,
        to: 'workflow.collect',
        cause: 'boot',
        stateVisitId: 'workflow.collect#2',
        path: 'workflow.collect',
        leaf: 'collect',
        kind: 'stateful',
        visitCount: 2,
        exits: [{ name: 'continue', kind: 'submit' }],
      },
    }),
    apiEvent({
      id: 'run-1:3',
      seq: 3,
      type: 'framework.note',
      stateVisitId: 'workflow.collect#2',
      data: {
        row: {
          id: 'framework-orientation',
          kind: 'framework_note',
          status: 'orientation',
          text: 'You have entered `workflow.collect`.',
        },
      },
    }),
    apiEvent({
      id: 'run-1:4',
      seq: 4,
      type: 'item.started',
      stateVisitId: 'workflow.collect#2',
      itemId: 'orientation-message',
      data: {
        row: {
          id: 'orientation-envelope',
          kind: 'message',
          label: 'userMessage',
          itemId: 'orientation-message',
          text: '[aharness] Now in state "workflow.collect".',
        },
      },
    }),
    apiEvent({
      id: 'run-1:5',
      seq: 5,
      type: 'item.started',
      stateVisitId: 'workflow.collect#2',
      itemId: 'assistant-message-1',
      data: {
        row: {
          id: 'assistant-start-envelope',
          kind: 'message',
          label: 'agentMessage',
          itemId: 'assistant-message-1',
        },
      },
    }),
    apiEvent({
      id: 'run-1:6',
      seq: 6,
      type: 'model.delta',
      stateVisitId: 'workflow.collect#2',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: { delta: 'Draft answer' },
    }),
    apiEvent({
      id: 'run-1:7',
      seq: 7,
      type: 'model.delta',
      stateVisitId: 'workflow.collect#2',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: { delta: ' in flight' },
    }),
    apiEvent({
      id: 'run-1:8',
      seq: 8,
      type: 'item.completed',
      stateVisitId: 'workflow.collect#2',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: {
        row: {
          id: 'assistant-completed-row',
          kind: 'message',
          label: 'agentMessage',
          itemId: 'assistant-message-1',
          text: 'Final assistant answer.',
        },
      },
    }),
    apiEvent({
      id: 'run-1:9',
      seq: 9,
      type: 'item.started',
      stateVisitId: 'workflow.collect#2',
      itemId: 'reasoning-1',
      data: {
        row: {
          id: 'empty-reasoning-envelope',
          kind: 'reasoning',
          label: 'reasoning',
          itemId: 'reasoning-1',
        },
      },
    }),
    apiEvent({
      id: 'run-1:10',
      seq: 10,
      type: 'item.completed',
      stateVisitId: 'workflow.collect#2',
      turnId: 'turn-1',
      itemId: 'command-1',
      data: {
        row: {
          id: 'command-row',
          kind: 'tool',
          label: 'bash',
          itemId: 'command-1',
          status: 'completed',
          summary: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
          elapsedMs: 1234,
          output: 'line 1\nline 2\nline 3',
          data: {
            displayKind: 'command',
            command: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
          },
        },
      },
    }),
  ];
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
      context: { draft: 'boot' },
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
    expect(isRunScopedBootstrap({ ...bootstrap, raw: { hidden: true } })).toBe(false);
    expect(
      isRunScopedBootstrap({
        ...bootstrap,
        pending: [{ ...bootstrap.pending[0], pendingCard: { kind: 'unknown' } }],
      }),
    ).toBe(false);
    expect(
      isRunScopedRowPage({
        rows: [{ ...bootstrap.recentRows[0], raw: { hidden: true } }],
        nextCursor: null,
      }),
    ).toBe(false);
    expect(
      isRunScopedEventPage({
        events: [{ ...apiEvent(), raw: { hidden: true } }],
        nextCursor: null,
        diagnostics: [],
      }),
    ).toBe(false);
  });

  it('applies canonical run events across state, posture, turn, message, request, diagnostic, token, and ignored classes', () => {
    const initial = hydrateFromBootstrap(runScopedBootstrap());
    const contextChanged = applyRunEvent(
      initial,
      apiEvent({
        type: 'context.changed',
        id: 'run-1:5',
        seq: 5,
        data: { context: { draft: 'live', count: 2 } },
      }),
    );
    const stateChanged = applyRunEvent(
      contextChanged,
      apiEvent({
        type: 'state.changed',
        id: 'run-1:6',
        seq: 6,
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
    expect(contextChanged.state?.context).toEqual({ draft: 'live', count: 2 });
    expect(stateChanged.state).toEqual(
      expect.objectContaining({
        path: 'workflow.review',
        context: { draft: 'live', count: 2 },
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
    const completedTool = applyRunEvent(
      tooled,
      apiEvent({
        type: 'item.completed',
        id: 'run-1:10',
        seq: 10,
        stateVisitId: 'workflow.review#1',
        itemId: 'tool-1',
        data: {
          row: {
            kind: 'tool',
            label: 'bash',
            status: 'completed',
            summary: 'npm test',
            output: 'all tests passed',
            ok: true,
            resultId: 'tool-1:output',
          },
        },
      }),
    );
    const requested = applyRunEvent(
      completedTool,
      apiEvent({
        type: 'request.created',
        id: 'run-1:11',
        seq: 11,
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
        id: 'run-1:12',
        seq: 12,
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
        id: 'run-1:13',
        seq: 13,
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
        id: 'run-1:14',
        seq: 14,
        data: { total: { totalTokens: 99, outputTokens: 7 }, modelContextWindow: 200000 },
      }),
    );
    const ignored = applyRunEvent(
      tokened,
      apiEvent({
        type: 'artifact.written',
        id: 'run-1:15',
        seq: 15,
        data: { artifactId: 'a-1' },
      }),
    );

    expect(ignored.latestEventId).toBe('run-1:15');
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
          status: 'completed',
          output: 'all tests passed',
          ok: true,
          resultId: 'tool-1:output',
        }),
        expect.objectContaining({ type: 'framework_note', text: 'framework says hi' }),
      ]),
    );
  });

  it('stores context events before the first state and attaches them to later state changes', () => {
    const connecting = createConnectingUiState();
    const contextInitialized = applyRunEvent(
      connecting,
      apiEvent({
        type: 'context.initialized',
        id: 'run-1:1',
        seq: 1,
        data: { context: { draft: 'early' } },
      }),
    );

    expect(contextInitialized.state).toBeNull();

    const stateChanged = applyRunEvent(
      contextInitialized,
      apiEvent({
        type: 'state.changed',
        id: 'run-1:2',
        seq: 2,
        stateVisitId: 'workflow.collect#1',
        data: {
          path: 'workflow.collect',
          leaf: 'collect',
          kind: 'stateful',
          visitCount: 1,
          exits: [{ name: 'continue', kind: 'submit' }],
        },
      }),
    );

    expect(stateChanged.state).toEqual(
      expect.objectContaining({
        path: 'workflow.collect',
        context: { draft: 'early' },
      }),
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
          turnId: 'turn-compact-1',
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
          output: 'command completed',
          ok: true,
          resultId: 'tool-1:output',
          turnId: 'turn-compact-1',
          data: {
            command: 'pnpm test -- --runInBand',
            argumentsPreview: '-- --runInBand',
            displayKind: 'command',
            target: 'packages/web-ui',
            raw: { hidden: true },
          },
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
          data: {
            itemType: 'spawnAgentToolCall',
            displayKind: 'subagent',
            subagentAction: 'spawn',
            agentNickname: 'planner',
            agentRole: 'implementation',
            receiverThreadIds: ['thread-a', 'thread-b'],
            promptPreview: 'Implement the slice',
            responsePreview: 'Done',
            errorPreview: 'No error',
          },
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
          id: 'state-meta-row',
          eventId: 'run-1:16',
          seq: 16,
          stateVisitId: 'workflow.collect#2',
          turnId: 'turn-compact-1',
          kind: 'state_change',
          label: 'workflow.review',
          status: 'submit',
          summary: 'workflow.collect -> workflow.review',
          data: {
            from: 'workflow.collect',
            to: 'workflow.review',
            cause: 'submit',
            visitCount: 3,
            stateKind: 'stateful',
            open: true,
            awaiting: false,
            model: 'gpt-5',
            effort: 'high',
            raw: { hidden: true },
          },
        }),
        row({
          id: 'state-invalid-row',
          eventId: 'run-1:17',
          seq: 17,
          stateVisitId: 'workflow.collect#2',
          kind: 'state_change',
          label: 'workflow.invalid',
          data: {
            visitCount: '3',
            stateKind: 12,
            open: 'yes',
            awaiting: 'no',
            model: '',
            effort: null,
          },
        }),
        row({
          id: 'transition-failure-row',
          eventId: 'run-1:18',
          seq: 18,
          stateVisitId: 'workflow.collect#2',
          kind: 'transition_failure',
          summary: 'Submit failed safely',
          data: {
            toolName: 'aharness_submit',
            state: 'workflow.collect',
            exit: 'continue',
            raw: { hidden: true },
          },
        }),
        row({
          id: 'lifecycle-row',
          eventId: 'run-1:19',
          seq: 19,
          stateVisitId: 'workflow.collect#2',
          kind: 'run_lifecycle',
          label: 'run',
          status: 'started',
          summary: 'run started',
          elapsedMs: 12,
        }),
        row({
          id: 'internal-tool',
          eventId: 'run-1:20',
          seq: 20,
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
        expect.objectContaining({
          id: 'message-row',
          type: 'agent_message',
          text: 'model text',
          turnId: 'turn-compact-1',
        }),
        expect.objectContaining({ id: 'reasoning-row', type: 'reasoning', text: 'thinking' }),
        expect.objectContaining({
          id: 'tool-1',
          type: 'tool_call',
          name: 'bash',
          preview: 'pnpm test -- --runInBand',
          elapsedMs: 42,
          category: 'tool',
          turnId: 'turn-compact-1',
          displayKind: 'command',
          command: 'pnpm test -- --runInBand',
          argumentsPreview: '-- --runInBand',
          target: 'packages/web-ui',
          output: 'command completed',
          ok: true,
          resultId: 'tool-1:output',
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
          displayKind: 'subagent',
          subagentAction: 'spawn',
          agentNickname: 'planner',
          agentRole: 'implementation',
          receiverThreadIds: ['thread-a', 'thread-b'],
          promptPreview: 'Implement the slice',
          responsePreview: 'Done',
          errorPreview: 'No error',
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
        expect.objectContaining({
          id: 'state-meta-row',
          type: 'state_change',
          turnId: 'turn-compact-1',
          from: 'workflow.collect',
          to: 'workflow.review',
          cause: 'submit',
          visitCount: 3,
          stateKind: 'stateful',
          open: true,
          awaiting: false,
          model: 'gpt-5',
          effort: 'high',
        }),
        expect.objectContaining({
          id: 'state-invalid-row',
          type: 'state_change',
          to: 'workflow.invalid',
        }),
        expect.objectContaining({
          id: 'transition-failure-row',
          type: 'transition_failure',
          summary: 'Submit failed safely',
          status: 'failed',
          toolName: 'aharness_submit',
          state: 'workflow.collect',
          exit: 'continue',
        }),
        expect.objectContaining({
          id: 'lifecycle-row',
          type: 'compact_status',
          category: 'lifecycle',
          label: 'run',
          status: 'started',
          summary: 'run started',
          elapsedMs: 12,
        }),
      ]),
    );
    const invalidStateRow = state.transcript.find((item) => item.id === 'state-invalid-row');
    expect(invalidStateRow).toEqual(
      expect.objectContaining({ id: 'state-invalid-row', type: 'state_change' }),
    );
    expect(invalidStateRow).not.toHaveProperty('visitCount');
    expect(invalidStateRow).not.toHaveProperty('stateKind');
    expect(invalidStateRow).not.toHaveProperty('open');
    expect(invalidStateRow).not.toHaveProperty('awaiting');
    expect(invalidStateRow).not.toHaveProperty('model');
    expect(invalidStateRow).not.toHaveProperty('effort');
    expect(JSON.stringify(state.transcript)).not.toContain('"raw"');
    expect(visibleItems(state.transcript, false)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'internal-tool' })]),
    );
    expect(visibleItems(state.transcript, true)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'internal-tool' })]),
    );
  });

  it('normalizes current compact message labels and suppresses empty message envelopes', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      mode: 'run',
      recentRows: [
        row({
          id: 'orientation-row',
          eventId: 'run-1:30',
          seq: 30,
          stateVisitId: 'workflow.collect#2',
          kind: 'message',
          label: 'userMessage',
          text: '[aharness] Now in state "workflow.collect".',
        }),
        row({
          id: 'empty-agent-row',
          eventId: 'run-1:31',
          seq: 31,
          stateVisitId: 'workflow.collect#2',
          kind: 'message',
          label: 'agentMessage',
          text: undefined,
        }),
        row({
          id: 'empty-agent-summary-row',
          eventId: 'run-1:32',
          seq: 32,
          stateVisitId: 'workflow.collect#2',
          kind: 'message',
          label: 'agentMessage',
          text: undefined,
          summary: 'agent summary',
        }),
        row({
          id: 'assistant-row',
          eventId: 'run-1:33',
          seq: 33,
          stateVisitId: 'workflow.collect#2',
          kind: 'message',
          label: 'assistant',
          text: 'assistant text',
        }),
      ],
    });

    expect(state.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'orientation-row',
          type: 'user_message',
          text: '[aharness] Now in state "workflow.collect".',
          synthetic: true,
        }),
        expect.objectContaining({
          id: 'assistant-row',
          type: 'agent_message',
          text: 'assistant text',
        }),
      ]),
    );
    expect(state.transcript).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'empty-agent-row' }),
        expect.objectContaining({ id: 'empty-agent-summary-row' }),
        expect.objectContaining({ text: 'agentMessage' }),
        expect.objectContaining({ text: 'agent summary' }),
      ]),
    );
    expect(visibleItems(state.transcript, false)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'orientation-row' })]),
    );
    expect(visibleItems(state.transcript, true)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'orientation-row' })]),
    );
    expect(state.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'compactRow' })]),
    );
  });

  it('suppresses empty compact reasoning envelopes instead of rendering labels or summaries', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [
        row({
          id: 'empty-reasoning-label',
          eventId: 'run-1:33',
          seq: 33,
          stateVisitId: 'workflow.collect#2',
          kind: 'reasoning',
          label: 'reasoning',
          text: undefined,
        }),
        row({
          id: 'empty-reasoning-summary',
          eventId: 'run-1:34',
          seq: 34,
          stateVisitId: 'workflow.collect#2',
          kind: 'reasoning',
          text: undefined,
          summary: 'reasoning summary',
        }),
        row({
          id: 'reasoning-text',
          eventId: 'run-1:35',
          seq: 35,
          stateVisitId: 'workflow.collect#2',
          kind: 'reasoning',
          label: 'reasoning',
          summary: 'ignored summary',
          text: 'actual reasoning',
        }),
      ],
    });

    expect(state.transcript).toEqual([
      expect.objectContaining({
        id: 'reasoning-text',
        type: 'reasoning',
        text: 'actual reasoning',
      }),
    ]);
    expect(state.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'compactRow' })]),
    );
  });

  it('ignores protocol dynamic-tool compact rows without rendering submit tools or diagnostics', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [
        row({
          id: 'submit-started-row',
          eventId: 'run-1:36',
          seq: 36,
          stateVisitId: 'workflow.collect#2',
          kind: 'dynamicToolCall',
          label: 'dynamicToolCall',
          status: 'started',
        }),
        row({
          id: 'submit-tool-row',
          eventId: 'run-1:37',
          seq: 37,
          stateVisitId: 'workflow.collect#2',
          kind: 'tool',
          label: 'aharness_submit',
          status: 'completed',
          summary: '{}',
        }),
      ],
    });

    expect(state.transcript).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'submit-started-row' })]),
    );
    expect(visibleItems(state.transcript, false)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'submit-tool-row' })]),
    );
    expect(visibleItems(state.transcript, true)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'submit-tool-row' })]),
    );
    expect(state.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'compactRow' })]),
    );
  });

  it('accepts only known tool display hints and subagent actions from compact rows', () => {
    const displayKinds = ['command', 'read', 'list', 'search', 'mcp', 'subagent', 'tool'] as const;
    const subagentActions = ['spawn', 'send', 'wait', 'resume', 'close'] as const;
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [
        ...displayKinds.map((displayKind, index) =>
          row({
            id: `display-${displayKind}`,
            eventId: `run-1:${index + 30}`,
            seq: index + 30,
            stateVisitId: 'workflow.collect#2',
            itemId: `display-${displayKind}`,
            kind: 'tool',
            label: 'tool',
            status: 'completed',
            data: { displayKind },
          }),
        ),
        ...subagentActions.map((subagentAction, index) =>
          row({
            id: `subagent-${subagentAction}`,
            eventId: `run-1:${index + 40}`,
            seq: index + 40,
            stateVisitId: 'workflow.collect#2',
            itemId: `subagent-${subagentAction}`,
            kind: 'tool',
            label: 'spawn_agent',
            status: 'completed',
            data: { itemType: 'spawnAgentToolCall', subagentAction },
          }),
        ),
        row({
          id: 'unknown-display',
          eventId: 'run-1:50',
          seq: 50,
          stateVisitId: 'workflow.collect#2',
          itemId: 'unknown-display',
          kind: 'tool',
          label: 'tool',
          status: 'completed',
          data: { displayKind: 'future-kind', subagentAction: 'future-action' },
        }),
      ],
    });

    for (const displayKind of displayKinds) {
      expect(state.transcript).toContainEqual(
        expect.objectContaining({ id: `display-${displayKind}`, displayKind }),
      );
    }
    for (const subagentAction of subagentActions) {
      expect(state.transcript).toContainEqual(
        expect.objectContaining({ id: `subagent-${subagentAction}`, subagentAction }),
      );
    }
    const unknown = state.transcript.find((item) => item.id === 'unknown-display');
    expect(unknown).toEqual(expect.objectContaining({ type: 'tool_call', name: 'tool' }));
    expect(unknown).not.toHaveProperty('displayKind');
    expect(unknown).not.toHaveProperty('subagentAction');
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

  it('coalesces streamed model deltas with the completed compact message item', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [],
    });
    const started = applyRunEvent(
      initial,
      apiEvent({
        type: 'item.started',
        id: 'run-1:7',
        seq: 7,
        stateVisitId: 'workflow.collect#2',
        itemId: 'msg-1',
        data: {
          row: {
            id: 'msg-1-started-row',
            kind: 'message',
            label: 'agentMessage',
            itemId: 'msg-1',
            stateVisitId: 'workflow.collect#2',
          },
        },
      }),
    );
    const streaming = applyRunEvent(
      started,
      apiEvent({
        type: 'model.delta',
        id: 'run-1:8',
        seq: 8,
        stateVisitId: 'workflow.collect#2',
        itemId: 'msg-1',
        data: { itemId: 'msg-1', delta: 'draft answer' },
      }),
    );
    const completed = applyRunEvent(
      streaming,
      apiEvent({
        type: 'item.completed',
        id: 'run-1:9',
        seq: 9,
        stateVisitId: 'workflow.collect#2',
        itemId: 'msg-1',
        data: {
          row: {
            id: 'msg-1-completed-row',
            kind: 'message',
            label: 'agentMessage',
            itemId: 'msg-1',
            stateVisitId: 'workflow.collect#2',
            text: 'final answer',
          },
        },
      }),
    );

    expect(started.transcript).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'msg-1' })]),
    );
    expect(completed.transcript.filter((item) => item.type === 'agent_message')).toHaveLength(1);
    expect(completed.transcript).toContainEqual(
      expect.objectContaining({
        id: 'msg-1',
        type: 'agent_message',
        text: 'final answer',
        streaming: false,
        eventIds: ['run-1:8', 'run-1:9'],
      }),
    );
    expect(completed.transcript).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'draft answerfinal answer' })]),
    );
  });

  it('coalesces reasoning deltas with completed compact reasoning rows by item id', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [],
    });
    const emptyReasoning = applyRunEvent(
      initial,
      apiEvent({
        type: 'item.started',
        id: 'run-1:10',
        seq: 10,
        stateVisitId: 'workflow.collect#2',
        itemId: 'reason-1',
        data: {
          row: {
            id: 'reason-1-started-row',
            kind: 'reasoning',
            label: 'reasoning',
            itemId: 'reason-1',
            stateVisitId: 'workflow.collect#2',
          },
        },
      }),
    );
    const streaming = applyRunEvent(
      emptyReasoning,
      apiEvent({
        type: 'model.delta',
        id: 'run-1:11',
        seq: 11,
        stateVisitId: 'workflow.collect#2',
        itemId: 'reason-1',
        data: { itemId: 'reason-1', delta: 'draft reasoning', reasoning: true },
      }),
    );
    const completed = applyRunEvent(
      streaming,
      apiEvent({
        type: 'item.completed',
        id: 'run-1:12',
        seq: 12,
        stateVisitId: 'workflow.collect#2',
        itemId: 'reason-1',
        data: {
          row: {
            id: 'reason-1-completed-row',
            kind: 'reasoning',
            label: 'reasoning',
            itemId: 'reason-1',
            stateVisitId: 'workflow.collect#2',
            text: 'final reasoning',
          },
        },
      }),
    );

    expect(emptyReasoning.transcript).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'reason-1' })]),
    );
    expect(completed.transcript.filter((item) => item.type === 'reasoning')).toHaveLength(1);
    expect(completed.transcript).toContainEqual(
      expect.objectContaining({
        id: 'reason-1',
        type: 'reasoning',
        text: 'final reasoning',
        streaming: false,
        eventIds: ['run-1:11', 'run-1:12'],
      }),
    );
  });

  it('projects current-contract replay events into clean default transcript rows', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      mode: 'run',
      recentRows: [],
    });
    const state = currentContractReplayEvents().reduce(applyRunEvent, initial);
    const visible = visibleItems(state.transcript, false);
    const visibleJson = JSON.stringify(visible);

    expect(visibleJson).not.toContain('[aharness] Now in state');
    expect(visibleJson).not.toContain('You have entered');
    expect(visibleJson).not.toContain('agentMessage');
    expect(visibleJson).not.toContain('reasoning-1');
    expect(visible.filter((item) => item.type === 'agent_message')).toHaveLength(1);
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'assistant-message-1',
          type: 'agent_message',
          text: 'Final assistant answer.',
          streaming: false,
          eventIds: ['run-1:6', 'run-1:7', 'run-1:8'],
        }),
        expect.objectContaining({
          id: 'command-1',
          type: 'tool_call',
          name: 'bash',
          status: 'completed',
          displayKind: 'command',
          command: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
          preview: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
          output: 'line 1\nline 2\nline 3',
          elapsedMs: 1234,
        }),
      ]),
    );
  });

  it('merges run-level recent row pages in chronological order without duplicating live rows', () => {
    const initial = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [
        row({
          id: 'row-1',
          eventId: 'run-1:1',
          seq: 1,
          stateVisitId: 'workflow.collect#1',
          text: 'oldest',
        }),
      ],
    });
    const live = applyRunEvent(initial, {
      schema: 'aharness.event.v1',
      runId: 'run-1',
      id: 'run-1:2',
      seq: 2,
      time: '2026-05-29T00:00:02.000Z',
      type: 'model.delta',
      stateVisitId: 'workflow.review#1',
      itemId: 'msg-live',
      offset: 0,
      lineBytes: 1,
      data: { delta: 'live' },
    });

    const merged = applyRecentRowPage(
      live,
      rowPage([
        row({
          id: 'row-2',
          eventId: 'run-1:2',
          seq: 2,
          stateVisitId: 'workflow.review#1',
          text: 'live',
        }),
        row({
          id: 'row-3',
          eventId: 'run-1:3',
          seq: 3,
          stateVisitId: 'workflow.ship#1',
          text: 'newest',
        }),
      ]),
    );

    expect(merged.transcript.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(merged.transcript.filter((item) => item.eventIds?.includes('run-1:2'))).toHaveLength(1);
    expect(merged.recentRowsCursor).toBeNull();
    expect(merged.recentRowsLoadStatus).toEqual({
      loading: false,
      loaded: true,
      error: null,
      storedRows: 2,
    });
  });

  it('keeps global recent rows that do not belong to a state visit', () => {
    const state = applyRecentRowPage(
      hydrateFromBootstrap({ ...runScopedBootstrap(), recentRows: [] }),
      rowPage([
        row({
          id: 'run-row-1',
          eventId: 'run-1:9',
          seq: 9,
          kind: 'framework_note',
          text: 'run-level note',
        }),
      ]),
    );

    expect(state.transcript).toEqual([
      expect.objectContaining({
        id: 'run-row-1',
        text: 'run-level note',
        stateVisitId: '__run',
      }),
    ]);
  });

  it('resets global recent-row paging after a fresh-clear boundary', () => {
    const loaded = applyRecentRowPage(
      hydrateFromBootstrap({ ...runScopedBootstrap(), recentRows: [] }),
      rowPage(
        [row({ id: 'row-1', eventId: 'run-1:1', seq: 1, stateVisitId: 'workflow.collect#1' })],
        'row-1',
      ),
    );

    const cleared = applyRunEvent(loaded, {
      schema: 'aharness.event.v1',
      runId: 'run-1',
      id: 'run-1:2',
      seq: 2,
      time: '2026-05-29T00:00:02.000Z',
      type: 'fresh_clear.boundary',
      offset: 0,
      lineBytes: 1,
      data: {
        row: {
          kind: 'fresh_clear',
          label: 'workflow.review',
          status: 'clearOnEntry',
          data: { previousThreadId: 'old-thread', nextThreadId: 'new-thread' },
        },
      },
    });

    expect(cleared.transcript.map((item) => item.type)).toEqual(['fresh_clear_boundary']);
    expect(cleared.recentRowsCursor).toBeNull();
    expect(cleared.recentRowsLoadStatus).toEqual({
      loading: false,
      loaded: false,
      error: null,
      storedRows: 0,
    });
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

  it('hydrates UI state from the legacy flat snapshot fixture contract', () => {
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

  it('folds matching tool results into the existing visible tool call row', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const withCall = applyAppEvent(initial, {
      kind: 'ItemStarted',
      id: 'call-bash-1',
      type: 'function_call',
      name: 'bash',
      arguments: '{"command":"pnpm test","cwd":"/repo"}',
    });
    const withResult = applyAppEvent(withCall, {
      kind: 'ItemStarted',
      id: 'call-bash-1:output',
      type: 'function_call_output',
      name: 'bash',
      output: 'completed',
      ok: true,
    });

    const visible = visibleItems(withResult.transcript, false);

    expect(withResult.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'call-bash-1',
          type: 'tool_call',
          name: 'bash',
          status: 'completed',
          output: 'completed',
          ok: true,
          resultId: 'call-bash-1:output',
        }),
      ]),
    );
    expect(withResult.transcript).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'call-bash-1:output',
          type: 'tool_result',
        }),
      ]),
    );
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'call-bash-1',
          type: 'tool_call',
          name: 'bash',
          status: 'completed',
          output: 'completed',
          ok: true,
        }),
      ]),
    );
    expect(visible).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'call-bash-1:output',
          type: 'tool_result',
        }),
      ]),
    );
  });

  it('keeps orphan tool results as standalone result rows', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const state = applyAppEvent(initial, {
      kind: 'ItemStarted',
      id: 'orphan-output-1',
      type: 'function_call_output',
      name: 'bash',
      output: 'orphaned output',
      ok: false,
    });

    expect(visibleItems(state.transcript, false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'orphan-output-1',
          type: 'tool_result',
          name: 'bash',
          output: 'orphaned output',
          ok: false,
        }),
      ]),
    );
  });

  it('matches function-call outputs by call id before falling back to tool name', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const withFirstCall = applyAppEvent(initial, {
      kind: 'ItemStarted',
      id: 'call-bash-1',
      type: 'function_call',
      name: 'bash',
      arguments: '{"command":"first"}',
    });
    const withSecondCall = applyAppEvent(withFirstCall, {
      kind: 'ItemStarted',
      id: 'call-bash-2',
      type: 'function_call',
      name: 'bash',
      arguments: '{"command":"second"}',
    });
    const withFirstResult = applyAppEvent(withSecondCall, {
      kind: 'ItemStarted',
      id: 'call-bash-1:output',
      type: 'function_call_output',
      name: 'bash',
      output: 'first completed',
      ok: true,
    });

    const visible = visibleItems(withFirstResult.transcript, false);

    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'call-bash-1',
          type: 'tool_call',
          status: 'completed',
          output: 'first completed',
          resultId: 'call-bash-1:output',
        }),
        expect.objectContaining({
          id: 'call-bash-2',
          type: 'tool_call',
          status: 'pending',
        }),
      ]),
    );
  });

  it('treats completed folded tool calls as activity scan boundaries', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const withStreamingMessage = applyAppEvent(initial, {
      kind: 'ItemStarted',
      id: 'agent-stream-1',
      type: 'agent_message',
      text: 'old streaming message',
    });
    const withCall = {
      ...withStreamingMessage,
      transcript: [
        ...withStreamingMessage.transcript,
        {
          id: 'call-bash-1',
          type: 'tool_call' as const,
          name: 'bash',
          preview: '{"command":"pnpm test"}',
          status: 'completed' as const,
          reserved: false,
          stateVisitId: withStreamingMessage.activeVisitId ?? '__boot',
          output: 'completed',
          ok: true,
          resultId: 'call-bash-1:output',
        },
      ],
    };

    expect(deriveActivity(withCall).kind).not.toBe('streaming.message');
  });

  it('applies default and dev visibility without treating state changes as globally hidden', () => {
    const items: ReturnType<typeof hydrateFromSnapshot>['transcript'] = [
      {
        id: 'orientation-user-1',
        type: 'user_message',
        text: '[aharness] Now in state "execute".',
        synthetic: true,
        stateVisitId: 'workflow.collect#2',
      },
      {
        id: 'framework-info-1',
        type: 'framework_note',
        text: 'framework info',
        variant: 'info',
        stateVisitId: 'workflow.collect#2',
      },
      {
        id: 'framework-orientation-1',
        type: 'framework_note',
        text: 'orientation',
        variant: 'orientation',
        stateVisitId: 'workflow.collect#2',
      },
      {
        id: 'state-change-1',
        type: 'state_change',
        from: null,
        to: 'workflow.collect',
        cause: 'boot',
        stateVisitId: 'workflow.collect#2',
      },
      {
        id: 'reasoning-empty-1',
        type: 'reasoning',
        text: '',
        streaming: false,
        stateVisitId: 'workflow.collect#2',
      },
    ];

    expect(visibleItems(items, false).map((item) => item.id)).toEqual(['state-change-1']);
    expect(visibleItems(items, true).map((item) => item.id)).toEqual([
      'framework-info-1',
      'framework-orientation-1',
      'state-change-1',
    ]);
    expect(hasVisibleContent([items[3]])).toBe(true);
  });

  it('hides runtime orientation user messages and empty reasoning rows from default transcript rows', () => {
    const initial = hydrateFromSnapshot(snapshot());
    const withRuntimeOrientation = applyAppEvent(initial, {
      kind: 'ItemStarted',
      id: 'orientation-user-1',
      type: 'user_message',
      text:
        '[aharness] Now in state "createRecipe".\n' +
        'Valid exits:\n' +
        '  - "recipeReady" -> call aharness_submit({state:"createRecipe"})',
    });
    const withEmptyReasoning = applyAppEvent(withRuntimeOrientation, {
      kind: 'ItemStarted',
      id: 'reasoning-empty-1',
      type: 'reasoning',
      text: '',
    });
    const withReasoningText = applyAppEvent(withEmptyReasoning, {
      kind: 'ItemStarted',
      id: 'reasoning-text-1',
      type: 'reasoning',
      text: 'Checking the next command.',
    });

    const visible = visibleItems(withReasoningText.transcript, false);
    const visibleInDevMode = visibleItems(withReasoningText.transcript, true);

    expect(visible).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'orientation-user-1' })]),
    );
    expect(visible).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'reasoning-empty-1' })]),
    );
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'reasoning-text-1',
          type: 'reasoning',
          text: 'Checking the next command.',
        }),
      ]),
    );
    expect(visibleInDevMode).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'orientation-user-1' })]),
    );
    expect(visibleInDevMode).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'reasoning-empty-1' })]),
    );
    expect(
      hasVisibleContent(
        withEmptyReasoning.transcript.filter((item) =>
          ['orientation-user-1', 'reasoning-empty-1'].includes(item.id),
        ),
      ),
    ).toBe(false);
    expect(hasVisibleContent(withReasoningText.transcript)).toBe(true);
  });

  it('preserves provenance for same-id compact tool replacements and folded tool results', () => {
    const state = hydrateFromBootstrap({
      ...runScopedBootstrap(),
      recentRows: [
        row({
          id: 'tool-start',
          eventId: 'run-1:20',
          seq: 20,
          stateVisitId: 'workflow.collect#2',
          itemId: 'tool-shared',
          kind: 'tool',
          label: 'bash',
          status: 'pending',
          summary: 'pnpm test',
          data: { displayKind: 'command', command: 'pnpm test' },
        }),
        row({
          id: 'tool-complete',
          eventId: 'run-1:21',
          seq: 21,
          stateVisitId: 'workflow.collect#2',
          itemId: 'tool-shared',
          kind: 'tool',
          label: 'bash',
          status: 'completed',
          summary: 'pnpm test',
          output: 'done',
          ok: true,
          resultId: 'tool-shared:output',
        }),
      ],
    });

    expect(state.transcript).toContainEqual(
      expect.objectContaining({
        id: 'tool-shared',
        status: 'completed',
        displayKind: 'command',
        command: 'pnpm test',
        output: 'done',
        eventIds: ['run-1:20', 'run-1:21'],
      }),
    );

    const folded = visibleItems(
      [
        {
          id: 'call-1',
          type: 'tool_call',
          name: 'bash',
          preview: 'pnpm test',
          status: 'pending',
          reserved: false,
          stateVisitId: 'workflow.collect#2',
          eventId: 'run-1:30',
        },
        {
          id: 'call-1:output',
          type: 'tool_result',
          name: 'bash',
          output: 'ok',
          ok: true,
          reserved: false,
          stateVisitId: 'workflow.collect#2',
          eventId: 'run-1:31',
        },
      ],
      false,
    );

    expect(folded).toContainEqual(
      expect.objectContaining({
        id: 'call-1',
        type: 'tool_call',
        status: 'completed',
        output: 'ok',
        eventIds: ['run-1:30', 'run-1:31'],
      }),
    );
  });

  it('applies display-only output truncation in default mode', () => {
    const output = Array.from({ length: 12 }, (_, idx) => `line ${idx + 1}`).join('\n');
    const canonical = [
      {
        id: 'tool-1',
        type: 'tool_call' as const,
        name: 'bash',
        preview: 'script',
        status: 'completed' as const,
        reserved: false,
        stateVisitId: 'workflow.collect#2',
        output,
      },
    ];

    const defaultDisplay = displayItems(canonical, false);
    const devDisplay = displayItems(canonical, true);

    expect(defaultDisplay).toContainEqual(
      expect.objectContaining({
        id: 'tool-1',
        output:
          'line 1\nline 2\nline 3\nline 4\nline 5\n... +2 lines (dev mode for full output)\nline 8\nline 9\nline 10\nline 11\nline 12',
      }),
    );
    expect(devDisplay).toContainEqual(expect.objectContaining({ id: 'tool-1', output }));
    expect(canonical[0].output).toBe(output);
  });

  it('groups only consecutive same-turn successful exploration display rows', () => {
    const items: ReturnType<typeof hydrateFromSnapshot>['transcript'] = [
      {
        id: 'read-1',
        type: 'tool_call',
        name: 'read_file',
        preview: 'src/a.ts',
        status: 'completed',
        reserved: false,
        displayKind: 'read',
        stateVisitId: 'workflow.collect#2',
        turnId: 'turn-1',
        eventIds: ['run-1:40'],
      },
      {
        id: 'list-1',
        type: 'tool_call',
        name: 'list_files',
        preview: 'src',
        status: 'pending',
        reserved: false,
        displayKind: 'list',
        stateVisitId: 'workflow.collect#2',
        turnId: 'turn-1',
        eventIds: ['run-1:41'],
      },
      {
        id: 'failed-search',
        type: 'tool_call',
        name: 'search',
        preview: 'needle',
        status: 'failed',
        reserved: false,
        displayKind: 'search',
        stateVisitId: 'workflow.collect#2',
        turnId: 'turn-1',
        eventIds: ['run-1:42'],
      },
      {
        id: 'read-no-turn',
        type: 'tool_call',
        name: 'read_file',
        preview: 'src/b.ts',
        status: 'completed',
        reserved: false,
        displayKind: 'read',
        stateVisitId: 'workflow.collect#2',
        eventIds: ['run-1:43'],
      },
    ];

    const displayed = displayItems(items, false);

    expect(displayed[0]).toEqual(
      expect.objectContaining({
        type: 'exploration_group',
        id: 'exploration:read-1:list-1',
        status: 'pending',
        title: 'Exploring',
        eventIds: ['run-1:40', 'run-1:41'],
        children: [
          expect.objectContaining({ id: 'read-1', displayKind: 'read' }),
          expect.objectContaining({ id: 'list-1', displayKind: 'list' }),
        ],
      }),
    );
    expect(displayed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'failed-search', type: 'tool_call' }),
        expect.objectContaining({ id: 'read-no-turn', type: 'tool_call' }),
      ]),
    );
  });

  it('applies parent subagent summary policy and display preview caps', () => {
    const longPrompt = 'p'.repeat(200);
    const longResponse = 'r'.repeat(280);
    const longError = 'e'.repeat(200);
    const subagent = (
      id: string,
      subagentAction: 'spawn' | 'send' | 'wait' | 'resume' | 'close',
      status: 'pending' | 'completed',
    ) => ({
      id,
      type: 'tool_call' as const,
      name: 'spawn_agent',
      preview: `${subagentAction} ${status}`,
      status,
      reserved: false,
      category: 'subagent' as const,
      displayKind: 'subagent' as const,
      subagentAction,
      stateVisitId: 'workflow.collect#2',
      promptPreview: longPrompt,
      responsePreview: longResponse,
      errorPreview: longError,
    });

    const items = [
      subagent('spawn-pending', 'spawn', 'pending'),
      subagent('send-pending', 'send', 'pending'),
      subagent('close-pending', 'close', 'pending'),
      subagent('wait-pending', 'wait', 'pending'),
      subagent('resume-pending', 'resume', 'pending'),
      subagent('spawn-completed', 'spawn', 'completed'),
    ];

    expect(visibleItems(items, false).map((item) => item.id)).toEqual([
      'wait-pending',
      'resume-pending',
      'spawn-completed',
    ]);
    expect(visibleItems(items, true).map((item) => item.id)).toEqual([
      'spawn-pending',
      'send-pending',
      'close-pending',
      'wait-pending',
      'resume-pending',
      'spawn-completed',
    ]);

    const capped = displayItems([subagent('spawn-completed', 'spawn', 'completed')], false)[0];
    expect(capped).toEqual(
      expect.objectContaining({
        promptPreview: `${'p'.repeat(159)}…`,
        responsePreview: `${'r'.repeat(239)}…`,
        errorPreview: `${'e'.repeat(159)}…`,
      }),
    );
  });

  it('hydrates topology from the legacy flat snapshot fixture contract', () => {
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

  it('hydrates abandoned-thread diagnostics from the legacy flat snapshot fixture contract', () => {
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

  it('hydrates pending owner input from the legacy flat snapshot fixture contract', () => {
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

  it('hydrates approval buckets from the legacy flat snapshot fixture contract', () => {
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
