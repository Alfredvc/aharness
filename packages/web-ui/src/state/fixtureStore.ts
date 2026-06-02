import { useCallback, useEffect, useRef, useState } from 'react';
import { createEngine, type Engine } from '../fixtures/engine.js';
import { readFixtureIdFromLocation, resolveFixture, type Fixture } from '../fixtures/registry.js';
import type { FsmState, RunCompletionOutcome, RunCompletionStats } from '../types/events.js';
import {
  createConnectingUiState,
  type ReplyPayload,
  type UiActions,
  type UiState,
} from './store.js';
import { applyAppEvent } from './legacyFlatEvents.js';

type ShareFixtureMode = Extract<RunCompletionOutcome, 'success' | 'failure'>;

export function readShareFixtureModeFromLocation(): ShareFixtureMode | null {
  const location = (globalThis as { location?: { search?: string } }).location;
  if (!location) return null;
  const param = new URLSearchParams(location.search ?? '').get('share');
  return param === 'success' || param === 'failure' ? param : null;
}

export function buildFixtureInitial(
  fixture: Fixture,
  shareMode: ShareFixtureMode | null = null,
): UiState {
  const base: UiState = {
    ...createConnectingUiState(),
    run: {
      runId: fixture.runMeta.runId,
      threadId: 'th_01HM4Q7K9X2Z',
      repoRoot: '/Users/alfredvc/src/aharness',
      fsmFile: fixture.runMeta.fsmFile,
      fsmHash6: fixture.runMeta.fsmHash6,
      codexPin: '2abdeb34d5',
      startedAt: new Date().toISOString(),
    },
    topology: fixture.topology,
    connection: 'live',
  };
  if (!shareMode) return base;

  const initialPath = fixture.topology.initial;
  const initialNode = fixture.topology.nodes.find((node) => node.id === initialPath);
  const visitId = `${initialPath}#terminal-share`;
  return {
    ...base,
    posture: {
      isTerminal: true,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    },
    state: {
      path: initialPath,
      leaf: initialPath.split('.').at(-1) ?? initialPath,
      kind: toFixtureStateKind(initialNode?.kind),
      exits: [],
      visitCount: 1,
    },
    activeVisitId: visitId,
    stateVisits: [
      {
        id: visitId,
        path: initialPath,
        seq: 1,
        time: '2026-06-02T00:00:00.000Z',
        from: null,
        to: initialPath,
        cause: 'share-fixture',
      },
    ],
    statePathVisits: { [initialPath]: [visitId] },
    aggregateStats: {
      status: shareMode,
      startedAt: '2026-06-02T00:00:00.000Z',
      endedAt: '2026-06-02T00:02:05.000Z',
      turnCount: 4,
      totalTokens: 9876,
    },
    completionStats: buildShareFixtureCompletionStats(fixture, shareMode),
    finalOverview: {
      open: true,
      autoOpened: true,
      dismissed: false,
      loading: false,
      error: null,
    },
    history: [
      {
        at: Date.parse('2026-06-02T00:00:00.000Z'),
        from: null,
        to: initialPath,
        cause: 'share-fixture',
        visitId,
      },
    ],
  };
}

function resolveSuccessfulFixtureReply(state: UiState, payload: ReplyPayload): UiState {
  if (payload.kind === 'approval') {
    return {
      ...state,
      replyError: null,
      pending: {
        ...state.pending,
        fileApprovals: state.pending.fileApprovals.filter(
          (request) => request.id !== payload.requestId,
        ),
        cmdApprovals: state.pending.cmdApprovals.filter(
          (request) => request.id !== payload.requestId,
        ),
      },
    };
  }
  if (payload.kind === 'permission') {
    return {
      ...state,
      replyError: null,
      pending: {
        ...state.pending,
        permissionApprovals: state.pending.permissionApprovals.filter(
          (request) => request.id !== payload.requestId,
        ),
      },
    };
  }
  if (payload.kind === 'elicitation') {
    return {
      ...state,
      replyError: null,
      pending: {
        ...state.pending,
        elicitations: state.pending.elicitations.filter(
          (request) => request.id !== payload.requestId,
        ),
      },
    };
  }
  if (payload.kind === 'owner-input') {
    return {
      ...state,
      replyError: null,
      pending: { ...state.pending, ownerInput: null },
      posture: { ...state.posture, isAwaiting: false },
    };
  }
  if (payload.kind === 'owner-choice') {
    return {
      ...state,
      replyError: null,
      pending:
        state.pending.ownerChoice?.state === payload.state &&
        state.pending.ownerChoice.visitCount === payload.visitCount
          ? { ...state.pending, ownerChoice: null }
          : state.pending,
      posture: { ...state.posture, isAwaiting: false },
    };
  }

  return { ...state, replyError: null };
}

