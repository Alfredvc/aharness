// Reducer + custom hook consuming production AppEvents. Produces UI state with
// filter rules that hide internal aharness noise (reserved tools, framework
// orientation) by default.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  fetchBootstrap,
  fetchVisitRows,
  postReply,
  readBootRunId,
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
  RunScopedAggregateStats,
  RunScopedApiEvent,
  RunScopedBootstrap,
  RunScopedCompactRow,
  RunScopedPendingCard,
  RunScopedPendingRequestSummary,
  RunScopedReplayDiagnostic,
  RunScopedRowPage,
  RunScopedStateVisit,
} from '../types/events.js';
import { runScopedCurrentStateToFsmState } from '../types/events.js';
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
const UNKNOWN_ROW_DIAGNOSTIC_LIMIT = 25;

export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOLS.has(name) || /^mcp__aharness(?:_|-).*__submit$/.test(name);
}

type TranscriptBase = {
  id: string;
  stateVisitId: string;
  seq?: number;
  eventId?: string;
  eventIds?: string[];
};

export type TranscriptItem =
  | (TranscriptBase & {
      id: string;
      type: 'agent_message';
      text: string;
      streaming: boolean;
    })
  | (TranscriptBase & {
      id: string;
      type: 'user_message';
      text: string;
      synthetic: boolean;
    })
  | (TranscriptBase & { id: string; type: 'reasoning'; text: string; streaming: boolean })
  | (TranscriptBase & {
      id: string;
      type: 'tool_call';
      name: string;
      arguments: string;
      status: 'pending' | 'approved' | 'declined' | 'completed' | 'failed';
      reserved: boolean;
    })
  | (TranscriptBase & {
      id: string;
      type: 'tool_result';
      name: string;
      output: string;
      ok: boolean;
      reserved: boolean;
    })
  | (TranscriptBase & {
      id: string;
      type: 'framework_note';
      text: string;
      variant: 'info' | 'warn' | 'orientation';
    })
  | (TranscriptBase & {
      id: string;
      type: 'state_change';
      from: string | null;
      to: string;
      cause: string;
    })
  | (TranscriptBase & {
      id: string;
      type: 'fresh_clear_boundary';
      reason: 'clearOnEntry';
      previousThreadId: string;
      nextThreadId: string;
      statePath: string;
    });

export type TurnRecord = {
  turnId: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'abort';
  endedAt: number;
  stateVisitId: string;
};

export type UiState = {
  mode: UiMode;
  run: RunMeta | null;
  latestEventId: string | null;
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
  stateVisits: RunScopedStateVisit[];
  statePathVisits: Record<string, string[]>;
  rowPageCursors: Record<string, string | null>;
  rowLoadStatus: Record<string, { loading: boolean; loaded: boolean; error: string | null }>;
  aggregateStats: RunScopedAggregateStats;
  history: Array<{ at: number; from: string | null; to: string; cause: string; visitId: string }>;
  turns: TurnRecord[];
  connection: 'live' | 'connecting' | 'lost';
  replyError: string | null;
  rowLoadError: string | null;
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

function emptyAggregateStats(): RunScopedAggregateStats {
  return { turnCount: 0 };
}

export function createConnectingUiState(): UiState {
  return {
    mode: 'run',
    run: null,
    latestEventId: null,
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
    stateVisits: [],
    statePathVisits: {},
    rowPageCursors: {},
    rowLoadStatus: {},
    aggregateStats: emptyAggregateStats(),
    history: [],
    turns: [],
    connection: 'connecting',
    replyError: null,
    rowLoadError: null,
    activeVisitId: null,
    scopedPath: null,
    devMode: false,
  };
}

function runMetaFromBootstrap(run: RunScopedBootstrap['run']): RunMeta {
  return {
    runId: run.runId,
    threadId: typeof run.threadId === 'string' ? run.threadId : '',
    repoRoot: typeof run.repoRoot === 'string' ? run.repoRoot : '',
    fsmFile: typeof run.fsmFile === 'string' ? run.fsmFile : '',
    fsmHash6: typeof run.fsmHash6 === 'string' ? run.fsmHash6 : '',
    codexPin: typeof run.codexPin === 'string' ? run.codexPin : '',
    startedAt: typeof run.startedAt === 'string' ? run.startedAt : '',
  };
}

function replayDiagnosticToUi(diagnostic: RunScopedReplayDiagnostic): AbandonedThreadDiagnostic {
  return {
    kind: 'AbandonedThreadDiagnostic',
    id: diagnostic.id ?? diagnostic.code,
    threadId: '',
    source: diagnostic.code,
    message: diagnostic.message,
  };
}

function historyFromStateVisits(visits: ReadonlyArray<RunScopedStateVisit>): UiState['history'] {
  return visits.map((visit) => ({
    at: Date.parse(visit.time) || 0,
    from: visit.from ?? null,
    to: visit.to,
    cause: visit.cause ?? 'boot',
    visitId: visit.id,
  }));
}

function cloneStatePathVisits(
  visits: Readonly<Record<string, ReadonlyArray<string>>>,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(visits).map(([path, ids]) => [path, [...ids]]));
}

