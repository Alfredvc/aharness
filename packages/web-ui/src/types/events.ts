// Local mirrors of the browser-facing aharness contracts. Run-scoped JSONL
// bootstrap, row, event, and resync shapes are the production data contract;
// legacy flat AppEvent/UiSnapshot shapes remain below only for fixture/demo
// and compatibility-test helpers outside the production import path.
import type { Topology } from './topology.js';

export type RunMeta = {
  runId: string;
  threadId: string;
  repoRoot: string;
  fsmFile: string;
  fsmHash6: string;
  codexPin: string;
  startedAt: string;
};

export type UiMode = 'run' | 'inspect';

export type Posture = {
  isTerminal: boolean;
  isAwaiting: boolean;
  submittedThisTurn: boolean;
  open: boolean;
};

export type FsmState = {
  path: string; // qualified, dot-separated
  leaf: string; // last segment
  kind: 'stateful' | 'terminal' | 'passive' | 'final';
  awaitsOwnerText?: { messageToUser: string };
  exits: Array<{ name: string; kind: 'submit' | 'await'; branchCount?: number }>;
  visitCount: number;
  // Resolved per-state prompt (entryPrompt). Stateful states only.
  entryPrompt?: string;
  // XState context, with aharness-internal keys removed. Surfaced for the
  // dev-mode context inspector.
  context?: Record<string, unknown>;
};

export type RunScopedRunMeta = Partial<RunMeta> & {
  runId: string;
  [key: string]: unknown;
};

export type RunScopedPosture = Posture;

type RunScopedCurrentStateExitKind = 'submit' | 'await' | 'always' | (string & {});

export type RunScopedCurrentStateExit = {
  name: string;
  kind: RunScopedCurrentStateExitKind;
  branchCount?: number;
};

export type RunScopedCurrentState = {
  path: string;
  leaf?: string;
  kind?: FsmState['kind'];
  visitCount?: number;
  exits?: ReadonlyArray<RunScopedCurrentStateExit>;
};

export type RunScopedStateVisit = {
  id: string;
  path: string;
  seq: number;
  time: string;
  from?: string | null;
  to: string;
  cause?: string;
};

export type RunScopedOwnerInputPendingCardQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  choices?: ReadonlyArray<string>;
};

export type RunScopedOwnerInputPendingCard = {
  kind: 'owner-input';
  id: string;
  requestId: string;
  method: 'item/tool/requestUserInput';
  questions: ReadonlyArray<RunScopedOwnerInputPendingCardQuestion>;
};

export type RunScopedFileApprovalPendingCard = {
  kind: 'file-approval';
  id: string;
  requestId: string;
  method: 'item/fileChange/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string;
  grantRoot?: string;
  changes: ReadonlyArray<FileUpdateChange>;
};

export type RunScopedCommandApprovalPendingCard = {
  kind: 'command-approval';
  id: string;
  requestId: string;
  method: 'item/commandExecution/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  commandActions?: ReadonlyArray<unknown>;
  networkApprovalContext?: unknown;
};

export type RunScopedPermissionApprovalPendingCard = {
  kind: 'permission-approval';
  id: string;
  requestId: string;
  method: 'item/permissions/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  permissions: unknown;
  reason?: string;
};

export type RunScopedElicitationPendingCard = {
  kind: 'elicitation';
  id: string;
  requestId: string;
  method: 'mcpServer/elicitation/request';
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
};

export type RunScopedPendingCard =
  | RunScopedOwnerInputPendingCard
  | RunScopedFileApprovalPendingCard
  | RunScopedCommandApprovalPendingCard
  | RunScopedPermissionApprovalPendingCard
  | RunScopedElicitationPendingCard;

export type RunScopedPendingRequestSummary = {
  requestId: string;
  status: 'pending' | 'submitted';
  kind?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  stateVisitId?: string;
  turnId?: string;
  itemId?: string;
  lastEventId: string;
  pendingCard?: RunScopedPendingCard;
};

