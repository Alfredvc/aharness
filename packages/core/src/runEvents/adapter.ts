import type { EventLogEntryInput } from '../events.js';
import type {
  AppEvent,
  CommandApprovalRequest,
  ElicitationRequest,
  FileChangeApprovalRequest,
  FsmState,
  ItemStarted,
  OwnerInputRequest,
  PermissionApprovalRequest,
} from '../ui/events.js';
import type { RunEventAppendInput, RunEventPayload, RunEventPendingCard } from './types.js';
import { ownerChoiceRequestId } from '../ownerChoice.js';

const ABANDONED_THREAD_RESIDUE_SOURCE_MAX_BYTES = 128;
const ABANDONED_THREAD_RESIDUE_MESSAGE_MAX_BYTES = 512;
const TRUNCATION_MARKER = '…[truncated]';

export interface SidecarRunEventDiagnostic {
  readonly type: string;
  readonly key?: string;
  readonly label?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly message?: string;
  readonly data?: unknown;
}

function compactRecord<T extends Record<string, unknown>>(record: T): RunEventPayload {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function compactRunEventPayload<T extends Record<string, unknown>>(
  record: T,
): RunEventPayload {
  return compactRecord(record);
}

export function runLifecycleRow(input: {
  readonly event: 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled';
  readonly status: 'started' | 'completed' | 'failed' | 'cancelled';
  readonly summary?: string;
}): RunEventPayload {
  return compactRecord({
    kind: 'run_lifecycle',
    label:
      input.event === 'run.started'
        ? 'run started'
        : input.event === 'run.completed'
          ? 'run completed'
          : input.event === 'run.failed'
            ? 'run failed'
            : 'run cancelled',
    status: input.status,
    summary: input.summary,
  });
}

export function enrichRunEventAppendInput(
  input: RunEventAppendInput | null,
  additions: Partial<RunEventAppendInput>,
): RunEventAppendInput | null {
  if (input === null) return null;
  let merged: RunEventAppendInput = {
    ...input,
    ...additions,
  };
  if (input.data !== undefined || additions.data !== undefined) {
    merged = {
      ...merged,
      data: compactRecord({
        ...(input.data ?? {}),
        ...(additions.data ?? {}),
      }),
    };
  }
  if (input.meta !== undefined || additions.meta !== undefined) {
    merged = {
      ...merged,
      meta: compactRecord({
        ...(input.meta ?? {}),
        ...(additions.meta ?? {}),
      }),
    };
  }
  if (input.raw !== undefined || additions.raw !== undefined) {
    merged = {
      ...merged,
      raw: compactRecord({
        ...(input.raw ?? {}),
        ...(additions.raw ?? {}),
      }),
    };
  }
  return merged;
}

export function appEventToEnrichedRunEventAppendInput(
  event: AppEvent,
  additions: Partial<RunEventAppendInput>,
): RunEventAppendInput | null {
  return enrichRunEventAppendInput(appEventToRunEventAppendInput(event), additions);
}

function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  const markerBytes = enc.encode(TRUNCATION_MARKER).length;
  const headCap = Math.max(0, maxBytes - markerBytes);
  const fatalDec = new TextDecoder('utf-8', { fatal: true });
  let take = headCap;
  while (take > 0) {
    try {
      return fatalDec.decode(bytes.slice(0, take)) + TRUNCATION_MARKER;
    } catch {
      take -= 1;
    }
  }
  return TRUNCATION_MARKER;
}

function stateVisitId(state: FsmState): string {
  return `${state.path}#${state.visitCount}`;
}

function stateIdentity(state: FsmState): RunEventPayload {
  return compactRecord({
    path: state.path,
    leaf: state.leaf,
    kind: state.kind,
    visitCount: state.visitCount,
    exits: state.exits.map((exit) =>
      compactRecord({
        name: exit.name,
        kind: exit.kind,
        branchCount: exit.branchCount,
      }),
    ),
  });
}

