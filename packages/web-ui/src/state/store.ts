// Reducer + custom hook consuming production AppEvents. Produces UI state with
// filter rules that hide internal aharness noise (reserved tools, framework
// orientation) by default.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  fetchSnapshot,
  postReply,
  resyncAndReconnect,
  retainStateAfterReplyFailure,
  subscribeToEvents,
} from '../api/client.js';
import type {
  AppEvent,
  FsmState,
  Posture,
  RunMeta,
  FileChangeApproval,
  CommandApproval,
  OwnerInputRequest,
  PermissionApproval,
  ElicitationRequest,
  AbandonedThreadDiagnostic,
  UiSnapshot,
  UiMode,
} from '../types/events.js';
import type { Topology } from '../types/topology.js';

// Tools the UI hides from the default transcript view: aharness_submit is the
// model-visible name of the dynamic_tools submit channel (headless spec §4.3.1);
// request_user_input is codex's built-in owner-yield tool whose ServerRequest
// is rendered separately. Dev mode reveals both.
export const RESERVED_TOOLS = new Set<string>([
  'aharness_submit',
  'request_user_input',
  'mcp__aharness_fsm__submit',
  'mcp:aharness_fsm/submit',
]);
const DIAGNOSTIC_LIMIT = 100;

export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOLS.has(name) || /^mcp__aharness(?:_|-).*__submit$/.test(name);
}

export type TranscriptItem =
  | {
      id: string;
      type: 'agent_message';
      text: string;
      streaming: boolean;
      stateVisitId: string;
    }
  | { id: string; type: 'user_message'; text: string; synthetic: boolean; stateVisitId: string }
  | { id: string; type: 'reasoning'; text: string; streaming: boolean; stateVisitId: string }
  | {
      id: string;
      type: 'tool_call';
      name: string;
      arguments: string;
      status: 'pending' | 'approved' | 'declined' | 'completed' | 'failed';
      reserved: boolean;
      stateVisitId: string;
    }
  | {
      id: string;
      type: 'tool_result';
      name: string;
      output: string;
      ok: boolean;
      reserved: boolean;
      stateVisitId: string;
    }
  | {
      id: string;
      type: 'framework_note';
      text: string;
      variant: 'info' | 'warn' | 'orientation';
      stateVisitId: string;
    }
  | {
      id: string;
      type: 'state_change';
      from: string | null;
      to: string;
      cause: string;
      stateVisitId: string;
    }
  | {
      id: string;
      type: 'fresh_clear_boundary';
      reason: 'clearOnEntry';
      previousThreadId: string;
      nextThreadId: string;
      statePath: string;
      stateVisitId: string;
    };

export type TurnRecord = {
  turnId: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'abort';
  endedAt: number;
  stateVisitId: string;
};

export type UiState = {
  mode: UiMode;
  run: RunMeta | null;
  posture: Posture;
  activeTurnId: string | null;
  state: FsmState | null;
  topology: Topology;
  transcript: TranscriptItem[];
  pending: {
    fileApprovals: FileChangeApproval[];
    cmdApprovals: CommandApproval[];
    permissionApprovals: PermissionApproval[];
    elicitations: ElicitationRequest[];
    ownerInput: OwnerInputRequest | null;
  };
  diagnostics: AbandonedThreadDiagnostic[];
  history: Array<{ at: number; from: string | null; to: string; cause: string; visitId: string }>;
  turns: TurnRecord[];
  connection: 'live' | 'connecting' | 'lost';
  replyError: string | null;
  activeVisitId: string | null;
  scopedPath: string | null; // user-pinned scope by state path (covers all visits); null = follow active
  devMode: boolean;
};

export type ReplyPayload =
  | {
      kind: 'approval';
      requestId: string;
      decision: 'accept' | 'decline' | 'cancel' | 'acceptForSession';
    }
  | { kind: 'permission'; requestId: string; decision: 'accept' | 'decline' }
  | {
      kind: 'elicitation';
      requestId: string;
      action: 'accept' | 'decline' | 'cancel';
      values?: Record<string, unknown>;
    }
  | { kind: 'owner-input'; requestId: string; answers: Record<string, string> }
  | { kind: 'user-prompt'; text: string };