export type RunScopedAggregateStats = {
  status?: string;
  startedAt?: string;
  endedAt?: string;
  turnCount: number;
  activeTurnId?: string;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  modelContextWindow?: number;
};

export type RunScopedCompactRow = {
  id: string;
  eventId: string;
  seq: number;
  time: string;
  type: string;
  stateVisitId?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  kind: string;
  label?: string;
  text?: string;
  status?: string;
  summary?: string;
  elapsedMs?: number;
  // UI-visible tool result fields for compact tool rows; raw envelopes stay out
  // of bootstrap/row-page projections.
  output?: string;
  ok?: boolean;
  resultId?: string;
  data?: Record<string, unknown>;
};

export type RunScopedReplayDiagnostic = {
  severity: 'warning' | 'corruption';
  code: string;
  message: string;
  line?: number;
  offset?: number;
  seq?: number;
  id?: string;
};

export type RunScopedBootstrap = {
  run: RunScopedRunMeta;
  topology: Topology | null;
  latestEventId: string | null;
  currentState: RunScopedCurrentState | null;
  posture: RunScopedPosture;
  currentStateVisit: RunScopedStateVisit | null;
  stateVisits: ReadonlyArray<RunScopedStateVisit>;
  statePathVisits: Readonly<Record<string, ReadonlyArray<string>>>;
  pending: ReadonlyArray<RunScopedPendingRequestSummary>;
  aggregateStats: RunScopedAggregateStats;
  recentRows: ReadonlyArray<RunScopedCompactRow>;
  diagnostics: ReadonlyArray<RunScopedReplayDiagnostic>;
  mode?: UiMode;
};

export type RunScopedApiEvent = {
  schema: string;
  runId: string;
  seq: number;
  id: string;
  time: string;
  type: string;
  threadId?: string;
  turnId?: string;
  stateVisitId?: string;
  itemId?: string;
  requestId?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  offset: number;
  lineBytes: number;
};

export type RunScopedResyncReason =
  | 'invalid-event-cursor'
  | 'wrong-run-event-cursor'
  | 'future-event-cursor'
  | 'run-event-log-unavailable';

export type RunScopedResyncRequired = {
  kind: 'RunScopedResyncRequired';
  control: true;
  requestedEventId: string | null;
  latestEventId: string | null;
  reason: RunScopedResyncReason;
};

export type RunScopedRowPage = {
  rows: ReadonlyArray<RunScopedCompactRow>;
  nextCursor: string | null;
};

export type RunScopedEventPage = {
  events: ReadonlyArray<RunScopedApiEvent>;
  nextCursor: string | null;
  diagnostics: ReadonlyArray<RunScopedReplayDiagnostic>;
};

export type AgentMessageDelta = {
  kind: 'AgentMessageDelta';
  id: string;
  delta: string;
  reasoning?: boolean;
};

export type TurnStarted = {
  kind: 'TurnStarted';
  turnId: string;
};

export type ItemStarted =
  | {
      kind: 'ItemStarted';
      id: string;
      type: 'function_call';
      name: string;
      arguments: string; // streaming JSON; may be partial
    }
  | {
      kind: 'ItemStarted';
      id: string;
      type: 'function_call_output';
      name: string;
      output: string;
      ok: boolean;
    }
  | {
      kind: 'ItemStarted';
      id: string;
      type: 'agent_message';
      text: string;
    }
  | {
      kind: 'ItemStarted';
      id: string;
      type: 'user_message';
      text: string;
    }
  | {
      kind: 'ItemStarted';
      id: string;
      type: 'reasoning';
      text: string;
    };

export type PatchChangeKind =
  | { type: 'add' }
  | { type: 'delete' }
  | { type: 'update'; move_path: string | null };

export type FileUpdateChange = {
  path: string;
  kind: PatchChangeKind;
  diff: string;
};

