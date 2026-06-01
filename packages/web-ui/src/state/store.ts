// Reducer + custom hook consuming run-scoped JSONL bootstrap, row pages, and
// live run events. Produces UI state with filter rules that always hide
// aharness submit plumbing and hide other internal noise by default.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  fetchBootstrap,
  fetchRecentRows,
  fetchVisitRows,
  postReply,
  readBootRunId,
  resyncAndReconnect,
  retainStateAfterReplyFailure,
  subscribeToEvents,
} from '../api/client.js';
import type {
  FsmState,
  Posture,
  RunMeta,
  FileChangeApproval,
  CommandApproval,
  OwnerInputRequest,
  PermissionApproval,
  ElicitationRequest,
  OwnerChoiceRequest,
  AbandonedThreadDiagnostic,
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

// Tool names used by aharness' internal submit channel. They are protocol
// plumbing, not user work, so the transcript hides them even in dev mode.
const SUBMIT_TOOLS = new Set<string>([
  'aharness_submit',
  'mcp__aharness_fsm__submit',
  'mcp:aharness_fsm/submit',
]);

// Tools the UI hides from the default transcript view: request_user_input is
// codex's built-in owner-yield tool whose ServerRequest is rendered separately.
export const RESERVED_TOOLS = new Set<string>([...SUBMIT_TOOLS, 'request_user_input']);
const DIAGNOSTIC_LIMIT = 100;
const UNKNOWN_ROW_DIAGNOSTIC_LIMIT = 25;
const RUN_LEVEL_VISIT_ID = '__run';

function isSubmitToolName(name: string): boolean {
  return SUBMIT_TOOLS.has(name) || /^mcp__aharness(?:_|-).*__submit$/.test(name);
}

export function isReservedToolName(name: string): boolean {
  return name === 'request_user_input' || isSubmitToolName(name);
}

const KNOWN_COMPACT_ROW_KINDS = new Set<string>([
  'message',
  'reasoning',
  'tool',
  'request',
  'reply',
  'framework_note',
  'diagnostic',
  'run_lifecycle',
  'state_change',
  'transition_failure',
  'fresh_clear',
  // Legacy/protocol bookkeeping row shape. Visible dynamic tools are emitted
  // through canonical `tool` rows; raw dynamicToolCall rows should stay quiet.
  'dynamicToolCall',
]);

type TranscriptBase = {
  id: string;
  stateVisitId: string;
  turnId?: string;
  seq?: number;
  eventId?: string;
  eventIds?: string[];
};

export type ToolDisplayKind = 'command' | 'read' | 'list' | 'search' | 'mcp' | 'subagent' | 'tool';
export type SubagentAction = 'spawn' | 'send' | 'wait' | 'resume' | 'close';

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
      preview: string;
      status: 'pending' | 'approved' | 'declined' | 'completed' | 'failed';
      reserved: boolean;
      elapsedMs?: number;
      category?: 'tool' | 'subagent';
      displayKind?: ToolDisplayKind;
      command?: string;
      argumentsPreview?: string;
      target?: string;
      subagentAction?: SubagentAction;
      agentNickname?: string;
      agentRole?: string;
      receiverThreadIds?: string[];
      promptPreview?: string;
      responsePreview?: string;
      errorPreview?: string;
      output?: string;
      ok?: boolean;
      resultId?: string;
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
      type: 'compact_status';
      category: 'request' | 'reply' | 'diagnostic' | 'lifecycle';
      label: string;
      status?: string;
      summary?: string;
      reserved?: boolean;
      elapsedMs?: number;
    })
  | (TranscriptBase & {
      id: string;
      type: 'state_change';
      from: string | null;
      to: string;
      cause: string;
      visitCount?: number;
      stateKind?: string;
      open?: boolean;
      awaiting?: boolean;
      model?: string;
      effort?: string;
    })
  | (TranscriptBase & {
      id: string;
      type: 'transition_failure';
      summary: string;
      status: 'failed';
      toolName?: string;
      state?: string;
      exit?: string;
    })
  | (TranscriptBase & {
      id: string;
      type: 'fresh_clear_boundary';
      reason: 'clearOnEntry';
      previousThreadId: string;
      nextThreadId: string;
      statePath: string;
    });