export const EMPTY_TOPOLOGY: Topology = {
  machineId: '',
  initial: '',
  nodes: [],
  edges: [],
};

function emptyPending(): UiState['pending'] {
  return {
    fileApprovals: [],
    cmdApprovals: [],
    permissionApprovals: [],
    elicitations: [],
    ownerInput: null,
  };
}

export function createConnectingUiState(): UiState {
  return {
    mode: 'run',
    run: null,
    posture: {
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    },
    activeTurnId: null,
    state: null,
    topology: EMPTY_TOPOLOGY,
    transcript: [],
    pending: emptyPending(),
    diagnostics: [],
    history: [],
    turns: [],
    connection: 'connecting',
    replyError: null,
    activeVisitId: null,
    scopedPath: null,
    devMode: false,
  };
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
    activeVisitId,
    scopedPath: null,
    devMode: mode === 'inspect',
  };
}

export function applyAppEvent(state: UiState, event: AppEvent): UiState {
  return reduceEvent(state, event);
}

export function markConnectionLost(state: UiState): UiState {
  if (state.posture.isTerminal) return state;
  return { ...state, connection: 'lost' };
}

type Action =
  | { type: 'event'; e: AppEvent }
  | { type: 'hydrate'; snapshot: UiSnapshot }
  | { type: 'connectionLost' }
  | { type: 'replyFailed'; error: string }
  | { type: 'resolveApproval'; id: string }
  | { type: 'resolvePermission'; id: string }
  | { type: 'resolveElicitation'; id: string }
  | { type: 'resolveOwnerInput' }
  | { type: 'toggleDevMode' }
  | { type: 'setScope'; path: string | null };

function visitIdOf(path: string, visit: number): string {
  return `${path}#${visit}`;
}