function stateRowData(event: Extract<AppEvent, { kind: 'StateChange' }>): RunEventPayload {
  const state = event.newState;
  return compactRecord({
    from: event.from,
    to: event.to,
    cause: event.cause,
    visitCount: state.visitCount,
    stateKind: state.kind,
    open: typeof state.open === 'boolean' ? state.open : undefined,
    model: typeof state.model === 'string' && state.model.length > 0 ? state.model : undefined,
    effort:
      state.effort === 'none' ||
      state.effort === 'minimal' ||
      state.effort === 'low' ||
      state.effort === 'medium' ||
      state.effort === 'high' ||
      state.effort === 'xhigh'
        ? state.effort
        : undefined,
  });
}

function displayKindForToolName(toolName: string | undefined): string | undefined {
  if (toolName === undefined) return undefined;
  const normalized = toolName.toLowerCase();
  if (normalized === 'bash' || normalized.includes('exec') || normalized.includes('shell')) {
    return 'command';
  }
  if (normalized.includes('read') || normalized === 'cat') return 'read';
  if (normalized.includes('list') || normalized === 'ls') return 'list';
  if (normalized.includes('search') || normalized.includes('grep') || normalized === 'rg') {
    return 'search';
  }
  if (normalized.startsWith('mcp:')) return 'mcp';
  if (normalized.includes('agent')) return 'subagent';
  return 'tool';
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeSidecarEventType(type: string): string {
  if (type === 'sidecar.request.created') return 'sidecar.input_request.created';
  if (type === 'sidecar.request.resolved') return 'sidecar.input_request.resolved';
  return type;
}

function sidecarLabel(input: SidecarRunEventDiagnostic): string {
  return input.label ?? input.key ?? input.threadId ?? 'sidecar';
}

function sidecarBaseData(input: SidecarRunEventDiagnostic): RunEventPayload {
  return compactRecord({
    sidecar: true,
    sidecarKey: input.key,
    sidecarLabel: input.label,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    requestId: input.requestId,
  });
}

function sidecarRow(input: {
  readonly diagnostic: SidecarRunEventDiagnostic;
  readonly activity: string;
  readonly status: string;
  readonly summary: string;
  readonly label?: string;
  readonly data?: RunEventPayload;
}): RunEventPayload {
  return compactRecord({
    kind: 'sidecar',
    label: input.label ?? sidecarLabel(input.diagnostic),
    status: input.status,
    summary: input.summary,
    data: compactRecord({
      ...sidecarBaseData(input.diagnostic),
      activity: input.activity,
      ...(input.data ?? {}),
    }),
  });
}

function sidecarThreadData(
  input: SidecarRunEventDiagnostic,
  status: 'started' | 'closed',
): RunEventPayload {
  return compactRecord({
    ...sidecarBaseData(input),
    kind: 'sidecar-thread',
    status,
    row: sidecarRow({
      diagnostic: input,
      activity: 'thread',
      status,
      summary: `thread ${status}`,
    }),
  });
}

function sidecarTurnData(
  input: SidecarRunEventDiagnostic,
  status: 'started' | 'completed' | 'timeout',
): RunEventPayload {
  return compactRecord({
    ...sidecarBaseData(input),
    kind: 'sidecar-turn',
    status,
    row: sidecarRow({
      diagnostic: input,
      activity: 'turn',
      status,
      summary: input.turnId === undefined ? `turn ${status}` : `${input.turnId} ${status}`,
    }),
  });
}

function sidecarItemData(
  input: SidecarRunEventDiagnostic,
  status: 'started' | 'completed' | 'updated',
): RunEventPayload {
  const data = readRecord(input.data);
  const item = readRecord(data?.['item']);
  const itemType = readString(item?.['type']);
  const toolName = readString(item?.['name']);
  const displayName = toolName ?? itemType ?? input.itemId ?? 'item';
  return compactRecord({
    ...sidecarBaseData(input),
    kind: 'sidecar-item',
    status,
    itemType,
    toolName,
    row: sidecarRow({
      diagnostic: input,
      activity: 'item',
      status,
      label: displayName,
      summary: `${displayName} ${status}`,
      data: compactRecord({
        itemType,
        toolName,
        displayKind: displayKindForToolName(toolName),
      }),
    }),
  });
}

function tokenBreakdown(value: unknown): RunEventPayload | undefined {
  const source = readRecord(value);
  if (source === undefined) return undefined;
  return compactRecord({
    totalTokens: readNumber(source['totalTokens']),
    inputTokens: readNumber(source['inputTokens']),
    cachedInputTokens: readNumber(source['cachedInputTokens']),
    outputTokens: readNumber(source['outputTokens']),
    reasoningOutputTokens: readNumber(source['reasoningOutputTokens']),
  });
}

function sidecarTokenData(input: SidecarRunEventDiagnostic): RunEventPayload {
  const data = readRecord(input.data);
  const tokenUsage = readRecord(data?.['tokenUsage']);
  const total = tokenBreakdown(tokenUsage?.['total']) ?? tokenBreakdown(tokenUsage);
  const last = tokenBreakdown(tokenUsage?.['last']);
  const totalTokens = readNumber(total?.['totalTokens']);
  return compactRecord({
    ...sidecarBaseData(input),
    kind: 'sidecar-token',
    total,
    last,
    modelContextWindow: readNumber(tokenUsage?.['modelContextWindow']),
    row: sidecarRow({
      diagnostic: input,
      activity: 'token',
      status: 'updated',
      summary:
        totalTokens === undefined ? 'token usage updated' : `${String(totalTokens)} sidecar tokens`,
    }),
  });
}

function sidecarInputRequestData(
  input: SidecarRunEventDiagnostic,
  status: 'pending' | 'resolved',
): RunEventPayload {
  const data = readRecord(input.data);
  const questions = Array.isArray(data?.['questions']) ? data['questions'] : undefined;
  const requestId = input.requestId ?? readString(data?.['requestId']) ?? input.itemId;
  const questionCount = questions?.length;
  return compactRecord({
    ...sidecarBaseData({ ...input, ...(requestId !== undefined ? { requestId } : {}) }),
    kind: 'sidecar-input-request',
    status,
    questionCount,
    row: sidecarRow({
      diagnostic: input,
      activity: 'input_request',
      status,
      summary:
        status === 'resolved'
          ? 'input request resolved'
          : `${String(questionCount ?? 0)} input question${questionCount === 1 ? '' : 's'}`,
      data: compactRecord({
        requestId,
        questionCount,
      }),
    }),
  });
}

function sidecarDiagnosticData(input: SidecarRunEventDiagnostic): RunEventPayload {
  return compactRecord({
    ...sidecarBaseData(input),
    kind: 'sidecar-diagnostic',
    status: 'warn',
    message: input.message,
    row: sidecarRow({
      diagnostic: input,
      activity: 'diagnostic',
      status: 'warn',
      summary: input.message ?? input.type,
    }),
  });
}

function sidecarRawEvidenceData(
  input: SidecarRunEventDiagnostic,
  kind: 'sidecar-message-delta' | 'sidecar-raw-response-item',
  status: 'updated' | 'completed',
): RunEventPayload {
  return compactRecord({
    ...sidecarBaseData(input),
    kind,
    status,
  });
}

export function sidecarDiagnosticToRunEventAppendInput(
  diagnostic: SidecarRunEventDiagnostic,
): RunEventAppendInput {
  const type = normalizeSidecarEventType(diagnostic.type);
  const requestId =
    diagnostic.requestId ??
    (type.startsWith('sidecar.input_request.')
      ? (readString(readRecord(diagnostic.data)?.['requestId']) ?? diagnostic.itemId)
      : undefined);
  let data: RunEventPayload;
  switch (type) {
    case 'sidecar.thread.started':
      data = sidecarThreadData(diagnostic, 'started');
      break;
    case 'sidecar.thread.closed':
      data = sidecarThreadData(diagnostic, 'closed');
      break;
    case 'sidecar.turn.started':
      data = sidecarTurnData(diagnostic, 'started');
      break;
    case 'sidecar.turn.completed':
      data = sidecarTurnData(diagnostic, 'completed');
      break;
    case 'sidecar.turn.timeout':
      data = sidecarTurnData(diagnostic, 'timeout');
      break;
    case 'sidecar.item.started':
      data = sidecarItemData(diagnostic, 'started');
      break;
    case 'sidecar.item.completed':
      data = sidecarItemData(diagnostic, 'completed');
      break;
    case 'sidecar.item.fileChange.patchUpdated':
      data = sidecarItemData(diagnostic, 'updated');
      break;
    case 'sidecar.input_request.created':
      data = sidecarInputRequestData(diagnostic, 'pending');
      break;
    case 'sidecar.input_request.resolved':
      data = sidecarInputRequestData(diagnostic, 'resolved');
      break;
    case 'sidecar.token.updated':
      data = sidecarTokenData(diagnostic);
      break;
    case 'sidecar.agentMessage.delta':
      data = sidecarRawEvidenceData(diagnostic, 'sidecar-message-delta', 'updated');
      break;
    case 'sidecar.rawResponseItem.completed':
      data = sidecarRawEvidenceData(diagnostic, 'sidecar-raw-response-item', 'completed');
      break;
    default:
      data = sidecarDiagnosticData(diagnostic);
      break;
  }
  return {
    type,
    ...(diagnostic.threadId !== undefined ? { threadId: diagnostic.threadId } : {}),
    ...(diagnostic.turnId !== undefined ? { turnId: diagnostic.turnId } : {}),
    ...(diagnostic.itemId !== undefined ? { itemId: diagnostic.itemId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    data,
    meta: compactRecord({
      sidecar: true,
      sidecarKey: diagnostic.key,
      sidecarLabel: diagnostic.label,
    }),
    ...(diagnostic.data !== undefined || diagnostic.message !== undefined
      ? {
          raw: compactRecord({
            message: diagnostic.message,
            data: diagnostic.data,
          }),
        }
      : {}),
  };
}

function ownerInputRequestData(event: OwnerInputRequest): RunEventPayload {
  const secretQuestionCount = event.questions.filter((question) => question.isSecret).length;
  const otherQuestionCount = event.questions.filter((question) => question.isOther).length;
  const pendingCard: RunEventPendingCard = {
    kind: 'owner-input',
    id: event.id,
    requestId: event.id,
    method: event.method,
    questions: event.questions.map((question) => {
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        isOther: question.isOther,
        isSecret: question.isSecret,
        ...(question.choices !== undefined ? { choices: question.choices } : {}),
      };
    }),
  };
  return compactRecord({
    requestId: event.id,
    itemId: event.id,
    method: event.method,
    kind: 'owner-input',
    status: 'pending',
    questionCount: event.questions.length,
    secretQuestionCount,
    otherQuestionCount,
    pendingCard,
    row: {
      kind: 'request',
      label: 'owner input',
      status: 'pending',
      summary: `${event.questions.length} question${event.questions.length === 1 ? '' : 's'}`,
    },
  });
}

export function ownerChoicePendingRunEvent(input: {
  readonly state: string;
  readonly visitCount: number;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string }>;
}): RunEventAppendInput {
  const requestId = ownerChoiceRequestId(input.state, input.visitCount);
  const stateVisitId = `${input.state}#${input.visitCount}`;
  const pendingCard: RunEventPendingCard = {
    kind: 'owner-choice',
    id: requestId,
    requestId,
    state: input.state,
    visitCount: input.visitCount,
    question: input.question,
    options: input.options.map((option) => ({ label: option.label })),
  };
  return {
    type: 'request.updated',
    requestId,
    stateVisitId,
    data: compactRecord({
      requestId,
      stateVisitId,
      kind: 'owner-choice',
      status: 'pending',
      state: input.state,
      visitCount: input.visitCount,
      question: input.question,
      optionCount: input.options.length,
      pendingCard,
      row: {
        kind: 'request',
        label: 'owner choice',
        status: 'pending',
        summary: `${input.options.length} option${input.options.length === 1 ? '' : 's'}`,
        data: compactRecord({
          kind: 'owner-choice',
          requestId,
          state: input.state,
          visitCount: input.visitCount,
        }),
      },
    }),
  };
}

function fileApprovalRequestData(event: FileChangeApprovalRequest): RunEventPayload {
  const pendingCard: RunEventPendingCard = {
    kind: 'file-approval',
    id: event.id,
    requestId: event.requestId,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId,
    changes: event.changes,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.grantRoot !== undefined ? { grantRoot: event.grantRoot } : {}),
  };
  return compactRecord({
    requestId: event.requestId,
    method: event.method,
    kind: 'file-approval',
    status: 'pending',
    changeCount: event.changes.length,
    pendingCard,
    row: {
      kind: 'request',
      label: 'file approval',
      status: 'pending',
      summary: `${event.changes.length} change${event.changes.length === 1 ? '' : 's'}`,
    },
  });
}