export function useFixtureAharnessSession(): UiState & UiActions {
  const fixtureRef = useRef<Fixture | null>(null);
  if (fixtureRef.current === null) {
    fixtureRef.current = resolveFixture(readFixtureIdFromLocation());
  }
  const shareModeRef = useRef<ShareFixtureMode | null>(null);
  if (shareModeRef.current === null) {
    shareModeRef.current = readShareFixtureModeFromLocation();
  }

  const [state, setState] = useState<UiState>(() =>
    buildFixtureInitial(fixtureRef.current!, shareModeRef.current),
  );
  const engineRef = useRef<Engine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = createEngine(fixtureRef.current.scenes);
  }

  useEffect(() => {
    if (shareModeRef.current) return undefined;
    const engine = engineRef.current!;
    const unsubscribe = engine.subscribe((event) => {
      setState((current) => applyAppEvent(current, event));
    });
    engine.start();
    return () => {
      unsubscribe();
      engine.reset();
    };
  }, []);

  const reply = useCallback((payload: ReplyPayload): Promise<void> => {
    engineRef.current!.reply(payload);
    setState((current) => resolveSuccessfulFixtureReply(current, payload));
    return Promise.resolve();
  }, []);

  return {
    ...state,
    reply,
    openFinalOverview: () =>
      setState((current) => ({
        ...current,
        finalOverview: { ...current.finalOverview, open: true, dismissed: false, error: null },
      })),
    dismissFinalOverview: () =>
      setState((current) => ({
        ...current,
        finalOverview: { ...current.finalOverview, open: false, dismissed: true },
      })),
    toggleDevMode: () => setState((current) => ({ ...current, devMode: !current.devMode })),
    setScope: (path: string | null) => setState((current) => ({ ...current, scopedPath: path })),
  };
}

function buildShareFixtureCompletionStats(
  fixture: Fixture,
  outcome: ShareFixtureMode,
): RunCompletionStats {
  return {
    outcome,
    fsmDisplayName: displayNameFromFixture(fixture),
    duration: {
      startedAt: '2026-06-02T00:00:00.000Z',
      endedAt: '2026-06-02T00:02:05.000Z',
      elapsedMs: 125_000,
    },
    transitionCount: outcome === 'success' ? 9 : 7,
    freshClearCount: 2,
    mainTurnCount: 4,
    subthreadTurnCount: 3,
    tokenTotals: {
      totalTokens: 9876,
      inputTokens: 4200,
      cachedInputTokens: 1200,
      outputTokens: 5676,
      reasoningOutputTokens: 2100,
      mainTokens: 7100,
      subthreadTokens: 2776,
      unattributedTokens: 0,
    },
    topologyStatus: 'available',
    stateBuckets: fixture.topology.nodes.slice(0, 7).map((node, index) => ({
      id: node.id,
      label: node.label || node.id.split('.').at(-1) || node.id,
      path: node.id,
      elapsedMs: (index + 1) * 12_000,
      eventCount: index + 3,
      transitionCount: Math.max(1, index),
      mainTurnCount: index % 2,
      subthreadTurnCount: index === 0 ? 0 : 1,
      tokenTotals: {
        totalTokens: (index + 2) * 300,
        inputTokens: 120,
        cachedInputTokens: 30,
        outputTokens: 180,
        reasoningOutputTokens: 60,
      },
    })),
    workDelta:
      outcome === 'success'
        ? { status: 'available', filesChanged: 5, linesAdded: 84, linesDeleted: 19 }
        : { status: 'available', filesChanged: 3, linesAdded: 22, linesDeleted: 11 },
  };
}

function displayNameFromFixture(fixture: Fixture): string {
  const filename = fixture.runMeta.fsmFile.split(/[\\/]/).at(-1) ?? fixture.runMeta.fsmFile;
  return filename.replace(/\.fsm\.ts$/, '').replace(/[^a-zA-Z0-9._ -]+/g, ' ') || fixture.id;
}

function toFixtureStateKind(kind: string | undefined): FsmState['kind'] {
  if (
    kind === 'stateful' ||
    kind === 'terminal' ||
    kind === 'passive' ||
    kind === 'choice' ||
    kind === 'final'
  ) {
    return kind;
  }
  return 'stateful';
}