function pendingFromSummaries(
  pending: ReadonlyArray<RunScopedPendingRequestSummary>,
): UiState['pending'] {
  const buckets = emptyPending();
  for (const summary of pending) {
    if (summary.status !== 'pending') continue;
    const card = summary.pendingCard;
    if (card === undefined) continue;
    switch (card.kind) {
      case 'owner-input':
        buckets.ownerInput = {
          kind: 'ServerRequest',
          id: card.id,
          method: card.method,
          questions: card.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            isOther: question.isOther,
            isSecret: question.isSecret,
            ...(question.choices === undefined ? {} : { choices: [...question.choices] }),
          })),
        };
        break;
      case 'file-approval':
        buckets.fileApprovals.push({
          kind: 'ServerRequest',
          id: card.id,
          requestId: card.requestId,
          method: card.method,
          threadId: card.threadId,
          turnId: card.turnId,
          itemId: card.itemId,
          ...(card.reason === undefined ? {} : { reason: card.reason }),
          ...(card.grantRoot === undefined ? {} : { grantRoot: card.grantRoot }),
          changes: [...card.changes],
        });
        break;
      case 'command-approval':
        buckets.cmdApprovals.push({
          kind: 'ServerRequest',
          id: card.id,
          requestId: card.requestId,
          method: card.method,
          threadId: card.threadId,
          turnId: card.turnId,
          itemId: card.itemId,
          ...(card.approvalId === undefined ? {} : { approvalId: card.approvalId }),
          ...(card.command === undefined ? {} : { command: card.command }),
          ...(card.cwd === undefined ? {} : { cwd: card.cwd }),
          ...(card.reason === undefined ? {} : { reason: card.reason }),
        });
        break;
      case 'permission-approval':
        buckets.permissionApprovals.push({
          kind: 'ServerRequest',
          id: card.id,
          requestId: card.requestId,
          method: card.method,
          threadId: card.threadId,
          turnId: card.turnId,
          itemId: card.itemId,
          cwd: card.cwd,
          permissions: card.permissions,
          ...(card.reason === undefined ? {} : { reason: card.reason }),
        });
        break;
      case 'elicitation':
        buckets.elicitations.push({
          kind: 'ServerRequest',
          id: card.id,
          requestId: card.requestId,
          method: card.method,
          threadId: card.threadId,
          turnId: card.turnId,
          serverName: card.serverName,
          mode: card.mode,
          message: card.message,
          ...(card.requestedSchema === undefined ? {} : { requestedSchema: card.requestedSchema }),
          ...(card.url === undefined ? {} : { url: card.url }),
          ...(card.elicitationId === undefined ? {} : { elicitationId: card.elicitationId }),
        });
        break;
    }
  }
  return buckets;
}

export function hydrateFromBootstrap(bootstrap: RunScopedBootstrap): UiState {
  const mode = bootstrap.mode ?? 'run';
  const state =
    bootstrap.currentState === null
      ? null
      : runScopedCurrentStateToFsmState(bootstrap.currentState);
  const activeVisitId = bootstrap.currentStateVisit?.id ?? null;
  const transcriptResult = transcriptFromCompactRows(bootstrap.recentRows, {
    fallbackVisitId: activeVisitId,
    live: false,
  });
  return {
    mode,
    run: runMetaFromBootstrap(bootstrap.run),
    latestEventId: bootstrap.latestEventId,
    posture: bootstrap.posture,
    activeTurnId: bootstrap.aggregateStats.activeTurnId ?? null,
    state,
    topology: bootstrap.topology ?? EMPTY_TOPOLOGY,
    transcript: transcriptResult.items,
    pending: pendingFromSummaries(bootstrap.pending),
    diagnostics: [
      ...bootstrap.diagnostics.map(replayDiagnosticToUi),
      ...transcriptResult.diagnostics,
    ].slice(-DIAGNOSTIC_LIMIT),
    stateVisits: [...bootstrap.stateVisits],
    statePathVisits: cloneStatePathVisits(bootstrap.statePathVisits),
    rowPageCursors: {},
    rowLoadStatus: {},
    aggregateStats: { ...bootstrap.aggregateStats },
    history: historyFromStateVisits(bootstrap.stateVisits),
    turns: [],
    connection: 'live',
    replyError: null,
    rowLoadError: null,
    activeVisitId,
    scopedPath: null,
    devMode: mode === 'inspect',
  };
}

// Legacy compatibility helper retained for flat /api/state fixtures and tests.
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

export function applyRunEvent(state: UiState, event: RunScopedApiEvent): UiState {
  return reduceRunEvent(state, event);
}

export function applyVisitRowPage(
  state: UiState,
  visitId: string,
  page: RunScopedRowPage,
): UiState {
  return mergeRowPage(state, visitId, page);
}

export function markConnectionLost(state: UiState): UiState {
  if (state.posture.isTerminal) return state;
  return { ...state, connection: 'lost' };
}