function commandApprovalRequestData(event: CommandApprovalRequest): RunEventPayload {
  const pendingCard: RunEventPendingCard = {
    kind: 'command-approval',
    id: event.id,
    requestId: event.requestId,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId,
    ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
    ...(event.command !== undefined ? { command: event.command } : {}),
    ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.commandActions !== undefined ? { commandActions: event.commandActions } : {}),
    ...(event.networkApprovalContext !== undefined
      ? { networkApprovalContext: event.networkApprovalContext }
      : {}),
  };
  return compactRecord({
    requestId: event.requestId,
    method: event.method,
    kind: 'command-approval',
    status: 'pending',
    approvalId: event.approvalId,
    hasCommand: event.command !== undefined,
    hasCwd: event.cwd !== undefined,
    actionCount: event.commandActions?.length,
    pendingCard,
    row: {
      kind: 'request',
      label: 'command approval',
      status: 'pending',
      summary: event.approvalId ?? 'command approval',
    },
  });
}

function permissionApprovalRequestData(event: PermissionApprovalRequest): RunEventPayload {
  const pendingCard: RunEventPendingCard = {
    kind: 'permission-approval',
    id: event.id,
    requestId: event.requestId,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId,
    cwd: event.cwd,
    permissions: event.permissions,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  };
  return compactRecord({
    requestId: event.requestId,
    method: event.method,
    kind: 'permission-approval',
    status: 'pending',
    pendingCard,
    row: {
      kind: 'request',
      label: 'permission approval',
      status: 'pending',
      summary: 'permission approval',
    },
  });
}