export type ExplorationGroupChild = {
  id: string;
  displayKind: 'read' | 'list' | 'search';
  name: string;
  preview: string;
  status: Extract<TranscriptItem, { type: 'tool_call' }>['status'];
  eventIds: string[];
};

export type ExplorationGroupItem = {
  type: 'exploration_group';
  id: string;
  stateVisitId: string;
  turnId?: string;
  seq?: number;
  eventIds: string[];
  status: 'pending' | 'completed';
  title: 'Exploring' | 'Explored';
  children: ExplorationGroupChild[];
};

export type TranscriptDisplayItem = TranscriptItem | ExplorationGroupItem;

type GroupableExplorationTool = Extract<TranscriptItem, { type: 'tool_call' }> & {
  displayKind: 'read' | 'list' | 'search';
  turnId: string;
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
  latestEventId: string | null;
  posture: Posture;
  activeTurnId: string | null;
  state: FsmState | null;
  latestContext?: Record<string, unknown>;
  topology: Topology;
  transcript: TranscriptItem[];
  pending: {
    fileApprovals: FileChangeApproval[];
    cmdApprovals: CommandApproval[];
    permissionApprovals: PermissionApproval[];
    elicitations: ElicitationRequest[];
    ownerInput: OwnerInputRequest | null;
    ownerChoice: OwnerChoiceRequest | null;
  };
  diagnostics: AbandonedThreadDiagnostic[];
  stateVisits: RunScopedStateVisit[];
  statePathVisits: Record<string, string[]>;
  rowPageCursors: Record<string, string | null>;
  rowLoadStatus: Record<
    string,
    { loading: boolean; loaded: boolean; error: string | null; storedRows?: number }
  >;
  recentRowsCursor: string | null;
  recentRowsLoadStatus: {
    loading: boolean;
    loaded: boolean;
    error: string | null;
    storedRows?: number;
  };
  aggregateStats: RunScopedAggregateStats;
  history: Array<{ at: number; from: string | null; to: string; cause: string; visitId: string }>;
  turns: TurnRecord[];
  connection: 'live' | 'connecting' | 'lost';
  replyError: string | null;
  rowLoadError: string | null;
  activeVisitId: string | null;
  scopedPath: string | null; // selected state path (covers all visits); null = run transcript
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
  | { kind: 'owner-choice'; state: string; visitCount: number; label: string }
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
    ownerChoice: null,
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
    recentRowsCursor: null,
    recentRowsLoadStatus: { loading: false, loaded: false, error: null },
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
    const card = summary.pendingCard;
    if (card === undefined) continue;
    if (summary.status !== 'pending' && card.kind !== 'owner-choice') continue;
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
      case 'owner-choice':
        buckets.ownerChoice = {
          kind: 'OwnerChoice',
          id: card.id,
          requestId: card.requestId,
          state: card.state,
          visitCount: card.visitCount,
          question: card.question,
          options: card.options.map((option) => ({ label: option.label })),
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
  const latestContext = state?.context;
  const activeVisitId = bootstrap.currentStateVisit?.id ?? null;
  const transcriptResult = transcriptFromCompactRows(bootstrap.recentRows, {
    fallbackVisitId: RUN_LEVEL_VISIT_ID,
    live: false,
  });
  return {
    mode,
    run: runMetaFromBootstrap(bootstrap.run),
    latestEventId: bootstrap.latestEventId,
    posture: bootstrap.posture,
    activeTurnId: bootstrap.aggregateStats.activeTurnId ?? null,
    state,
    ...(latestContext === undefined ? {} : { latestContext }),
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
    recentRowsCursor: null,
    recentRowsLoadStatus: {
      loading: false,
      loaded: false,
      error: null,
      storedRows: bootstrap.recentRows.length,
    },
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

export function applyRecentRowPage(state: UiState, page: RunScopedRowPage): UiState {
  return mergeRecentRowPage(state, page);
}

export function markConnectionLost(state: UiState): UiState {
  if (state.posture.isTerminal) return state;
  return { ...state, connection: 'lost' };
}

type Action =
  | { type: 'runEvent'; e: RunScopedApiEvent }
  | { type: 'hydrate'; bootstrap: RunScopedBootstrap }
  | { type: 'connectionLost' }
  | { type: 'replyFailed'; error: string }
  | { type: 'resolveApproval'; id: string }
  | { type: 'resolvePermission'; id: string }
  | { type: 'resolveElicitation'; id: string }
  | { type: 'resolveOwnerInput' }
  | { type: 'resolveOwnerChoice'; state: string; visitCount: number }
  | { type: 'rowLoadStarted'; visitId: string }
  | { type: 'rowPageLoaded'; visitId: string; page: RunScopedRowPage }
  | { type: 'rowLoadFailed'; visitId: string; error: string }
  | { type: 'recentRowsLoadStarted' }
  | { type: 'recentRowsPageLoaded'; page: RunScopedRowPage }
  | { type: 'recentRowsLoadFailed'; error: string }
  | { type: 'toggleDevMode' }
  | { type: 'setScope'; path: string | null };

function looksLikeFrameworkOrientation(text: string): boolean {
  if (!text) return false;
  return /^You have entered\s+`/.test(text) || /^\[aharness\]\s+Now in state\s+"/.test(text);
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

function readDisplayKind(value: unknown): ToolDisplayKind | undefined {
  switch (value) {
    case 'command':
    case 'read':
    case 'list':
    case 'search':
    case 'mcp':
    case 'subagent':
    case 'tool':
      return value;
    default:
      return undefined;
  }
}

function readSubagentAction(value: unknown): SubagentAction | undefined {
  switch (value) {
    case 'spawn':
    case 'send':
    case 'wait':
    case 'resume':
    case 'close':
      return value;
    default:
      return undefined;
  }
}

function rowText(row: RunScopedCompactRow): string {
  return row.text ?? row.summary ?? row.label ?? '';
}

function rowBodyText(row: RunScopedCompactRow): string {
  return row.text ?? '';
}

function isUserMessageLabel(label: string | undefined): boolean {
  return label === 'userMessage' || label === 'user_message' || label === 'user';
}

function compactMessageType(label: string | undefined): 'user_message' | 'agent_message' {
  if (isUserMessageLabel(label)) return 'user_message';
  if (
    label === 'agentMessage' ||
    label === 'agent_message' ||
    label === 'assistant' ||
    label === 'model'
  ) {
    return 'agent_message';
  }
  return 'agent_message';
}

function rowPreview(row: RunScopedCompactRow): string {
  return (
    readString(row.data?.['preview']) ??
    readString(row.data?.['command']) ??
    readString(row.data?.['summary']) ??
    row.summary ??
    row.text ??
    ''
  );
}

function compactStatus(
  status: string | undefined,
): Extract<TranscriptItem, { type: 'tool_call' }>['status'] {
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'approved' ||
    status === 'declined'
  ) {
    return status;
  }
  if (status === 'accepted' || status === 'resolved') return 'completed';
  return 'pending';
}

function isSubagentToolRow(row: RunScopedCompactRow): boolean {
  const itemType = readString(row.data?.['itemType']);
  const label = row.label ?? '';
  return (
    itemType === 'spawnAgentToolCall' ||
    itemType === 'collabAgentToolCall' ||
    label === 'spawn_agent' ||
    label === 'collab_agent'
  );
}

function rowVisitId(
  row: RunScopedCompactRow,
  options: { fallbackVisitId: string | null; live: boolean },
): string | null {
  if (row.stateVisitId !== undefined) return row.stateVisitId;
  return options.fallbackVisitId;
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
  const common = {
    seq: row.seq,
    eventId: row.eventId,
    stateVisitId,
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
  };
  switch (row.kind) {
    case 'message': {
      const text = rowBodyText(row);
      if (!text) return null;
      const id = row.itemId ?? row.id;
      if (compactMessageType(row.label) === 'user_message') {
        return {
          ...common,
          id,
          type: 'user_message',
          text,
          synthetic: looksLikeFrameworkOrientation(text),
        };
      }
      return { ...common, id, type: 'agent_message', text, streaming: false };
    }
    case 'reasoning': {
      const text = rowBodyText(row);
      return text
        ? { ...common, id: row.itemId ?? row.id, type: 'reasoning', text, streaming: false }
        : null;
    }
    case 'tool': {
      const name = row.label ?? row.summary ?? 'tool';
      const reserved = row.data?.['internal'] === true || isReservedToolName(name);
      const displayKind = readDisplayKind(row.data?.['displayKind']);
      const command = readString(row.data?.['command']);
      const argumentsPreview = readString(row.data?.['argumentsPreview']);
      const target = readString(row.data?.['target']);
      const subagentAction = readSubagentAction(row.data?.['subagentAction']);
      const agentNickname = readString(row.data?.['agentNickname']);
      const agentRole = readString(row.data?.['agentRole']);
      const receiverThreadIds = readStringArray(row.data?.['receiverThreadIds']);
      const promptPreview = readString(row.data?.['promptPreview']);
      const responsePreview = readString(row.data?.['responsePreview']);
      const errorPreview = readString(row.data?.['errorPreview']);
      return {
        ...common,
        id: row.itemId ?? row.id,
        type: 'tool_call',
        name,
        preview: rowPreview(row),
        status: compactStatus(row.status),
        reserved,
        ...(row.elapsedMs === undefined ? {} : { elapsedMs: row.elapsedMs }),
        category: isSubagentToolRow(row) ? 'subagent' : 'tool',
        ...(displayKind === undefined ? {} : { displayKind }),
        ...(command === undefined ? {} : { command }),
        ...(argumentsPreview === undefined ? {} : { argumentsPreview }),
        ...(target === undefined ? {} : { target }),
        ...(subagentAction === undefined ? {} : { subagentAction }),
        ...(agentNickname === undefined ? {} : { agentNickname }),
        ...(agentRole === undefined ? {} : { agentRole }),
        ...(receiverThreadIds === undefined ? {} : { receiverThreadIds }),
        ...(promptPreview === undefined ? {} : { promptPreview }),
        ...(responsePreview === undefined ? {} : { responsePreview }),
        ...(errorPreview === undefined ? {} : { errorPreview }),
        ...(row.output === undefined ? {} : { output: row.output }),
        ...(row.ok === undefined ? {} : { ok: row.ok }),
        ...(row.resultId === undefined ? {} : { resultId: row.resultId }),
      };
    }
    case 'request': {
      const label = row.label ?? readString(row.data?.['kind']) ?? 'request';
      const summary = row.summary ?? row.text;
      return {
        ...common,
        id: row.id,
        type: 'compact_status',
        category: 'request',
        label,
        ...(row.status === undefined ? {} : { status: row.status }),
        ...(summary === undefined ? {} : { summary }),
        reserved: row.data?.['internal'] === true,
        ...(row.elapsedMs === undefined ? {} : { elapsedMs: row.elapsedMs }),
      };
    }
    case 'reply': {
      const label = row.label ?? 'reply';
      const summary = row.summary ?? row.text;
      return {
        ...common,
        id: row.id,
        type: 'compact_status',
        category: 'reply',
        label,
        ...(row.status === undefined ? {} : { status: row.status }),
        ...(summary === undefined ? {} : { summary }),
        reserved: row.data?.['internal'] === true,
        ...(row.elapsedMs === undefined ? {} : { elapsedMs: row.elapsedMs }),
      };
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
      return text
        ? {
            ...common,
            id: row.id,
            type: 'compact_status',
            category: 'diagnostic',
            label: row.label ?? 'diagnostic',
            status: row.status ?? 'warn',
            summary: text,
          }
        : null;
    }
    case 'run_lifecycle': {
      const label = row.label ?? 'run';
      const summary = row.summary ?? row.text;
      return {
        ...common,
        id: row.id,
        type: 'compact_status',
        category: 'lifecycle',
        label,
        ...(row.status === undefined ? {} : { status: row.status }),
        ...(summary === undefined ? {} : { summary }),
        ...(row.elapsedMs === undefined ? {} : { elapsedMs: row.elapsedMs }),
      };
    }
    case 'state_change': {
      const visitCount = readNumber(row.data?.['visitCount']);
      const stateKind = readString(row.data?.['stateKind']);
      const open = readBoolean(row.data?.['open']);
      const awaiting = readBoolean(row.data?.['awaiting']);
      const model = readString(row.data?.['model']);
      const effort = readString(row.data?.['effort']);
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
        ...(visitCount === undefined ? {} : { visitCount }),
        ...(stateKind === undefined ? {} : { stateKind }),
        ...(open === undefined ? {} : { open }),
        ...(awaiting === undefined ? {} : { awaiting }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      };
    }
    case 'transition_failure': {
      const summary = row.summary ?? row.text;
      if (summary === undefined) return null;
      const toolName = readString(row.data?.['toolName']);
      const state = readString(row.data?.['state']);
      const exit = readString(row.data?.['exit']);
      return {
        ...common,
        id: row.id,
        type: 'transition_failure',
        summary,
        status: 'failed',
        ...(toolName === undefined ? {} : { toolName }),
        ...(state === undefined ? {} : { state }),
        ...(exit === undefined ? {} : { exit }),
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
    case 'dynamicToolCall':
      return null;
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
      if (
        !KNOWN_COMPACT_ROW_KINDS.has(row.kind) &&
        diagnostics.length < UNKNOWN_ROW_DIAGNOSTIC_LIMIT
      ) {
        diagnostics.push(compactRowDiagnostic(row));
      }
      continue;
    }
    items.push(item);
  }
  return { items: mergeTranscriptItems([], items), diagnostics };
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
    const existingItem = byKey.get(item.id);
    const nextItem: TranscriptItem =
      existingItem === undefined
        ? item
        : ({
            ...existingItem,
            ...item,
            eventIds: mergeEventIds(transcriptEventIds(existingItem), transcriptEventIds(item)),
          } as TranscriptItem);
    byKey.set(item.id, nextItem);
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
      [visitId]: { loading: false, loaded: true, error: null, storedRows: page.rows.length },
    },
    rowLoadError: null,
  };
}

function mergeRecentRowPage(state: UiState, page: RunScopedRowPage): UiState {
  const converted = transcriptFromCompactRows(page.rows, {
    fallbackVisitId: RUN_LEVEL_VISIT_ID,
    live: false,
  });
  return {
    ...state,
    transcript: mergeTranscriptItems(state.transcript, converted.items),
    diagnostics: [...state.diagnostics, ...converted.diagnostics].slice(-DIAGNOSTIC_LIMIT),
    recentRowsCursor: page.nextCursor,
    recentRowsLoadStatus: {
      loading: false,
      loaded: true,
      error: null,
      storedRows: page.rows.length,
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
  const elapsedMs = readNumber(row['elapsedMs']);
  const output = readString(row['output']);
  const ok = readBoolean(row['ok']);
  const resultId = readString(row['resultId']);
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
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(output === undefined ? {} : { output }),
    ...(ok === undefined ? {} : { ok }),
    ...(resultId === undefined ? {} : { resultId }),
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
  if (kind === 'owner-choice') {
    const state = readString(value['state']);
    const visitCount = readNumber(value['visitCount']);
    const question = readString(value['question']);
    const options = Array.isArray(value['options']) ? value['options'] : null;
    if (
      state === undefined ||
      visitCount === undefined ||
      question === undefined ||
      options === null
    ) {
      return null;
    }
    const parsedOptions = options
      .map((option) => (isRecord(option) ? readString(option['label']) : undefined))
      .filter((label): label is string => label !== undefined)
      .map((label) => ({ label }));
    if (parsedOptions.length !== options.length) return null;
    return { kind, id, requestId, state, visitCount, question, options: parsedOptions };
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
      ownerChoice: pending.ownerChoice ?? state.pending.ownerChoice,
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
    fallbackVisitId: state.activeVisitId ?? RUN_LEVEL_VISIT_ID,
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
    data?.['kind'] === 'choice' ||
    data?.['kind'] === 'final'
      ? { kind: data['kind'] }
      : {}),
    ...(readNumber(data?.['visitCount']) === undefined
      ? {}
      : { visitCount: readNumber(data?.['visitCount']) }),
    exits,
  });
}

function contextFromRunEvent(e: RunScopedApiEvent): Record<string, unknown> | undefined {
  const context = e.data?.['context'];
  return isRecord(context) ? context : undefined;
}

function withLatestContext(
  state: FsmState,
  latestContext: Record<string, unknown> | undefined,
): FsmState {
  return latestContext === undefined ? state : { ...state, context: latestContext };
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
  } else if (e.type === 'token.updated') {
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
          state:
            currentState === null
              ? state.state
              : withLatestContext(currentState, state.latestContext),
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
    case 'context.initialized':
    case 'context.changed': {
      const latestContext = contextFromRunEvent(e);
      if (latestContext === undefined) return appendRunEventRow(state, e);
      return appendRunEventRow(
        {
          ...state,
          latestContext,
          state: state.state === null ? null : { ...state.state, context: latestContext },
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
            ownerChoice:
              state.pending.ownerChoice?.requestId === requestId ? null : state.pending.ownerChoice,
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
        recentRowsCursor: null,
        recentRowsLoadStatus: { loading: false, loaded: false, error: null, storedRows: 0 },
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
  if (a.type === 'resolveOwnerChoice') {
    const current = s.pending.ownerChoice;
    if (current === null || current.state !== a.state || current.visitCount !== a.visitCount) {
      return { ...s, replyError: null };
    }
    return {
      ...s,
      replyError: null,
      pending: { ...s.pending, ownerChoice: null },
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
          ...(s.rowLoadStatus[a.visitId]?.storedRows === undefined
            ? {}
            : { storedRows: s.rowLoadStatus[a.visitId]?.storedRows }),
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
          ...(s.rowLoadStatus[a.visitId]?.storedRows === undefined
            ? {}
            : { storedRows: s.rowLoadStatus[a.visitId]?.storedRows }),
        },
      },
    };
  }
  if (a.type === 'recentRowsLoadStarted') {
    return {
      ...s,
      rowLoadError: null,
      recentRowsLoadStatus: {
        loading: true,
        loaded: s.recentRowsLoadStatus.loaded,
        error: null,
        ...(s.recentRowsLoadStatus.storedRows === undefined
          ? {}
          : { storedRows: s.recentRowsLoadStatus.storedRows }),
      },
    };
  }
  if (a.type === 'recentRowsPageLoaded') {
    return mergeRecentRowPage(s, a.page);
  }
  if (a.type === 'recentRowsLoadFailed') {
    return {
      ...s,
      rowLoadError: a.error,
      recentRowsLoadStatus: {
        loading: false,
        loaded: s.recentRowsLoadStatus.loaded,
        error: a.error,
        ...(s.recentRowsLoadStatus.storedRows === undefined
          ? {}
          : { storedRows: s.recentRowsLoadStatus.storedRows }),
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
  return s;
}

export type UiActions = {
  reply: (p: ReplyPayload) => Promise<void>;
  requestRowsForStatePath?: (path: string) => Promise<void>;
  requestRecentRows?: () => Promise<void>;
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
        if (p.kind === 'owner-choice') {
          dispatch({ type: 'resolveOwnerChoice', state: p.state, visitCount: p.visitCount });
        }
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

  const requestRecentRows = useCallback(async () => {
    if (!uiToken) throw new Error('UI token is unavailable');
    const runId = s.run?.runId;
    if (!runId) throw new Error('runId is unavailable');
    if (s.recentRowsLoadStatus.loading) return;
    if (s.recentRowsLoadStatus.loaded && s.recentRowsCursor === null) return;

    dispatch({ type: 'recentRowsLoadStarted' });
    try {
      const page = await fetchRecentRows({
        runId,
        uiToken,
        cursor: s.recentRowsCursor,
      });
      dispatch({ type: 'recentRowsPageLoaded', page });
    } catch (error) {
      dispatch({
        type: 'recentRowsLoadFailed',
        error: error instanceof Error ? error.message : 'Recent row load failed',
      });
    }
  }, [
    s.recentRowsCursor,
    s.recentRowsLoadStatus.loaded,
    s.recentRowsLoadStatus.loading,
    s.run?.runId,
    uiToken,
  ]);

  return {
    ...s,
    reply,
    requestRowsForStatePath,
    requestRecentRows,
    toggleDevMode: () => dispatch({ type: 'toggleDevMode' }),
    setScope: (path: string | null) => dispatch({ type: 'setScope', path }),
  };
}

/**
 * Returns normalized transcript rows visible under default/dev policy. This is
 * still canonical item output: display-only grouping, truncation, and preview
 * caps plus successful-output suppression happen in displayItems().
 */
export function visibleItems(items: TranscriptItem[], devMode: boolean): TranscriptItem[] {
  return foldToolResults(items).filter((i) => {
    if (isAlwaysHiddenTranscriptItem(i)) return false;
    if (devMode) return true;
    return isVisibleTranscriptItem(i);
  });
}

export function displayItems(items: TranscriptItem[], devMode: boolean): TranscriptDisplayItem[] {
  const displayed = visibleItems(items, devMode).map((item) =>
    devMode
      ? capDisplayPreviews(item)
      : removeDefaultSuccessfulOutput(truncateDisplayOutput(capDisplayPreviews(item))),
  );
  return groupExplorationItems(displayed);
}

function foldToolResults(items: ReadonlyArray<TranscriptItem>): TranscriptItem[] {
  const folded: TranscriptItem[] = [];
  for (const item of items) {
    if (item.type !== 'tool_result') {
      folded.push(item);
      continue;
    }

    const idSuffix = ':output';
    const outputCallId = item.id.endsWith(idSuffix) ? item.id.slice(0, -idSuffix.length) : null;
    let callIdx =
      outputCallId === null
        ? -1
        : folded.findIndex(
            (candidate) =>
              candidate.type === 'tool_call' &&
              candidate.id === outputCallId &&
              candidate.resultId === undefined,
          );

    if (callIdx < 0) {
      for (let i = folded.length - 1; i >= 0; i--) {
        const candidate = folded[i];
        if (
          candidate?.type === 'tool_call' &&
          candidate.name === item.name &&
          candidate.status === 'pending'
        ) {
          callIdx = i;
          break;
        }
      }
    }

    if (callIdx < 0) {
      folded.push(item);
      continue;
    }

    const prev = folded[callIdx] as Extract<TranscriptItem, { type: 'tool_call' }>;
    folded[callIdx] = {
      ...prev,
      status: item.ok ? 'completed' : 'failed',
      output: item.output,
      ok: item.ok,
      resultId: item.id,
      eventIds: mergeEventIds(transcriptEventIds(prev), transcriptEventIds(item)),
    };
  }
  return folded;
}

function isVisibleTranscriptItem(i: TranscriptItem): boolean {
  if (isAlwaysHiddenTranscriptItem(i)) return false;
  if (i.type === 'tool_call' && i.reserved) return false;
  if (i.type === 'tool_result' && i.reserved) return false;
  if (i.type === 'compact_status' && i.reserved) return false;
  if (
    i.type === 'compact_status' &&
    i.category === 'reply' &&
    i.status === 'failed' &&
    i.label === 'owner choice'
  ) {
    return true;
  }
  if (
    i.type === 'compact_status' &&
    (i.category === 'request' || i.category === 'reply' || i.category === 'lifecycle')
  ) {
    return false;
  }
  if (i.type === 'state_change') return false;
  if (i.type === 'user_message' && i.synthetic) return false;
  if (i.type === 'framework_note' && (i.variant === 'orientation' || i.variant === 'info')) {
    return false;
  }
  if (
    i.type === 'tool_call' &&
    i.category === 'subagent' &&
    i.status === 'pending' &&
    (i.subagentAction === 'spawn' || i.subagentAction === 'send' || i.subagentAction === 'close')
  ) {
    return false;
  }
  return true;
}

function isAlwaysHiddenTranscriptItem(i: TranscriptItem): boolean {
  if (i.type === 'user_message' && i.synthetic) return true;
  if (i.type === 'tool_call' && isSubmitToolName(i.name)) return true;
  if (i.type === 'tool_result' && isSubmitToolName(i.name)) return true;
  if (i.type === 'reasoning' && i.text.trim().length === 0) return true;
  return false;
}

function truncateDisplayOutput(item: TranscriptItem): TranscriptItem {
  if (item.type === 'tool_call' && item.output !== undefined) {
    const output = truncateOutputLines(item.output);
    return output === item.output ? item : { ...item, output };
  }
  if (item.type === 'tool_result') {
    const output = truncateOutputLines(item.output);
    return output === item.output ? item : { ...item, output };
  }
  return item;
}

function removeDefaultSuccessfulOutput(item: TranscriptItem): TranscriptItem {
  if (
    item.type !== 'tool_call' ||
    item.output === undefined ||
    item.status !== 'completed' ||
    item.ok === false
  ) {
    return item;
  }
  const { output: _output, ...withoutOutput } = item;
  return withoutOutput;
}

function capDisplayPreviews(item: TranscriptItem): TranscriptItem {
  if (item.type !== 'tool_call' || item.category !== 'subagent') return item;
  return {
    ...item,
    ...(item.promptPreview === undefined
      ? {}
      : { promptPreview: capGraphemes(item.promptPreview, 160) }),
    ...(item.responsePreview === undefined
      ? {}
      : { responsePreview: capGraphemes(item.responsePreview, 240) }),
    ...(item.errorPreview === undefined
      ? {}
      : { errorPreview: capGraphemes(item.errorPreview, 160) }),
  };
}

function truncateOutputLines(output: string): string {
  const lines = output.split('\n');
  if (lines.length <= 10) return output;
  const omitted = lines.length - 10;
  return [
    ...lines.slice(0, 5),
    `... +${omitted} lines (dev mode for full output)`,
    ...lines.slice(-5),
  ].join('\n');
}

function capGraphemes(value: string, max: number): string {
  type GraphemeSegmenter = {
    segment(input: string): Iterable<{ segment: string }>;
  };
  type GraphemeSegmenterConstructor = new (
    locales?: string | string[],
    options?: { granularity: 'grapheme' },
  ) => GraphemeSegmenter;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
  const chars =
    Segmenter === undefined
      ? Array.from(value)
      : Array.from(
          new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
          (part) => part.segment,
        );
  if (chars.length <= max) return value;
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

function groupExplorationItems(items: ReadonlyArray<TranscriptItem>): TranscriptDisplayItem[] {
  const grouped: TranscriptDisplayItem[] = [];
  let pending: GroupableExplorationTool[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      grouped.push(pending[0]);
      pending = [];
      return;
    }
    grouped.push(explorationGroupFromChildren(pending));
    pending = [];
  };

  for (const item of items) {
    if (isGroupableExplorationTool(item)) {
      const currentTurnId = pending[0]?.turnId;
      if (pending.length === 0 || item.turnId === currentTurnId) {
        pending.push(item);
        continue;
      }
    }
    flush();
    if (isGroupableExplorationTool(item)) pending.push(item);
    else grouped.push(item);
  }
  flush();
  return grouped;
}

function isGroupableExplorationTool(item: TranscriptItem): item is GroupableExplorationTool {
  return (
    item.type === 'tool_call' &&
    item.turnId !== undefined &&
    item.turnId.length > 0 &&
    (item.displayKind === 'read' || item.displayKind === 'list' || item.displayKind === 'search') &&
    item.status !== 'failed' &&
    !item.reserved
  );
}

function explorationGroupFromChildren(
  children: ReadonlyArray<GroupableExplorationTool>,
): ExplorationGroupItem {
  const eventIds = mergeEventIds(
    [],
    children.flatMap((child) => transcriptEventIds(child)),
  );
  const pending = children.some((child) => child.status === 'pending');
  const first = children[0];
  const last = children[children.length - 1];
  return {
    type: 'exploration_group',
    id: `exploration:${first.id}:${last.id}`,
    stateVisitId: first.stateVisitId,
    turnId: first.turnId,
    seq: first.seq,
    eventIds,
    status: pending ? 'pending' : 'completed',
    title: pending ? 'Exploring' : 'Explored',
    children: children.map((child) => ({
      id: child.id,
      displayKind: child.displayKind,
      name: child.name,
      preview: child.target ?? child.argumentsPreview ?? child.preview,
      status: child.status,
      eventIds: transcriptEventIds(child),
    })),
  };
}

/**
 * True when the transcript contains no user-facing content yet — used by
 * activity heuristics to detect "codex hasn't streamed anything visible".
 * Counts orientation notes, state markers, request/reply/lifecycle rows, and
 * reserved/internal tool plumbing as invisible for the default transcript.
 */
export function hasVisibleContent(items: TranscriptItem[]): boolean {
  for (const i of items) {
    if (isVisibleTranscriptItem(i)) return true;
  }
  return false;
}