export type FileChangeApproval = {
  kind: 'ServerRequest';
  id: string;
  requestId: string;
  method: 'item/fileChange/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string;
  grantRoot?: string;
  changes: ReadonlyArray<FileUpdateChange>;
};

export type CommandApproval = {
  kind: 'ServerRequest';
  id: string;
  requestId: string;
  method: 'item/commandExecution/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string;
  command?: string;
  cwd?: string;
  reason?: string;
};

export type OwnerInputRequest = {
  kind: 'ServerRequest';
  id: string;
  method: 'item/tool/requestUserInput';
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    // Not part of codex `request_user_input` schema (see headless spec CF-3).
    // Carried only for UI fixture demos that exercise a choice-list affordance;
    // production SSE will never emit this field.
    choices?: string[];
  }>;
};

export type PermissionApproval = {
  kind: 'ServerRequest';
  id: string;
  requestId: string;
  method: 'item/permissions/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  permissions: unknown;
  reason?: string;
};

export type ElicitationRequest = {
  kind: 'ServerRequest';
  id: string;
  requestId: string;
  method: 'mcpServer/elicitation/request';
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
};

export type TurnCompleted = {
  kind: 'TurnCompleted';
  turnId: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'abort';
};

export type PostureChange = {
  kind: 'PostureChange';
  posture: Partial<Posture>;
};

export type ResyncRequired = {
  kind: 'ResyncRequired';
  reason: 'unknown-last-event-id' | 'event-buffer-overflow';
  requestedLastEventId: string | null;
};

export type OwnerInputResolved = {
  kind: 'OwnerInputResolved';
  id: string;
};

export type FileApprovalUpdated = {
  kind: 'FileApprovalUpdated';
  id: string;
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  changes: ReadonlyArray<FileUpdateChange>;
};

export type ApprovalRequestResolved = {
  kind: 'ApprovalRequestResolved';
  id: string;
  requestId: string;
};

export type StateChange = {
  kind: 'StateChange';
  from: string | null;
  to: string;
  cause: 'submit' | 'await' | 'always' | 'embed-final' | 'boot';
  newState: FsmState;
};

export type FreshClearBoundary = {
  kind: 'FreshClearBoundary';
  id: string;
  reason: 'clearOnEntry';
  previousThreadId: string;
  nextThreadId: string;
  statePath: string;
};

export type AbandonedThreadDiagnostic = {
  kind: 'AbandonedThreadDiagnostic';
  id: string;
  threadId: string;
  source: string;
  message: string;
};

export type FrameworkNote = {
  kind: 'FrameworkNote';
  id: string;
  text: string;
  variant: 'info' | 'warn' | 'orientation';
};

// Legacy web-ui compatibility event union for fixture/demo and compatibility
// helpers. The production browser contract is run-scoped JSONL.
export type AppEvent =
  | AgentMessageDelta
  | TurnStarted
  | ItemStarted
  | FileChangeApproval
  | CommandApproval
  | OwnerInputRequest
  | PermissionApproval
  | ElicitationRequest
  | TurnCompleted
  | StateChange
  | FreshClearBoundary
  | AbandonedThreadDiagnostic
  | FrameworkNote
  | PostureChange
  | OwnerInputResolved
  | FileApprovalUpdated
  | ApprovalRequestResolved
  | ResyncRequired;

export type UiTranscriptEntry = {
  id: string;
  text: string;
  reasoning: boolean;
};

export type UiAppState = {
  mode?: UiMode;
  run: RunMeta | null;
  posture: Posture;
  activeTurn?: { turnId: string } | null;
  currentState: FsmState | null;
  topology?: Topology;
  transcript: UiTranscriptEntry[];
  frameworkNotes: FrameworkNote[];
  diagnostics: AbandonedThreadDiagnostic[];
  completedTurns: TurnCompleted[];
  pending?: {
    ownerInput: OwnerInputRequest | null;
    fileApprovals?: FileChangeApproval[];
    cmdApprovals?: CommandApproval[];
    permissionApprovals?: PermissionApproval[];
    elicitations?: ElicitationRequest[];
  };
};