function elicitationRequestData(event: ElicitationRequest): RunEventPayload {
  const pendingCard: RunEventPendingCard = {
    kind: 'elicitation',
    id: event.id,
    requestId: event.requestId,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    serverName: event.serverName,
    mode: event.mode,
    message: event.message,
    ...(event.requestedSchema !== undefined ? { requestedSchema: event.requestedSchema } : {}),
    ...(event.url !== undefined ? { url: event.url } : {}),
    ...(event.elicitationId !== undefined ? { elicitationId: event.elicitationId } : {}),
  };
  return compactRecord({
    requestId: event.requestId,
    method: event.method,
    kind: 'elicitation',
    status: 'pending',
    serverName: event.serverName,
    mode: event.mode,
    hasSchema: event.requestedSchema !== undefined,
    hasUrl: event.url !== undefined,
    pendingCard,
    row: {
      kind: 'request',
      label: 'elicitation',
      status: 'pending',
      summary: event.serverName,
    },
  });
}

function itemInput(event: ItemStarted): RunEventAppendInput {
  if (event.type === 'function_call') {
    return {
      type: 'item.started',
      itemId: event.id,
      data: compactRecord({
        itemId: event.id,
        itemType: event.type,
        kind: 'tool',
        toolName: event.name,
        status: 'started',
        row: {
          kind: 'tool',
          label: event.name,
          status: 'pending',
          summary: event.name,
          data: compactRecord({
            displayKind: displayKindForToolName(event.name),
          }),
        },
      }),
    };
  }
  if (event.type === 'function_call_output') {
    const itemId = event.id.endsWith(':output') ? event.id.slice(0, -':output'.length) : event.id;
    return {
      type: 'item.completed',
      itemId,
      data: compactRecord({
        itemId,
        outputItemId: event.id,
        itemType: event.type,
        kind: 'tool',
        toolName: event.name,
        status: event.ok ? 'completed' : 'failed',
        ok: event.ok,
        row: {
          kind: 'tool',
          label: event.name,
          status: event.ok ? 'completed' : 'failed',
          summary: event.name,
          output: event.output,
          ok: event.ok,
          resultId: event.id,
          data: compactRecord({
            displayKind: displayKindForToolName(event.name),
          }),
        },
      }),
    };
  }

  return {
    type: 'item.started',
    itemId: event.id,
    data: compactRecord({
      itemId: event.id,
      itemType: event.type,
      kind: event.type,
      status: 'started',
      row: {
        kind: event.type === 'reasoning' ? 'reasoning' : 'message',
        label: event.type,
        status: 'started',
      },
    }),
  };
}