type Action =
  | { type: 'event'; e: AppEvent }
  | { type: 'runEvent'; e: RunScopedApiEvent }
  | { type: 'hydrate'; bootstrap: RunScopedBootstrap }
  | { type: 'legacyHydrate'; snapshot: UiSnapshot }
  | { type: 'connectionLost' }
  | { type: 'replyFailed'; error: string }
  | { type: 'resolveApproval'; id: string }
  | { type: 'resolvePermission'; id: string }
  | { type: 'resolveElicitation'; id: string }
  | { type: 'resolveOwnerInput' }
  | { type: 'rowLoadStarted'; visitId: string }
  | { type: 'rowPageLoaded'; visitId: string; page: RunScopedRowPage }
  | { type: 'rowLoadFailed'; visitId: string; error: string }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rowText(row: RunScopedCompactRow): string {
  return row.text ?? row.summary ?? row.label ?? '';
}

function rowVisitId(
  row: RunScopedCompactRow,
  options: { fallbackVisitId: string | null; live: boolean },
): string | null {
  if (row.stateVisitId !== undefined) return row.stateVisitId;
  return options.live ? options.fallbackVisitId : null;
}

function compactRowDiagnostic(row: RunScopedCompactRow): AbandonedThreadDiagnostic {
  return {
    kind: 'AbandonedThreadDiagnostic',
    id: `compact-row:${row.id}`,
    threadId: '',
    source: 'compactRow',
    message: `Ignored unsupported compact row kind "${row.kind}" from ${row.eventId}`,
  };
}

function transcriptItemFromCompactRow(
  row: RunScopedCompactRow,
  options: { fallbackVisitId: string | null; live: boolean },
): TranscriptItem | null {
  const stateVisitId = rowVisitId(row, options);
  if (stateVisitId === null) return null;
  const common = { seq: row.seq, eventId: row.eventId, stateVisitId };
  switch (row.kind) {
    case 'message': {
      const text = rowText(row);
      if (!text) return null;
      if (row.label === 'user_message' || row.label === 'user') {
        return {
          ...common,
          id: row.id,
          type: 'user_message',
          text,
          synthetic: looksLikeFrameworkOrientation(text),
        };
      }
      return { ...common, id: row.id, type: 'agent_message', text, streaming: false };
    }
    case 'reasoning': {
      const text = rowText(row);
      return text ? { ...common, id: row.id, type: 'reasoning', text, streaming: false } : null;
    }
    case 'tool': {
      const name = row.label ?? row.summary ?? 'tool';
      const status =
        row.status === 'completed' || row.status === 'failed' || row.status === 'approved'
          ? row.status
          : row.status === 'declined'
            ? 'declined'
            : 'pending';
      return {
        ...common,
        id: row.itemId ?? row.id,
        type: 'tool_call',
        name,
        arguments: row.summary ?? '',
        status,
        reserved: isReservedToolName(name),
      };
    }
    case 'request': {
      const text = row.summary ?? row.label ?? '';
      return text
        ? {
            ...common,
            id: row.id,
            type: 'framework_note',
            text,
            variant: 'info',
          }
        : null;
    }
    case 'framework_note': {
      const text = rowText(row);
      if (!text) return null;
      const variant =
        row.status === 'warn' ? 'warn' : row.status === 'orientation' ? 'orientation' : 'info';
      return { ...common, id: row.id, type: 'framework_note', text, variant };
    }
    case 'diagnostic': {
      const text = rowText(row);
      return text ? { ...common, id: row.id, type: 'framework_note', text, variant: 'warn' } : null;
    }
    case 'state_change': {
      return {
        ...common,
        id: row.id,
        type: 'state_change',
        from: readString(row.data?.['from']) ?? null,
        to:
          readString(row.data?.['to']) ??
          row.label ??
          row.summary ??
          stateVisitId.split('#')[0] ??
          '',
        cause: row.status ?? readString(row.data?.['cause']) ?? 'transition',
      };
    }
    case 'fresh_clear': {
      return {
        ...common,
        id: row.id,
        type: 'fresh_clear_boundary',
        reason: 'clearOnEntry',
        previousThreadId: readString(row.data?.['previousThreadId']) ?? '',
        nextThreadId: readString(row.data?.['nextThreadId']) ?? '',
        statePath:
          row.label ?? readString(row.data?.['statePath']) ?? stateVisitId.split('#')[0] ?? '',
      };
    }
    default:
      return null;
  }
}

function transcriptFromCompactRows(
  rows: ReadonlyArray<RunScopedCompactRow>,
  options: { fallbackVisitId: string | null; live: boolean },
): { items: TranscriptItem[]; diagnostics: AbandonedThreadDiagnostic[] } {
  const items: TranscriptItem[] = [];
  const diagnostics: AbandonedThreadDiagnostic[] = [];
  for (const row of rows) {
    const item = transcriptItemFromCompactRow(row, options);
    if (item === null) {
      if (diagnostics.length < UNKNOWN_ROW_DIAGNOSTIC_LIMIT) {
        diagnostics.push(compactRowDiagnostic(row));
      }
      continue;
    }
    items.push(item);
  }
  return { items, diagnostics };
}