// Legacy web-ui compatibility snapshot for fixture/demo and compatibility
// helpers. Run-scoped bootstrap is the production boot contract.
export type UiSnapshot = {
  latestEventId: string | null;
  state: UiAppState;
};

export function isRunScopedBootstrap(value: unknown): value is RunScopedBootstrap {
  if (!isRecord(value)) return false;
  if (!isRunScopedRunMeta(value['run'])) return false;
  if (!(value['topology'] === null || isTopology(value['topology']))) return false;
  if (!isStringOrNull(value['latestEventId'])) return false;
  if (!(value['currentState'] === null || isRunScopedCurrentState(value['currentState']))) {
    return false;
  }
  if (!isRunScopedPosture(value['posture'])) return false;
  if (!(value['currentStateVisit'] === null || isRunScopedStateVisit(value['currentStateVisit']))) {
    return false;
  }
  if (!isArrayOf(value['stateVisits'], isRunScopedStateVisit)) return false;
  if (!isStatePathVisits(value['statePathVisits'])) return false;
  if (!isArrayOf(value['pending'], isRunScopedPendingRequestSummary)) return false;
  if (!isRunScopedAggregateStats(value['aggregateStats'])) return false;
  if (!isArrayOf(value['recentRows'], isRunScopedCompactRow)) return false;
  if (!isArrayOf(value['diagnostics'], isRunScopedReplayDiagnostic)) return false;
  if (value['mode'] !== undefined && value['mode'] !== 'run' && value['mode'] !== 'inspect') {
    return false;
  }
  return true;
}

export function isRunScopedRowPage(value: unknown): value is RunScopedRowPage {
  return (
    isRecord(value) &&
    isArrayOf(value['rows'], isRunScopedCompactRow) &&
    isStringOrNull(value['nextCursor'])
  );
}

export function isRunScopedEventPage(value: unknown): value is RunScopedEventPage {
  return (
    isRecord(value) &&
    isArrayOf(value['events'], isRunScopedApiEvent) &&
    isStringOrNull(value['nextCursor']) &&
    isArrayOf(value['diagnostics'], isRunScopedReplayDiagnostic)
  );
}

export function isRunScopedApiEvent(value: unknown): value is RunScopedApiEvent {
  if (!isRecord(value) || 'raw' in value) return false;
  return (
    isNonEmptyString(value['schema']) &&
    isNonEmptyString(value['runId']) &&
    isSafeNumber(value['seq']) &&
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['time']) &&
    isNonEmptyString(value['type']) &&
    isOptionalString(value['threadId']) &&
    isOptionalString(value['turnId']) &&
    isOptionalString(value['stateVisitId']) &&
    isOptionalString(value['itemId']) &&
    isOptionalString(value['requestId']) &&
    (value['data'] === undefined || isRecord(value['data'])) &&
    (value['meta'] === undefined || isRecord(value['meta'])) &&
    isSafeNumber(value['offset']) &&
    isSafeNumber(value['lineBytes'])
  );
}

export function isRunScopedResyncRequired(value: unknown): value is RunScopedResyncRequired {
  return (
    isRecord(value) &&
    value['kind'] === 'RunScopedResyncRequired' &&
    value['control'] === true &&
    isStringOrNull(value['requestedEventId']) &&
    isStringOrNull(value['latestEventId']) &&
    isRunScopedResyncReason(value['reason'])
  );
}

export function runScopedCurrentStateToFsmState(state: RunScopedCurrentState): FsmState {
  const leaf = state.leaf ?? state.path.split('.').at(-1) ?? state.path;
  return {
    path: state.path,
    leaf,
    kind: state.kind ?? 'stateful',
    exits:
      state.exits?.map((exit) => ({
        name: exit.name,
        kind: exit.kind === 'await' ? 'await' : 'submit',
        ...(exit.branchCount === undefined ? {} : { branchCount: exit.branchCount }),
      })) ?? [],
    visitCount: state.visitCount ?? 1,
  };
}