function looksLikeFrameworkOrientation(text: string): boolean {
  // Heuristic: synthesised state-entry orientation from turn/start.input
  // starts with "You have entered" and tells the model how to submit.
  if (!text) return false;
  return /^You have entered\s+`/.test(text);
}

function reducer(s: UiState, a: Action): UiState {
  if (a.type === 'hydrate') {
    return hydrateFromSnapshot(a.snapshot);
  }
  if (a.type === 'connectionLost') {
    return markConnectionLost(s);
  }
  if (a.type === 'replyFailed') {
    return { ...retainStateAfterReplyFailure(s), replyError: a.error };
  }
  if (a.type === 'resolveApproval') {
    return {
      ...s,
      replyError: null,
      pending: {
        ...s.pending,
        fileApprovals: s.pending.fileApprovals.filter((r) => r.id !== a.id),
        cmdApprovals: s.pending.cmdApprovals.filter((r) => r.id !== a.id),
      },
    };
  }
  if (a.type === 'resolvePermission') {
    return {
      ...s,
      replyError: null,
      pending: {
        ...s.pending,
        permissionApprovals: s.pending.permissionApprovals.filter((r) => r.id !== a.id),
      },
    };
  }
  if (a.type === 'resolveElicitation') {
    return {
      ...s,
      replyError: null,
      pending: {
        ...s.pending,
        elicitations: s.pending.elicitations.filter((r) => r.id !== a.id),
      },
    };
  }
  if (a.type === 'resolveOwnerInput') {
    return {
      ...s,
      replyError: null,
      pending: { ...s.pending, ownerInput: null },
      posture: { ...s.posture, isAwaiting: false },
    };
  }
  if (a.type === 'toggleDevMode') {
    return { ...s, devMode: !s.devMode };
  }
  if (a.type === 'setScope') {
    return { ...s, scopedPath: a.path };
  }
  return applyAppEvent(s, a.e);
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
    case 'TurnStarted': {
      return { ...s, activeTurnId: e.turnId };
    }
    case 'ItemStarted': {
      // Idempotent: if an item with this id is already present, skip.
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
        t.push({
          id: e.id,
          type: 'reasoning',
          text: e.text,
          streaming: true,
          stateVisitId: vid,
        });
      } else if (e.type === 'user_message') {
        const synthetic = looksLikeFrameworkOrientation(e.text);
        t.push({
          id: e.id,
          type: 'user_message',
          text: e.text,
          synthetic,
          stateVisitId: vid,
        });
      } else if (e.type === 'function_call') {
        t.push({
          id: e.id,
          type: 'tool_call',
          name: e.name,
          arguments: e.arguments,
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
        return {
          ...s,
          pending: { ...s.pending, fileApprovals: [...s.pending.fileApprovals, e] },
        };
      }
      if (e.method === 'item/commandExecution/requestApproval') {
        if (s.pending.cmdApprovals.some((r) => r.id === e.id)) return s;
        return {
          ...s,
          pending: { ...s.pending, cmdApprovals: [...s.pending.cmdApprovals, e] },
        };
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
          pending: {
            ...s.pending,
            permissionApprovals: [...s.pending.permissionApprovals, e],
          },
        };
      }
      if (e.method === 'mcpServer/elicitation/request') {
        if (s.pending.elicitations.some((r) => r.id === e.id)) return s;
        return {
          ...s,
          pending: { ...s.pending, elicitations: [...s.pending.elicitations, e] },
        };
      }
      return s;
    }
    case 'OwnerInputResolved': {
      if (s.pending.ownerInput?.id !== e.id) return s;
      return {
        ...s,
        pending: { ...s.pending, ownerInput: null },
        posture: { ...s.posture, isAwaiting: false },
      };
    }
    case 'FileApprovalUpdated': {
      return {
        ...s,
        pending: {
          ...s.pending,
          fileApprovals: s.pending.fileApprovals.map((r) =>
            r.id === e.id ? { ...r, changes: e.changes } : r,
          ),
        },
      };
    }
    case 'ApprovalRequestResolved': {
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
    }
    case 'TurnCompleted': {
      const t = s.transcript.map((i) =>
        i.type === 'agent_message' || i.type === 'reasoning' ? { ...i, streaming: false } : i,
      );
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
        transcript: t,
        activeTurnId: null,
        posture: { ...s.posture, submittedThisTurn: false },
      };
    }
    case 'StateChange': {
      const nextVid = visitIdOf(e.newState.path, e.newState.visitCount);
      const note: TranscriptItem = {
        id: `state-${e.to}-${Date.now()}`,
        type: 'state_change',
        from: e.from,
        to: e.to,
        cause: e.cause,
        stateVisitId: nextVid,
      };
      return {
        ...s,
        state: e.newState,
        activeVisitId: nextVid,
        scopedPath: null, // un-pin scope on transition; follow active
        transcript: [...s.transcript, note],
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
    case 'PostureChange': {
      return { ...s, posture: { ...s.posture, ...e.posture } };
    }
    case 'ResyncRequired': {
      return s;
    }
    case 'FreshClearBoundary': {
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
    }
    case 'AbandonedThreadDiagnostic': {
      return { ...s, diagnostics: [...s.diagnostics, e].slice(-DIAGNOSTIC_LIMIT) };
    }
    case 'FrameworkNote': {
      const note: TranscriptItem = {
        id: e.id,
        type: 'framework_note',
        text: e.text,
        variant: e.variant,
        stateVisitId: vid,
      };
      return { ...s, transcript: [...s.transcript, note] };
    }
    default:
      return s;
  }
}

export type UiActions = {
  reply: (p: ReplyPayload) => Promise<void>;
  toggleDevMode: () => void;
  setScope: (path: string | null) => void;
};

export function readBootToken(
  search = typeof window === 'undefined' ? '' : window.location.search,
): string | null {
  const token = new URLSearchParams(search).get('token');
  return token && token.length > 0 ? token : null;
}

export function useAharnessSession(uiToken: string | null): UiState & UiActions {
  const [s, dispatch] = useReducer(reducer, undefined, createConnectingUiState);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const latestSnapshotEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!uiToken) {
      dispatch({ type: 'connectionLost' });
      return;
    }
    const token = uiToken;
    let disposed = false;

    function closeCurrent() {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    }

    function openStream() {
      if (disposed) return;
      closeCurrent();
      unsubscribeRef.current = subscribeToEvents({
        uiToken: token,
        skipThroughEventId: latestSnapshotEventIdRef.current,
        dispatch: (event) => dispatch({ type: 'event', e: event }),
        onConnectionLost: () => dispatch({ type: 'connectionLost' }),
        onResyncRequired: () =>
          resyncAndReconnect({
            closeCurrent,
            fetchSnapshot: () => fetchSnapshot({ uiToken: token }),
            hydrate: (snapshot) => {
              if (!disposed) {
                latestSnapshotEventIdRef.current = snapshot.latestEventId;
                dispatch({ type: 'hydrate', snapshot });
              }
            },
            reopen: openStream,
          }).catch(() => {
            if (!disposed) dispatch({ type: 'connectionLost' });
          }),
      });
    }

    fetchSnapshot({ uiToken: token })
      .then((snapshot) => {
        if (disposed) return;
        latestSnapshotEventIdRef.current = snapshot.latestEventId;
        dispatch({ type: 'hydrate', snapshot });
        openStream();
      })
      .catch(() => {
        if (!disposed) dispatch({ type: 'connectionLost' });
      });

    return () => {
      disposed = true;
      closeCurrent();
    };
  }, [uiToken]);

  const reply = useCallback(
    async (p: ReplyPayload) => {
      if (!uiToken) {
        throw new Error('UI token is unavailable');
      }
      const token = uiToken;
      try {
        await postReply(p, { uiToken: token });
        if (p.kind === 'approval') dispatch({ type: 'resolveApproval', id: p.requestId });
        if (p.kind === 'permission') dispatch({ type: 'resolvePermission', id: p.requestId });
        if (p.kind === 'elicitation') dispatch({ type: 'resolveElicitation', id: p.requestId });
        if (p.kind === 'owner-input') dispatch({ type: 'resolveOwnerInput' });
      } catch (error) {
        dispatch({
          type: 'replyFailed',
          error: error instanceof Error ? error.message : 'Reply failed',
        });
        throw error;
      }
    },
    [uiToken],
  );

  return {
    ...s,
    reply,
    toggleDevMode: () => dispatch({ type: 'toggleDevMode' }),
    setScope: (path: string | null) => dispatch({ type: 'setScope', path }),
  };
}

/**
 * Returns items the ActivePanel should render for a given scope. Drops
 * reserved tool calls + their outputs, synthetic orientation user_messages,
 * and framework info notes — unless `devMode` is on. Orientation notes are
 * always hidden because their content is surfaced in the dev-mode context
 * inspector instead.
 */
export function visibleItems(items: TranscriptItem[], devMode: boolean): TranscriptItem[] {
  return items.filter((i) => {
    if (i.type === 'framework_note' && i.variant === 'orientation') return false;
    if (devMode) return true;
    return isVisibleTranscriptItem(i);
  });
}

function isVisibleTranscriptItem(i: TranscriptItem): boolean {
  if (i.type === 'tool_call' && i.reserved) return false;
  if (i.type === 'tool_result' && i.reserved) return false;
  if (i.type === 'user_message' && i.synthetic) return false;
  if (i.type === 'framework_note' && (i.variant === 'orientation' || i.variant === 'info')) {
    return false;
  }
  if (i.type === 'state_change') return false;
  return true;
}

/**
 * True when the transcript contains no user-facing content yet — used by
 * activity heuristics to detect "codex hasn't streamed anything visible".
 * Counts orientation notes, reserved tool calls, and state_change markers
 * as invisible: they fire automatically during boot and would otherwise
 * mask the cold-boot gap.
 */
export function hasVisibleContent(items: TranscriptItem[]): boolean {
  for (const i of items) {
    if (isVisibleTranscriptItem(i)) return true;
  }
  return false;
}
