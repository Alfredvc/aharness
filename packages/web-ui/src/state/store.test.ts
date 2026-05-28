import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyAppEvent,
  createConnectingUiState,
  hydrateFromSnapshot,
  markConnectionLost,
  visibleItems,
} from './store.js';
import { deriveActivity } from './activity.js';
import type { FsmState, Posture, UiSnapshot } from '../types/events.js';
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

describe('headless production store helpers', () => {
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