function mergeTranscriptItems(
  existing: ReadonlyArray<TranscriptItem>,
  incoming: ReadonlyArray<TranscriptItem>,
): TranscriptItem[] {
  const byKey = new Map<string, TranscriptItem>();
  const keyByEventId = new Map<string, string>();
  const recordEventIds = (key: string, item: TranscriptItem) => {
    for (const eventId of transcriptEventIds(item)) {
      keyByEventId.set(eventId, key);
    }
  };
  for (const item of existing) {
    byKey.set(item.id, item);
    recordEventIds(item.id, item);
  }
  for (const item of incoming) {
    const duplicateKey = item.eventId === undefined ? undefined : keyByEventId.get(item.eventId);
    if (duplicateKey !== undefined) {
      const current = byKey.get(duplicateKey);
      if (current !== undefined) {
        byKey.set(duplicateKey, {
          ...current,
          eventIds: mergeEventIds(transcriptEventIds(current), transcriptEventIds(item)),
        });
      }
      continue;
    }
    byKey.set(item.id, item);
    recordEventIds(item.id, item);
  }
  return [...byKey.values()].sort((a, b) => {
    const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
    const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return a.id.localeCompare(b.id);
  });
}

function transcriptEventIds(item: TranscriptItem): string[] {
  return item.eventIds ?? (item.eventId === undefined ? [] : [item.eventId]);
}

function mergeEventIds(existing: ReadonlyArray<string>, incoming: ReadonlyArray<string>): string[] {
  return [...new Set([...existing, ...incoming])];
}

function mergeRowPage(state: UiState, visitId: string, page: RunScopedRowPage): UiState {
  const converted = transcriptFromCompactRows(page.rows, { fallbackVisitId: visitId, live: false });
  return {
    ...state,
    transcript: mergeTranscriptItems(state.transcript, converted.items),
    diagnostics: [...state.diagnostics, ...converted.diagnostics].slice(-DIAGNOSTIC_LIMIT),
    rowPageCursors: { ...state.rowPageCursors, [visitId]: page.nextCursor },
    rowLoadStatus: {
      ...state.rowLoadStatus,
      [visitId]: { loading: false, loaded: true, error: null },
    },
    rowLoadError: null,
  };
}