export function appEventToRunEventAppendInput(event: AppEvent): RunEventAppendInput | null {
  switch (event.kind) {
    case 'AgentMessageDelta':
      return {
        type: 'model.delta',
        itemId: event.id,
        data: compactRecord({
          itemId: event.id,
          delta: event.delta,
          reasoning: event.reasoning,
          row: {
            kind: event.reasoning === true ? 'reasoning' : 'message',
            text: event.delta,
          },
        }),
      };
    case 'ItemStarted':
      return itemInput(event);
    case 'TurnStarted':
      return {
        type: 'turn.started',
        turnId: event.turnId,
        data: { turnId: event.turnId },
      };
    case 'TurnCompleted':
      return {
        type: 'turn.completed',
        turnId: event.turnId,
        data: { turnId: event.turnId, finishReason: event.finishReason },
      };
    case 'StateChange': {
      const visitId = stateVisitId(event.newState);
      return {
        type: 'state.changed',
        stateVisitId: visitId,
        data: compactRecord({
          from: event.from,
          to: event.to,
          cause: event.cause,
          stateVisitId: visitId,
          ...stateIdentity(event.newState),
          row: {
            kind: 'state_change',
            label: event.to,
            status: event.cause,
            summary: event.from === null ? event.to : `${event.from} -> ${event.to}`,
            data: stateRowData(event),
          },
        }),
      };
    }
    case 'FrameworkNote':
      return {
        type: 'framework.note',
        data: {
          id: event.id,
          variant: event.variant,
          text: event.text,
          row: {
            kind: 'framework_note',
            text: event.text,
            status: event.variant,
          },
        },
      };
    case 'FreshClearBoundary':
      return {
        type: 'fresh_clear.boundary',
        data: {
          id: event.id,
          reason: event.reason,
          previousThreadId: event.previousThreadId,
          nextThreadId: event.nextThreadId,
          statePath: event.statePath,
          row: {
            kind: 'fresh_clear',
            label: event.statePath,
            status: event.reason,
          },
        },
      };
    case 'AbandonedThreadDiagnostic': {
      const source = truncateUtf8(event.source, ABANDONED_THREAD_RESIDUE_SOURCE_MAX_BYTES);
      const message = truncateUtf8(event.message, ABANDONED_THREAD_RESIDUE_MESSAGE_MAX_BYTES);
      return {
        type: 'diagnostic.abandoned_thread',
        threadId: event.threadId,
        data: {
          id: event.id,
          source,
          message,
          row: {
            kind: 'diagnostic',
            label: source,
            text: message,
            status: 'warn',
          },
        },
      };
    }
    case 'PostureChange':
      return {
        type: 'posture.changed',
        data: { posture: compactRecord(event.posture) },
      };
    case 'ServerRequest':
      switch (event.method) {
        case 'item/tool/requestUserInput':
          return {
            type: 'request.created',
            itemId: event.id,
            requestId: event.id,
            data: ownerInputRequestData(event),
          };
        case 'item/fileChange/requestApproval':
          return {
            type: 'request.created',
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            requestId: event.requestId,
            data: fileApprovalRequestData(event),
          };
        case 'item/commandExecution/requestApproval':
          return {
            type: 'request.created',
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            requestId: event.requestId,
            data: commandApprovalRequestData(event),
          };
        case 'item/permissions/requestApproval':
          return {
            type: 'request.created',
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            requestId: event.requestId,
            data: permissionApprovalRequestData(event),
          };
        case 'mcpServer/elicitation/request':
          return {
            type: 'request.created',
            threadId: event.threadId,
            ...(event.turnId !== null ? { turnId: event.turnId } : {}),
            requestId: event.requestId,
            data: elicitationRequestData(event),
          };
      }
      return null;
    case 'FileApprovalUpdated':
      return {
        type: 'request.updated',
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        requestId: event.requestId,
        data: {
          requestId: event.requestId,
          kind: 'file-approval',
          status: 'pending',
          changeCount: event.changes.length,
          pendingCard: compactRecord({
            kind: 'file-approval',
            id: event.id,
            requestId: event.requestId,
            method: 'item/fileChange/requestApproval',
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            changes: event.changes,
          }),
        },
      };
    case 'ApprovalRequestResolved':
      return {
        type: 'request.resolved',
        requestId: event.requestId,
        data: { requestId: event.requestId, status: 'resolved' },
      };
    case 'OwnerInputResolved':
      return {
        type: 'request.resolved',
        requestId: event.id,
        data: { requestId: event.id, kind: 'owner-input', status: 'resolved' },
      };
    case 'ResyncRequired':
      return null;
  }
}

