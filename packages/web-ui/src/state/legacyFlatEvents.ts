// Legacy flat AppEvent reducer for fixture/demo and compatibility tests only.
// Production boot, reconnect, row loading, and live updates use run-scoped
// JSONL bootstrap, row pages, and run events from store.ts.

import type { AppEvent, UiSnapshot } from '../types/events.js';
import type { TranscriptItem, UiState } from './store.js';
import { EMPTY_TOPOLOGY, isReservedToolName } from './store.js';

const DIAGNOSTIC_LIMIT = 100;

function emptyPending(): UiState['pending'] {
  return {
    fileApprovals: [],
    cmdApprovals: [],
    permissionApprovals: [],
    elicitations: [],
    ownerInput: null,
  };
}

function visitIdOf(path: string, visit: number): string {
  return `${path}#${visit}`;
}

function looksLikeFrameworkOrientation(text: string): boolean {
  if (!text) return false;
  return /^You have entered\s+`/.test(text);
}

export function hydrateFromSnapshot(snapshot: UiSnapshot): UiState {
  const activeVisitId = snapshot.state.currentState
    ? visitIdOf(snapshot.state.currentState.path, snapshot.state.currentState.visitCount)
    : null;
  const stateVisitId = activeVisitId ?? '__boot';
  const mode = snapshot.state.mode ?? 'run';
  return {
    mode,
    run: snapshot.state.run,
    latestEventId: snapshot.latestEventId,
    posture: snapshot.state.posture,
    activeTurnId: snapshot.state.activeTurn?.turnId ?? null,
    state: snapshot.state.currentState,
    topology: snapshot.state.topology ?? EMPTY_TOPOLOGY,
    transcript: [
      ...snapshot.state.transcript.map(
        (entry): TranscriptItem => ({
          id: entry.id,
          type: entry.reasoning ? 'reasoning' : 'agent_message',
          text: entry.text,
          streaming: false,
          stateVisitId,
        }),
      ),
      ...snapshot.state.frameworkNotes.map(
        (note): TranscriptItem => ({
          id: note.id,
          type: 'framework_note',
          text: note.text,
          variant: note.variant,
          stateVisitId,
        }),
      ),
    ],
    pending: {
      ...emptyPending(),
      ownerInput: snapshot.state.pending?.ownerInput ?? null,
      fileApprovals: snapshot.state.pending?.fileApprovals ?? [],
      cmdApprovals: snapshot.state.pending?.cmdApprovals ?? [],
      permissionApprovals: snapshot.state.pending?.permissionApprovals ?? [],
      elicitations: snapshot.state.pending?.elicitations ?? [],
    },
    diagnostics: snapshot.state.diagnostics ?? [],
    stateVisits: snapshot.state.currentState
      ? [
          {
            id: stateVisitId,
            path: snapshot.state.currentState.path,
            seq: 0,
            time: '',
            from: null,
            to: snapshot.state.currentState.path,
            cause: 'boot',
          },
        ]
      : [],
    statePathVisits: snapshot.state.currentState
      ? { [snapshot.state.currentState.path]: [stateVisitId] }
      : {},
    rowPageCursors: {},
    rowLoadStatus: {},
    aggregateStats: {
      turnCount: snapshot.state.completedTurns.length,
      ...(snapshot.state.activeTurn?.turnId === undefined
        ? {}
        : { activeTurnId: snapshot.state.activeTurn.turnId }),
    },
    history: snapshot.state.currentState
      ? [
          {
            at: 0,
            from: null,
            to: snapshot.state.currentState.path,
            cause: 'boot',
            visitId: stateVisitId,
          },
        ]
      : [],
    turns: snapshot.state.completedTurns.map((turn) => ({
      turnId: turn.turnId,
      finishReason: turn.finishReason,
      endedAt: 0,
      stateVisitId,
    })),
    connection: 'live',
    replyError: null,
    rowLoadError: null,
    activeVisitId,
    scopedPath: null,
    devMode: mode === 'inspect',
  };
}

export function applyAppEvent(state: UiState, event: AppEvent): UiState {
  return reduceEvent(state, event);
}

function reduceEvent(previous: UiState, e: AppEvent): UiState {
  const s =
    previous.connection === 'live' ? previous : { ...previous, connection: 'live' as const };
  const vid = s.activeVisitId ?? '__boot';
  switch (e.kind) {
    case 'AgentMessageDelta': {
      const t = [...s.transcript];
      const idx = t.findIndex((i) => i.id === e.id);
      const prev = idx >= 0 ? t[idx] : undefined;
      if (prev?.type === 'agent_message' || prev?.type === 'reasoning') {
        t[idx] = { ...prev, text: prev.text + e.delta, streaming: true };
      } else if (!prev) {
        t.push({
          id: e.id,
          type: e.reasoning ? 'reasoning' : 'agent_message',
          text: e.delta,
          streaming: true,
          stateVisitId: vid,
        });
      }
      return { ...s, transcript: t };
    }
    case 'TurnStarted':
      return { ...s, activeTurnId: e.turnId };
    case 'ItemStarted': {
      if (s.transcript.some((i) => i.id === e.id)) return s;
      const t = [...s.transcript];
      if (e.type === 'agent_message') {
        t.push({
          id: e.id,
          type: 'agent_message',
          text: e.text,
          streaming: true,
          stateVisitId: vid,
        });
      } else if (e.type === 'reasoning') {
        t.push({ id: e.id, type: 'reasoning', text: e.text, streaming: true, stateVisitId: vid });
      } else if (e.type === 'user_message') {
        t.push({
          id: e.id,
          type: 'user_message',
          text: e.text,
          synthetic: looksLikeFrameworkOrientation(e.text),
          stateVisitId: vid,
        });
      } else if (e.type === 'function_call') {
        t.push({
          id: e.id,
          type: 'tool_call',
          name: e.name,
          preview: e.arguments,
          status: 'pending',
          reserved: isReservedToolName(e.name),
          stateVisitId: vid,
        });
      } else if (e.type === 'function_call_output') {
        const callIdx = t.findIndex(
          (i) => i.type === 'tool_call' && i.name === e.name && i.status === 'pending',
        );
        if (callIdx >= 0) {
          const prev = t[callIdx] as Extract<TranscriptItem, { type: 'tool_call' }>;
          t[callIdx] = { ...prev, status: e.ok ? 'completed' : 'failed' };
        }
        t.push({
          id: e.id,
          type: 'tool_result',
          name: e.name,
          output: e.output,
          ok: e.ok,
          reserved: isReservedToolName(e.name),
          stateVisitId: vid,
        });
      }
      return { ...s, transcript: t };
    }
    case 'ServerRequest': {
      if (e.method === 'item/fileChange/requestApproval') {
        if (s.pending.fileApprovals.some((r) => r.id === e.id)) return s;
        return { ...s, pending: { ...s.pending, fileApprovals: [...s.pending.fileApprovals, e] } };
      }
      if (e.method === 'item/commandExecution/requestApproval') {
        if (s.pending.cmdApprovals.some((r) => r.id === e.id)) return s;
        return { ...s, pending: { ...s.pending, cmdApprovals: [...s.pending.cmdApprovals, e] } };
      }
      if (e.method === 'item/tool/requestUserInput') {
        if (s.pending.ownerInput?.id === e.id) return s;
        return {
          ...s,
          pending: { ...s.pending, ownerInput: e },
          posture: { ...s.posture, isAwaiting: true },
        };
      }
      if (e.method === 'item/permissions/requestApproval') {
        if (s.pending.permissionApprovals.some((r) => r.id === e.id)) return s;
        return {
          ...s,
          pending: { ...s.pending, permissionApprovals: [...s.pending.permissionApprovals, e] },
        };
      }
      if (e.method === 'mcpServer/elicitation/request') {
        if (s.pending.elicitations.some((r) => r.id === e.id)) return s;
        return { ...s, pending: { ...s.pending, elicitations: [...s.pending.elicitations, e] } };
      }
      return s;
    }
    case 'OwnerInputResolved':
      if (s.pending.ownerInput?.id !== e.id) return s;
      return {
        ...s,
        pending: { ...s.pending, ownerInput: null },
        posture: { ...s.posture, isAwaiting: false },
      };
    case 'FileApprovalUpdated':
      return {
        ...s,
        pending: {
          ...s.pending,
          fileApprovals: s.pending.fileApprovals.map((r) =>
            r.id === e.id ? { ...r, changes: e.changes } : r,
          ),
        },
      };
    case 'ApprovalRequestResolved':
      return {
        ...s,
        pending: {
          ...s.pending,
          fileApprovals: s.pending.fileApprovals.filter((r) => r.id !== e.id),
          cmdApprovals: s.pending.cmdApprovals.filter((r) => r.id !== e.id),
          permissionApprovals: s.pending.permissionApprovals.filter((r) => r.id !== e.id),
          elicitations: s.pending.elicitations.filter((r) => r.id !== e.id),
        },
      };
    case 'TurnCompleted':
      return {
        ...s,
        turns: [
          ...s.turns,
          {
            turnId: e.turnId,
            finishReason: e.finishReason,
            endedAt: Date.now(),
            stateVisitId: vid,
          },
        ],
        transcript: s.transcript.map((i) =>
          i.type === 'agent_message' || i.type === 'reasoning' ? { ...i, streaming: false } : i,
        ),
        activeTurnId: null,
        posture: { ...s.posture, submittedThisTurn: false },
      };
    case 'StateChange': {
      const nextVid = visitIdOf(e.newState.path, e.newState.visitCount);
      return {
        ...s,
        state: e.newState,
        activeVisitId: nextVid,
        scopedPath: null,
        transcript: [
          ...s.transcript,
          {
            id: `state-${e.to}-${Date.now()}`,
            type: 'state_change',
            from: e.from,
            to: e.to,
            cause: e.cause,
            stateVisitId: nextVid,
          },
        ],
        history: [
          ...s.history,
          { at: Date.now(), from: e.from, to: e.to, cause: e.cause, visitId: nextVid },
        ],
        posture: {
          ...s.posture,
          isAwaiting: Boolean(e.newState.awaitsOwnerText),
          isTerminal: e.newState.kind === 'terminal',
        },
      };
    }
    case 'PostureChange':
      return { ...s, posture: { ...s.posture, ...e.posture } };
    case 'FreshClearBoundary':
      return {
        ...s,
        run: s.run ? { ...s.run, threadId: e.nextThreadId } : s.run,
        pending: emptyPending(),
        turns: [],
        transcript: [
          {
            id: e.id,
            type: 'fresh_clear_boundary',
            reason: e.reason,
            previousThreadId: e.previousThreadId,
            nextThreadId: e.nextThreadId,
            statePath: e.statePath,
            stateVisitId: vid,
          },
        ],
        activeTurnId: null,
        posture: { ...s.posture, isAwaiting: false, submittedThisTurn: false },
      };
    case 'AbandonedThreadDiagnostic':
      return { ...s, diagnostics: [...s.diagnostics, e].slice(-DIAGNOSTIC_LIMIT) };
    case 'FrameworkNote':
      return {
        ...s,
        transcript: [
          ...s.transcript,
          { id: e.id, type: 'framework_note', text: e.text, variant: e.variant, stateVisitId: vid },
        ],
      };
    case 'ResyncRequired':
    default:
      return s;
  }
}