function compactRowFromRunEvent(e: RunScopedApiEvent): RunScopedCompactRow | null {
  const row = e.data?.['row'];
  if (!isRecord(row)) return null;
  const kind = readString(row['kind']);
  if (kind === undefined) return null;
  const label = readString(row['label']);
  const text = readString(row['text']);
  const status = readString(row['status']);
  const summary = readString(row['summary']);
  if (label === undefined && text === undefined && status === undefined && summary === undefined) {
    return null;
  }
  const data = isRecord(row['data']) ? row['data'] : undefined;
  const stateVisitId = e.stateVisitId ?? readString(row['stateVisitId']);
  const turnId = e.turnId ?? readString(row['turnId']);
  const itemId = e.itemId ?? readString(row['itemId']);
  const requestId = e.requestId ?? readString(row['requestId']);
  return {
    id: readString(row['id']) ?? `${e.id}:row`,
    eventId: e.id,
    seq: e.seq,
    time: e.time,
    type: e.type,
    kind,
    ...(stateVisitId === undefined ? {} : { stateVisitId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(label !== undefined ? { label } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(readNumber(row['elapsedMs']) === undefined
      ? {}
      : { elapsedMs: readNumber(row['elapsedMs']) }),
    ...(data === undefined ? {} : { data }),
  };
}

function pendingCardFromUnknown(value: unknown): RunScopedPendingCard | null {
  if (!isRecord(value)) return null;
  const kind = readString(value['kind']);
  const id = readString(value['id']);
  const requestId = readString(value['requestId']);
  if (kind === undefined || id === undefined || requestId === undefined) return null;
  if (kind === 'owner-input' && value['method'] === 'item/tool/requestUserInput') {
    const questions = Array.isArray(value['questions']) ? value['questions'] : null;
    if (questions === null) return null;
    const parsed = questions
      .map((question) => {
        if (!isRecord(question)) return null;
        const qid = readString(question['id']);
        const header = typeof question['header'] === 'string' ? question['header'] : undefined;
        const text = readString(question['question']);
        const isOther = readBoolean(question['isOther']);
        const isSecret = readBoolean(question['isSecret']);
        if (
          qid === undefined ||
          header === undefined ||
          text === undefined ||
          isOther === undefined ||
          isSecret === undefined
        ) {
          return null;
        }
        return {
          id: qid,
          header,
          question: text,
          isOther,
          isSecret,
          ...(readStringArray(question['choices']) === undefined
            ? {}
            : { choices: readStringArray(question['choices']) }),
        };
      })
      .filter((question): question is NonNullable<typeof question> => question !== null);
    if (parsed.length !== questions.length) return null;
    return { kind, id, requestId, method: value['method'], questions: parsed };
  }
  const threadId = readString(value['threadId']);
  const turnId = readString(value['turnId']);
  const itemId = readString(value['itemId']);
  if (kind === 'file-approval' && value['method'] === 'item/fileChange/requestApproval') {
    if (threadId === undefined || turnId === undefined || itemId === undefined) return null;
    const changes = Array.isArray(value['changes']) ? value['changes'] : null;
    if (changes === null) return null;
    return {
      kind,
      id,
      requestId,
      method: value['method'],
      threadId,
      turnId,
      itemId,
      ...(readString(value['reason']) === undefined ? {} : { reason: readString(value['reason']) }),
      ...(readString(value['grantRoot']) === undefined
        ? {}
        : { grantRoot: readString(value['grantRoot']) }),
      changes: changes as FileChangeApproval['changes'],
    };
  }
  if (kind === 'command-approval' && value['method'] === 'item/commandExecution/requestApproval') {
    if (threadId === undefined || turnId === undefined || itemId === undefined) return null;
    return {
      kind,
      id,
      requestId,
      method: value['method'],
      threadId,
      turnId,
      itemId,
      ...(readString(value['approvalId']) === undefined
        ? {}
        : { approvalId: readString(value['approvalId']) }),
      ...(readString(value['command']) === undefined
        ? {}
        : { command: readString(value['command']) }),
      ...(readString(value['cwd']) === undefined ? {} : { cwd: readString(value['cwd']) }),
      ...(readString(value['reason']) === undefined ? {} : { reason: readString(value['reason']) }),
    };
  }
  if (kind === 'permission-approval' && value['method'] === 'item/permissions/requestApproval') {
    const cwd = readString(value['cwd']);
    if (
      threadId === undefined ||
      turnId === undefined ||
      itemId === undefined ||
      cwd === undefined
    ) {
      return null;
    }
    return {
      kind,
      id,
      requestId,
      method: value['method'],
      threadId,
      turnId,
      itemId,
      cwd,
      permissions: value['permissions'],
      ...(readString(value['reason']) === undefined ? {} : { reason: readString(value['reason']) }),
    };
  }
  if (kind === 'elicitation' && value['method'] === 'mcpServer/elicitation/request') {
    const nullableTurnId =
      typeof value['turnId'] === 'string' || value['turnId'] === null ? value['turnId'] : undefined;
    const serverName = readString(value['serverName']);
    const mode = value['mode'] === 'form' || value['mode'] === 'url' ? value['mode'] : undefined;
    const message = readString(value['message']);
    if (
      threadId === undefined ||
      nullableTurnId === undefined ||
      serverName === undefined ||
      mode === undefined ||
      message === undefined
    ) {
      return null;
    }
    return {
      kind,
      id,
      requestId,
      method: value['method'],
      threadId,
      turnId: nullableTurnId,
      serverName,
      mode,
      message,
      ...(value['requestedSchema'] === undefined
        ? {}
        : { requestedSchema: value['requestedSchema'] }),
      ...(readString(value['url']) === undefined ? {} : { url: readString(value['url']) }),
      ...(readString(value['elicitationId']) === undefined
        ? {}
        : { elicitationId: readString(value['elicitationId']) }),
    };
  }
  return null;
}

function addPendingCard(state: UiState, e: RunScopedApiEvent): UiState {
  const pendingCard = pendingCardFromUnknown(e.data?.['pendingCard']);
  if (pendingCard === null) return state;
  const pending = pendingFromSummaries([
    {
      requestId: e.requestId ?? pendingCard.requestId,
      status: 'pending',
      createdAt: e.time,
      updatedAt: e.time,
      lastEventId: e.id,
      pendingCard,
    },
  ]);
  return {
    ...state,
    pending: {
      ownerInput: pending.ownerInput ?? state.pending.ownerInput,
      fileApprovals: mergeById(state.pending.fileApprovals, pending.fileApprovals),
      cmdApprovals: mergeById(state.pending.cmdApprovals, pending.cmdApprovals),
      permissionApprovals: mergeById(
        state.pending.permissionApprovals,
        pending.permissionApprovals,
      ),
      elicitations: mergeById(state.pending.elicitations, pending.elicitations),
    },
  };
}

function mergeById<T extends { id: string }>(
  current: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeTurns(current: ReadonlyArray<TurnRecord>, incoming: TurnRecord): TurnRecord[] {
  const byId = new Map(current.map((item) => [item.turnId, item]));
  byId.set(incoming.turnId, incoming);
  return [...byId.values()];
}

function runEventBaseState(previous: UiState, e: RunScopedApiEvent): UiState {
  const live =
    previous.connection === 'live' ? previous : { ...previous, connection: 'live' as const };
  return { ...live, latestEventId: e.id, replyError: null };
}

function appendRunEventRow(state: UiState, e: RunScopedApiEvent): UiState {
  const row = compactRowFromRunEvent(e);
  if (row === null) return state;
  const converted = transcriptFromCompactRows([row], {
    fallbackVisitId: state.activeVisitId,
    live: true,
  });
  return {
    ...state,
    transcript: mergeTranscriptItems(state.transcript, converted.items),
    diagnostics: [...state.diagnostics, ...converted.diagnostics].slice(-DIAGNOSTIC_LIMIT),
  };
}

function stateVisitFromRunEvent(e: RunScopedApiEvent): RunScopedStateVisit | null {
  const data = e.data;
  const path = readString(data?.['path']) ?? readString(data?.['to']) ?? e.stateVisitId;
  const to = readString(data?.['to']) ?? path;
  if (path === undefined || to === undefined) return null;
  return {
    id: e.stateVisitId ?? readString(data?.['stateVisitId']) ?? `${path}#${e.seq}`,
    path,
    seq: e.seq,
    time: e.time,
    from: data?.['from'] === null ? null : readString(data?.['from']),
    to,
    cause: readString(data?.['cause']) ?? 'transition',
  };
}

function updateStateVisitIndexes(state: UiState, visit: RunScopedStateVisit): UiState {
  const visits = [
    ...state.stateVisits.filter((candidate) => candidate.id !== visit.id),
    visit,
  ].sort((a, b) => a.seq - b.seq);
  const pathVisits = cloneStatePathVisits(state.statePathVisits);
  pathVisits[visit.path] = [
    ...(pathVisits[visit.path] ?? []).filter((id) => id !== visit.id),
    visit.id,
  ];
  return {
    ...state,
    stateVisits: visits,
    statePathVisits: pathVisits,
    history: historyFromStateVisits(visits),
  };
}

function currentStateFromRunEvent(e: RunScopedApiEvent): FsmState | null {
  const data = e.data;
  const path = readString(data?.['path']);
  if (path === undefined) return null;
  const exits = Array.isArray(data?.['exits'])
    ? data?.['exits']
        .map((exit) => {
          if (!isRecord(exit)) return null;
          const name = readString(exit['name']);
          if (name === undefined) return null;
          return {
            name,
            kind: exit['kind'] === 'await' ? 'await' : 'submit',
            ...(readNumber(exit['branchCount']) === undefined
              ? {}
              : { branchCount: readNumber(exit['branchCount']) }),
          };
        })
        .filter(
          (exit): exit is { name: string; kind: 'submit' | 'await'; branchCount?: number } =>
            exit !== null,
        )
    : [];
  return runScopedCurrentStateToFsmState({
    path,
    ...(readString(data?.['leaf']) === undefined ? {} : { leaf: readString(data?.['leaf']) }),
    ...(data?.['kind'] === 'stateful' ||
    data?.['kind'] === 'terminal' ||
    data?.['kind'] === 'passive' ||
    data?.['kind'] === 'final'
      ? { kind: data['kind'] }
      : {}),
    ...(readNumber(data?.['visitCount']) === undefined
      ? {}
      : { visitCount: readNumber(data?.['visitCount']) }),
    exits,
  });
}

function mergeAggregateFromRunEvent(state: UiState, e: RunScopedApiEvent): UiState {
  const aggregate = { ...state.aggregateStats };
  const data = e.data ?? {};
  if (e.type === 'run.started') {
    aggregate.status = 'running';
    aggregate.startedAt = readString(data['startedAt']) ?? e.time;
  } else if (e.type === 'run.completed') {
    aggregate.status = readString(data['status']) ?? 'completed';
    aggregate.endedAt = readString(data['endedAt']) ?? e.time;
  } else if (e.type === 'run.failed') {
    aggregate.status = 'failed';
    aggregate.endedAt = readString(data['endedAt']) ?? e.time;
  } else if (e.type === 'turn.started') {
    aggregate.turnCount += 1;
    aggregate.activeTurnId = e.turnId ?? readString(data['turnId']);
  } else if (e.type === 'turn.completed') {
    const turnId = e.turnId ?? readString(data['turnId']);
    if (turnId === undefined || aggregate.activeTurnId === turnId) delete aggregate.activeTurnId;
  } else if (e.type === 'token.updated' || e.type === 'subthread.token.updated') {
    const total = isRecord(data['total']) ? data['total'] : data;
    for (const key of [
      'totalTokens',
      'inputTokens',
      'cachedInputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'modelContextWindow',
    ] as const) {
      const value = readNumber(key === 'modelContextWindow' ? data[key] : total[key]);
      if (value !== undefined) aggregate[key] = value;
    }
  }
  return { ...state, aggregateStats: aggregate };
}

function reduceRunEvent(previous: UiState, e: RunScopedApiEvent): UiState {
  let state = runEventBaseState(previous, e);
  state = mergeAggregateFromRunEvent(state, e);
  switch (e.type) {
    case 'run.completed':
    case 'run.failed':
      return {
        ...appendRunEventRow(state, e),
        posture: {
          ...state.posture,
          isTerminal: true,
          isAwaiting: false,
          submittedThisTurn: false,
          open: false,
        },
      };
    case 'run.started':
      return appendRunEventRow(state, e);
    case 'state.changed': {
      const visit = stateVisitFromRunEvent(e);
      if (visit !== null) state = updateStateVisitIndexes(state, visit);
      const currentState = currentStateFromRunEvent(e);
      const activeVisitId = visit?.id ?? state.activeVisitId;
      return appendRunEventRow(
        {
          ...state,
          state: currentState ?? state.state,
          activeVisitId,
          scopedPath: null,
          posture: {
            ...state.posture,
            isAwaiting:
              currentState === null
                ? state.posture.isAwaiting
                : Boolean(currentState.awaitsOwnerText),
            isTerminal: currentState?.kind === 'terminal' ? true : state.posture.isTerminal,
          },
        },
        e,
      );
    }
    case 'posture.changed': {
      const posture = isRecord(e.data?.['posture']) ? e.data['posture'] : (e.data ?? {});
      return {
        ...appendRunEventRow(state, e),
        posture: {
          ...state.posture,
          ...(readBoolean(posture['isTerminal']) === undefined
            ? {}
            : { isTerminal: readBoolean(posture['isTerminal']) }),
          ...(readBoolean(posture['isAwaiting']) === undefined
            ? {}
            : { isAwaiting: readBoolean(posture['isAwaiting']) }),
          ...(readBoolean(posture['submittedThisTurn']) === undefined
            ? {}
            : { submittedThisTurn: readBoolean(posture['submittedThisTurn']) }),
          ...(readBoolean(posture['open']) === undefined
            ? {}
            : { open: readBoolean(posture['open']) }),
        },
      };
    }
    case 'turn.started':
      return {
        ...appendRunEventRow(state, e),
        activeTurnId: e.turnId ?? readString(e.data?.['turnId']) ?? null,
      };
    case 'turn.completed': {
      const turnId = e.turnId ?? readString(e.data?.['turnId']) ?? state.activeTurnId;
      const finishReason = readString(e.data?.['finishReason']);
      const next = appendRunEventRow(state, e);
      return {
        ...next,
        activeTurnId: null,
        turns:
          turnId === null
            ? next.turns
            : mergeTurns(next.turns, {
                turnId,
                finishReason:
                  finishReason === 'tool_calls' ||
                  finishReason === 'length' ||
                  finishReason === 'abort'
                    ? finishReason
                    : 'stop',
                endedAt: Date.parse(e.time) || Date.now(),
                stateVisitId: e.stateVisitId ?? next.activeVisitId ?? '__boot',
              }),
        transcript: next.transcript.map((item) =>
          item.type === 'agent_message' || item.type === 'reasoning'
            ? { ...item, streaming: false }
            : item,
        ),
        posture: { ...next.posture, submittedThisTurn: false },
      };
    }
    case 'model.delta': {
      const itemId = e.itemId ?? readString(e.data?.['itemId']) ?? `${e.id}:message`;
      const text = readString(e.data?.['delta']) ?? readString(e.data?.['text']) ?? '';
      const reasoning = e.data?.['reasoning'] === true || e.data?.['kind'] === 'reasoning';
      const visitId = e.stateVisitId ?? state.activeVisitId ?? '__boot';
      const idx = state.transcript.findIndex((item) => item.id === itemId);
      const transcript = [...state.transcript];
      if (idx >= 0) {
        const prev = transcript[idx];
        if (prev?.type === 'agent_message' || prev?.type === 'reasoning') {
          transcript[idx] = {
            ...prev,
            text: prev.text + text,
            streaming: true,
            seq: e.seq,
            eventId: e.id,
            eventIds: mergeEventIds(transcriptEventIds(prev), [e.id]),
          };
        }
      } else if (text) {
        transcript.push({
          id: itemId,
          type: reasoning ? 'reasoning' : 'agent_message',
          text,
          streaming: true,
          stateVisitId: visitId,
          seq: e.seq,
          eventId: e.id,
          eventIds: [e.id],
        });
      }
      return { ...state, transcript };
    }
    case 'item.started':
    case 'item.completed':
    case 'raw_response_item.completed':
      return appendRunEventRow(state, e);
    case 'request.created':
    case 'request.updated':
      return appendRunEventRow(addPendingCard(state, e), e);
    case 'request.resolved':
    case 'reply.resolved': {
      const requestId = e.requestId ?? readString(e.data?.['requestId']);
      if (requestId === undefined) return appendRunEventRow(state, e);
      const ok =
        e.type === 'request.resolved' ||
        e.data?.['ok'] === true ||
        e.data?.['status'] === 'accepted';
      const pending = ok
        ? {
            ...state.pending,
            ownerInput:
              state.pending.ownerInput?.id === requestId ? null : state.pending.ownerInput,
            fileApprovals: state.pending.fileApprovals.filter(
              (item) => item.id !== requestId && item.requestId !== requestId,
            ),
            cmdApprovals: state.pending.cmdApprovals.filter(
              (item) => item.id !== requestId && item.requestId !== requestId,
            ),
            permissionApprovals: state.pending.permissionApprovals.filter(
              (item) => item.id !== requestId && item.requestId !== requestId,
            ),
            elicitations: state.pending.elicitations.filter(
              (item) => item.id !== requestId && item.requestId !== requestId,
            ),
          }
        : state.pending;
      return appendRunEventRow({ ...state, pending }, e);
    }
    case 'reply.submitted':
      return appendRunEventRow(state, e);
    case 'framework.note':
      return appendRunEventRow(state, e);
    case 'fresh_clear.boundary': {
      const next = appendRunEventRow(state, e);
      return {
        ...next,
        pending: emptyPending(),
        turns: [],
        transcript: next.transcript.filter((item) => item.type === 'fresh_clear_boundary'),
        activeTurnId: null,
        posture: { ...next.posture, isAwaiting: false, submittedThisTurn: false },
      };
    }
    case 'diagnostic.abandoned_thread': {
      const diagnostic: AbandonedThreadDiagnostic = {
        kind: 'AbandonedThreadDiagnostic',
        id: readString(e.data?.['id']) ?? e.id,
        threadId: e.threadId ?? '',
        source: readString(e.data?.['source']) ?? e.type,
        message: readString(e.data?.['message']) ?? 'abandoned thread diagnostic',
      };
      const next = appendRunEventRow(state, e);
      return { ...next, diagnostics: [...next.diagnostics, diagnostic].slice(-DIAGNOSTIC_LIMIT) };
    }
    default:
      return appendRunEventRow(state, e);
  }
}

function reducer(s: UiState, a: Action): UiState {
  if (a.type === 'hydrate') {
    return hydrateFromBootstrap(a.bootstrap);
  }
  if (a.type === 'legacyHydrate') {
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
  if (a.type === 'rowLoadStarted') {
    return {
      ...s,
      rowLoadError: null,
      rowLoadStatus: {
        ...s.rowLoadStatus,
        [a.visitId]: {
          loading: true,
          loaded: s.rowLoadStatus[a.visitId]?.loaded ?? false,
          error: null,
        },
      },
    };
  }
  if (a.type === 'rowPageLoaded') {
    return mergeRowPage(s, a.visitId, a.page);
  }
  if (a.type === 'rowLoadFailed') {
    return {
      ...s,
      rowLoadError: a.error,
      rowLoadStatus: {
        ...s.rowLoadStatus,
        [a.visitId]: {
          loading: false,
          loaded: s.rowLoadStatus[a.visitId]?.loaded ?? false,
          error: a.error,
        },
      },
    };
  }
  if (a.type === 'toggleDevMode') {
    return { ...s, devMode: !s.devMode };
  }
  if (a.type === 'setScope') {
    return { ...s, scopedPath: a.path };
  }
  if (a.type === 'runEvent') {
    return reduceRunEvent(s, a.e);
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
  requestRowsForStatePath?: (path: string) => Promise<void>;
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
  const latestEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!uiToken) {
      dispatch({ type: 'connectionLost' });
      return;
    }
    const token = uiToken;
    let runId: string;
    try {
      runId = readBootRunId();
    } catch {
      dispatch({ type: 'connectionLost' });
      return;
    }
    let disposed = false;

    function closeCurrent() {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    }

    function openStream(afterEventId = latestEventIdRef.current) {
      if (disposed) return;
      closeCurrent();
      unsubscribeRef.current = subscribeToEvents({
        runId,
        uiToken: token,
        afterEventId,
        onRunEvent: (event) => {
          latestEventIdRef.current = event.id;
          dispatch({ type: 'runEvent', e: event });
        },
        onConnectionLost: () => dispatch({ type: 'connectionLost' }),
        onResyncRequired: () =>
          resyncAndReconnect({
            closeCurrent,
            fetchBootstrap: () => fetchBootstrap({ runId, uiToken: token }),
            hydrate: (bootstrap) => {
              if (!disposed) {
                latestEventIdRef.current = bootstrap.latestEventId;
                dispatch({ type: 'hydrate', bootstrap });
              }
            },
            reopen: openStream,
          }).catch(() => {
            if (!disposed) dispatch({ type: 'connectionLost' });
          }),
      });
    }

    fetchBootstrap({ runId, uiToken: token })
      .then((bootstrap) => {
        if (disposed) return;
        latestEventIdRef.current = bootstrap.latestEventId;
        dispatch({ type: 'hydrate', bootstrap });
        openStream(bootstrap.latestEventId);
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
      if (s.mode === 'inspect') {
        const error = new Error('Replies are unavailable in inspect mode');
        dispatch({ type: 'replyFailed', error: error.message });
        throw error;
      }
      const runId = s.run?.runId;
      if (!runId) {
        const error = new Error('runId is unavailable');
        dispatch({ type: 'replyFailed', error: error.message });
        throw error;
      }
      const token = uiToken;
      try {
        await postReply(p, { runId, uiToken: token });
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
    [s.mode, s.run?.runId, uiToken],
  );

  const requestRowsForStatePath = useCallback(
    async (path: string) => {
      if (!uiToken) throw new Error('UI token is unavailable');
      const runId = s.run?.runId;
      if (!runId) throw new Error('runId is unavailable');
      const visits = s.statePathVisits[path] ?? [];
      await Promise.all(
        visits.map(async (visitId) => {
          const status = s.rowLoadStatus[visitId];
          const cursor = s.rowPageCursors[visitId];
          if (status?.loading || (status?.loaded && cursor === null)) return;
          dispatch({ type: 'rowLoadStarted', visitId });
          try {
            const page = await fetchVisitRows({
              runId,
              visitId,
              uiToken,
              cursor: cursor ?? null,
            });
            dispatch({ type: 'rowPageLoaded', visitId, page });
          } catch (error) {
            dispatch({
              type: 'rowLoadFailed',
              visitId,
              error: error instanceof Error ? error.message : 'Row load failed',
            });
          }
        }),
      );
    },
    [s.rowLoadStatus, s.rowPageCursors, s.run?.runId, s.statePathVisits, uiToken],
  );

  return {
    ...s,
    reply,
    requestRowsForStatePath,
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