export function legacyEventInputToRunEventAppendInput(
  input: EventLogEntryInput,
): RunEventAppendInput {
  switch (input.kind) {
    case 'hook':
      return {
        type: 'hook.observed',
        data: {
          name: input.name,
          payloadDigest: input.payloadDigest,
        },
      };
    case 'submit':
      return {
        type: 'submit.recorded',
        data: compactRecord({
          stateId: input.stateId,
          accepted: input.accepted,
          error: input.error,
        }),
      };
    case 'transition':
      return {
        type: 'transition.recorded',
        data: {
          from: input.from,
          to: input.to,
          eventType: input.eventType,
        },
      };
    case 'artifact':
      return {
        type: 'artifact.written',
        data: {
          relPath: input.relPath,
          bytes: input.bytes,
        },
      };
    case 'terminal':
      return {
        type: input.terminal === 'failure' ? 'run.failed' : 'run.completed',
        data: {
          state: input.state,
          terminal: input.terminal,
          status: input.terminal,
          row: runLifecycleRow({
            event: input.terminal === 'failure' ? 'run.failed' : 'run.completed',
            status: input.terminal === 'failure' ? 'failed' : 'completed',
            summary: `Run ${input.terminal === 'failure' ? 'failed' : 'completed'} at ${input.state}`,
          }),
        },
      };
    case 'abandonedThreadResidue':
      return {
        type: 'diagnostic.abandoned_thread',
        threadId: input.threadId,
        data: {
          source: input.source,
          message: input.message,
        },
      };
  }
}
