import { useCallback, useEffect, useRef, useState } from 'react';
import { createEngine, type Engine } from '../fixtures/engine.js';
import { readFixtureIdFromLocation, resolveFixture, type Fixture } from '../fixtures/registry.js';
import {
  createConnectingUiState,
  type ReplyPayload,
  type UiActions,
  type UiState,
} from './store.js';
import { applyAppEvent } from './legacyFlatEvents.js';

function buildFixtureInitial(fixture: Fixture): UiState {
  return {
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

  const [state, setState] = useState<UiState>(() => buildFixtureInitial(fixtureRef.current!));
  const engineRef = useRef<Engine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = createEngine(fixtureRef.current.scenes);
  }

  useEffect(() => {
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
    toggleDevMode: () => setState((current) => ({ ...current, devMode: !current.devMode })),
    setScope: (path: string | null) => setState((current) => ({ ...current, scopedPath: path })),
  };
}