export function runScopedBootstrapToUiSnapshot(bootstrap: RunScopedBootstrap): UiSnapshot {
  const pending = pendingCardsToUiPending(bootstrap.pending);
  return {
    latestEventId: bootstrap.latestEventId,
    state: {
      mode: bootstrap.mode,
      run: runScopedRunMetaToRunMeta(bootstrap.run),
      posture: bootstrap.posture,
      activeTurn:
        bootstrap.aggregateStats.activeTurnId === undefined
          ? null
          : { turnId: bootstrap.aggregateStats.activeTurnId },
      currentState:
        bootstrap.currentState === null
          ? null
          : runScopedCurrentStateToFsmState(bootstrap.currentState),
      topology: bootstrap.topology ?? undefined,
      transcript: [],
      frameworkNotes: [],
      diagnostics: bootstrap.diagnostics.map((diagnostic) => ({
        kind: 'AbandonedThreadDiagnostic',
        id: diagnostic.id ?? diagnostic.code,
        threadId: '',
        source: diagnostic.code,
        message: diagnostic.message,
      })),
      completedTurns: [],
      pending,
    },
  };
}

function pendingCardsToUiPending(
  pending: ReadonlyArray<RunScopedPendingRequestSummary>,
): UiAppState['pending'] {
  const uiPending: NonNullable<UiAppState['pending']> = {
    ownerInput: null,
    fileApprovals: [],
    cmdApprovals: [],
    permissionApprovals: [],
    elicitations: [],
  };

  for (const summary of pending) {
    const card = summary.pendingCard;
    if (card === undefined) continue;
    switch (card.kind) {
      case 'owner-input':
        uiPending.ownerInput = {
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
        uiPending.fileApprovals?.push({
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
        uiPending.cmdApprovals?.push({
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
        uiPending.permissionApprovals?.push({
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
        uiPending.elicitations?.push({
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

  return uiPending;
}

function runScopedRunMetaToRunMeta(run: RunScopedRunMeta): RunMeta {
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

function isRunScopedRunMeta(value: unknown): value is RunScopedRunMeta {
  return isRecord(value) && isNonEmptyString(value['runId']);
}

function isRunScopedPosture(value: unknown): value is RunScopedPosture {
  return (
    isRecord(value) &&
    typeof value['isTerminal'] === 'boolean' &&
    typeof value['isAwaiting'] === 'boolean' &&
    typeof value['submittedThisTurn'] === 'boolean' &&
    typeof value['open'] === 'boolean'
  );
}

function isRunScopedCurrentState(value: unknown): value is RunScopedCurrentState {
  return (
    isRecord(value) &&
    isNonEmptyString(value['path']) &&
    isOptionalString(value['leaf']) &&
    (value['kind'] === undefined || isFsmStateKind(value['kind'])) &&
    (value['visitCount'] === undefined || isSafeNumber(value['visitCount'])) &&
    (value['exits'] === undefined || isArrayOf(value['exits'], isRunScopedCurrentStateExit))
  );
}

function isRunScopedCurrentStateExit(value: unknown): value is RunScopedCurrentStateExit {
  return (
    isRecord(value) &&
    isNonEmptyString(value['name']) &&
    isNonEmptyString(value['kind']) &&
    (value['branchCount'] === undefined || isSafeNumber(value['branchCount']))
  );
}

function isRunScopedStateVisit(value: unknown): value is RunScopedStateVisit {
  return (
    isRecord(value) &&
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['path']) &&
    isSafeNumber(value['seq']) &&
    isNonEmptyString(value['time']) &&
    (value['from'] === undefined || isStringOrNull(value['from'])) &&
    isNonEmptyString(value['to']) &&
    isOptionalString(value['cause'])
  );
}

function isRunScopedPendingRequestSummary(value: unknown): value is RunScopedPendingRequestSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value['requestId']) &&
    (value['status'] === 'pending' || value['status'] === 'submitted') &&
    isOptionalString(value['kind']) &&
    isOptionalString(value['summary']) &&
    isNonEmptyString(value['createdAt']) &&
    isNonEmptyString(value['updatedAt']) &&
    isOptionalString(value['stateVisitId']) &&
    isOptionalString(value['turnId']) &&
    isOptionalString(value['itemId']) &&
    isNonEmptyString(value['lastEventId']) &&
    (value['pendingCard'] === undefined || isRunScopedPendingCard(value['pendingCard']))
  );
}

function isRunScopedPendingCard(value: unknown): value is RunScopedPendingCard {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'owner-input':
      return isRunScopedOwnerInputPendingCard(value);
    case 'file-approval':
      return isRunScopedFileApprovalPendingCard(value);
    case 'command-approval':
      return isRunScopedCommandApprovalPendingCard(value);
    case 'permission-approval':
      return isRunScopedPermissionApprovalPendingCard(value);
    case 'elicitation':
      return isRunScopedElicitationPendingCard(value);
    default:
      return false;
  }
}

function isRunScopedOwnerInputPendingCard(
  value: Record<string, unknown>,
): value is RunScopedOwnerInputPendingCard {
  return (
    isPendingCardBase(value, 'owner-input', 'item/tool/requestUserInput') &&
    isArrayOf(value['questions'], isRunScopedOwnerInputPendingCardQuestion)
  );
}

function isRunScopedOwnerInputPendingCardQuestion(
  value: unknown,
): value is RunScopedOwnerInputPendingCardQuestion {
  return (
    isRecord(value) &&
    isNonEmptyString(value['id']) &&
    typeof value['header'] === 'string' &&
    isNonEmptyString(value['question']) &&
    typeof value['isOther'] === 'boolean' &&
    typeof value['isSecret'] === 'boolean' &&
    (value['choices'] === undefined || isArrayOf(value['choices'], isString))
  );
}

function isRunScopedFileApprovalPendingCard(
  value: Record<string, unknown>,
): value is RunScopedFileApprovalPendingCard {
  return (
    isPendingCardBase(value, 'file-approval', 'item/fileChange/requestApproval') &&
    isNonEmptyString(value['threadId']) &&
    isNonEmptyString(value['turnId']) &&
    isNonEmptyString(value['itemId']) &&
    isOptionalString(value['reason']) &&
    isOptionalString(value['grantRoot']) &&
    isArrayOf(value['changes'], isFileUpdateChange)
  );
}

function isRunScopedCommandApprovalPendingCard(
  value: Record<string, unknown>,
): value is RunScopedCommandApprovalPendingCard {
  return (
    isPendingCardBase(value, 'command-approval', 'item/commandExecution/requestApproval') &&
    isNonEmptyString(value['threadId']) &&
    isNonEmptyString(value['turnId']) &&
    isNonEmptyString(value['itemId']) &&
    isOptionalString(value['approvalId']) &&
    isOptionalString(value['command']) &&
    isOptionalString(value['cwd']) &&
    isOptionalString(value['reason']) &&
    (value['commandActions'] === undefined || Array.isArray(value['commandActions']))
  );
}

function isRunScopedPermissionApprovalPendingCard(
  value: Record<string, unknown>,
): value is RunScopedPermissionApprovalPendingCard {
  return (
    isPendingCardBase(value, 'permission-approval', 'item/permissions/requestApproval') &&
    isNonEmptyString(value['threadId']) &&
    isNonEmptyString(value['turnId']) &&
    isNonEmptyString(value['itemId']) &&
    isNonEmptyString(value['cwd']) &&
    value['permissions'] !== undefined &&
    isOptionalString(value['reason'])
  );
}

function isRunScopedElicitationPendingCard(
  value: Record<string, unknown>,
): value is RunScopedElicitationPendingCard {
  return (
    isPendingCardBase(value, 'elicitation', 'mcpServer/elicitation/request') &&
    isNonEmptyString(value['threadId']) &&
    isStringOrNull(value['turnId']) &&
    isNonEmptyString(value['serverName']) &&
    (value['mode'] === 'form' || value['mode'] === 'url') &&
    isNonEmptyString(value['message']) &&
    isOptionalString(value['url']) &&
    isOptionalString(value['elicitationId'])
  );
}

function isPendingCardBase(value: Record<string, unknown>, kind: string, method: string): boolean {
  return (
    value['kind'] === kind &&
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['requestId']) &&
    value['method'] === method
  );
}

function isRunScopedAggregateStats(value: unknown): value is RunScopedAggregateStats {
  return (
    isRecord(value) &&
    !('raw' in value) &&
    isOptionalString(value['status']) &&
    isOptionalString(value['startedAt']) &&
    isOptionalString(value['endedAt']) &&
    isSafeNumber(value['turnCount']) &&
    isOptionalString(value['activeTurnId']) &&
    isOptionalNumber(value['totalTokens']) &&
    isOptionalNumber(value['inputTokens']) &&
    isOptionalNumber(value['cachedInputTokens']) &&
    isOptionalNumber(value['outputTokens']) &&
    isOptionalNumber(value['reasoningOutputTokens']) &&
    isOptionalNumber(value['modelContextWindow'])
  );
}

function isRunScopedCompactRow(value: unknown): value is RunScopedCompactRow {
  if (!isRecord(value) || 'raw' in value) return false;
  return (
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['eventId']) &&
    isSafeNumber(value['seq']) &&
    isNonEmptyString(value['time']) &&
    isNonEmptyString(value['type']) &&
    isOptionalString(value['stateVisitId']) &&
    isOptionalString(value['turnId']) &&
    isOptionalString(value['itemId']) &&
    isOptionalString(value['requestId']) &&
    isNonEmptyString(value['kind']) &&
    isOptionalString(value['label']) &&
    isOptionalString(value['text']) &&
    isOptionalString(value['status']) &&
    isOptionalString(value['summary']) &&
    isOptionalNumber(value['elapsedMs']) &&
    isOptionalString(value['output']) &&
    isOptionalBoolean(value['ok']) &&
    isOptionalString(value['resultId']) &&
    (value['data'] === undefined || isRecord(value['data']))
  );
}

function isRunScopedReplayDiagnostic(value: unknown): value is RunScopedReplayDiagnostic {
  return (
    isRecord(value) &&
    (value['severity'] === 'warning' || value['severity'] === 'corruption') &&
    isNonEmptyString(value['code']) &&
    isNonEmptyString(value['message']) &&
    isOptionalNumber(value['line']) &&
    isOptionalNumber(value['offset']) &&
    isOptionalNumber(value['seq']) &&
    isOptionalString(value['id'])
  );
}

function isTopology(value: unknown): value is Topology {
  return (
    isRecord(value) &&
    typeof value['machineId'] === 'string' &&
    typeof value['initial'] === 'string' &&
    Array.isArray(value['nodes']) &&
    Array.isArray(value['edges'])
  );
}

function isStatePathVisits(
  value: unknown,
): value is Readonly<Record<string, ReadonlyArray<string>>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((visits) => isArrayOf(visits, isString));
}

function isFileUpdateChange(value: unknown): value is FileUpdateChange {
  return (
    isRecord(value) &&
    isNonEmptyString(value['path']) &&
    isRecord(value['kind']) &&
    typeof value['diff'] === 'string'
  );
}

function isFsmStateKind(value: unknown): value is FsmState['kind'] {
  return value === 'stateful' || value === 'terminal' || value === 'passive' || value === 'final';
}

function isRunScopedResyncReason(value: unknown): value is RunScopedResyncReason {
  return (
    value === 'invalid-event-cursor' ||
    value === 'wrong-run-event-cursor' ||
    value === 'future-event-cursor' ||
    value === 'run-event-log-unavailable'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item) => guard(item));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
