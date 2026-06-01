export type RunMeta = {
  runId: string;
  threadId: string;
  repoRoot: string;
  fsmFile: string;
  fsmHash6: string;
  codexPin: string;
  startedAt: string;
};

export type Posture = {
  isTerminal: boolean;
  isAwaiting: boolean;
  submittedThisTurn: boolean;
  open: boolean;
};

export type FsmState = {
  path: string;
  leaf: string;
  kind: 'stateful' | 'terminal' | 'passive' | 'choice' | 'final';
  open?: boolean;
  awaiting?: boolean;
  model?: string;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  awaitsOwnerText?: { messageToUser: string };
  exits: Array<{ name: string; kind: 'submit' | 'await'; branchCount?: number }>;
  visitCount: number;
  // Resolved `entryPrompt` (the per-state prompt the framework injects on
  // entry); omitted for non-stateful states.
  entryPrompt?: string;
  // XState context, stripped of aharness-internal keys (`__aharness_*`,
  // `aharness`). Surfaced for the dev-mode context inspector.
  context?: Record<string, unknown>;
};

export type UiMode = 'run' | 'inspect';

export type NodeKind = 'stateful' | 'terminal' | 'passive' | 'embed';

export type TextDetail = {
  kind: 'static' | 'dynamic';
  text: string;
};

export type HookDetail = {
  kind: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'PermissionRequest';
  count: number;
  matchers?: string[];
};

export type SkillDetail = {
  source: 'name' | 'path';
  label: string;
  optional: boolean;
};

export type ExitDetail = {
  name: string;
  kind: EdgeKind;
  targets: string[];
  branchCount?: number;
  description?: string;
  payloadSchema?: unknown;
};

export type VizNodeDetail = {
  entryPrompt?: TextDetail;
  awaitsOwnerText?: TextDetail;
  open?: boolean;
  clearOnEntry?: boolean;
  hasStopGuidance?: boolean;
  hasOnEntry?: boolean;
  hooks?: HookDetail[];
  skills?: SkillDetail[];
  exits?: ExitDetail[];
  outcome?: 'success' | 'failure';
  artifacts?: string[];
};

export type VizNode = {
  id: string;
  label: string;
  kind: NodeKind;
  open?: boolean;
  main?: true;
  awaitsOwnerText?: boolean;
  outcome?: 'success' | 'failure';
  entryPrompt?: string;
  parent?: string;
  entry?: string;
  detail?: VizNodeDetail;
};

export type EdgeKind = 'submit' | 'await' | 'always';

export type VizEdge = {
  id: string;
  from: string;
  to: string;
  exit: string;
  kind: EdgeKind;
  branchIndex?: number;
  branchTotal?: number;
  description?: string;
};

export type Topology = {
  machineId: string;
  initial: string;
  nodes: ReadonlyArray<VizNode>;
  edges: ReadonlyArray<VizEdge>;
};

export type AgentMessageDelta = {
  kind: 'AgentMessageDelta';
  id: string;
  delta: string;
  reasoning?: boolean;
};

export type ItemStarted =
  | {
      kind: 'ItemStarted';
      id: string;
      type: 'function_call';
      name: string;
      arguments: string;
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

export type TurnStarted = {
  kind: 'TurnStarted';
  turnId: string;
};

export type StateChange = {
  kind: 'StateChange';
  from: string | null;
  to: string;
  cause: 'submit' | 'await' | 'always' | 'embed-final' | 'boot' | 'choice';
  newState: FsmState;
};

export type FrameworkNote = {
  kind: 'FrameworkNote';
  id: string;
  text: string;
  variant: 'info' | 'warn' | 'orientation';
};

export type TurnCompleted = {
  kind: 'TurnCompleted';
  turnId: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'abort';
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

export type PostureChange = {
  kind: 'PostureChange';
  posture: Partial<Posture>;
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
    choices?: string[];
  }>;
};

export type FileChangeApprovalRequest = {
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

export type CommandApprovalRequest = {
  kind: 'ServerRequest';
  id: string;
  requestId: string;
  method: 'item/commandExecution/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  commandActions?: ReadonlyArray<unknown>;
  networkApprovalContext?: unknown;
};

export type PermissionApprovalRequest = {
  kind: 'ServerRequest';
  id: string;
  requestId: string;
  method: 'item/permissions/requestApproval';
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason?: string;
  permissions: RequestPermissionProfile;
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
  _meta?: unknown;
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

export type OwnerInputResolved = {
  kind: 'OwnerInputResolved';
  id: string;
};

export type ResyncRequired = {
  kind: 'ResyncRequired';
  reason: 'unknown-last-event-id' | 'event-buffer-overflow';
  requestedLastEventId: string | null;
};

export type AppEvent =
  | AgentMessageDelta
  | ItemStarted
  | StateChange
  | FrameworkNote
  | TurnStarted
  | TurnCompleted
  | FreshClearBoundary
  | AbandonedThreadDiagnostic
  | PostureChange
  | OwnerInputRequest
  | FileChangeApprovalRequest
  | CommandApprovalRequest
  | PermissionApprovalRequest
  | ElicitationRequest
  | FileApprovalUpdated
  | ApprovalRequestResolved
  | OwnerInputResolved
  | ResyncRequired;

export type ReplayableAppEvent = {
  id: string;
  event: AppEvent;
};

export type UiTranscriptEntry = {
  id: string;
  text: string;
  reasoning: boolean;
};

export type UiAppState = {
  mode?: UiMode;
  run: RunMeta | null;
  posture: Posture;
  activeTurn: { turnId: string } | null;
  currentState: FsmState | null;
  topology: Topology;
  pending: {
    ownerInput: OwnerInputRequest | null;
    fileApprovals: FileChangeApprovalRequest[];
    cmdApprovals: CommandApprovalRequest[];
    permissionApprovals: PermissionApprovalRequest[];
    elicitations: ElicitationRequest[];
  };
  transcript: UiTranscriptEntry[];
  frameworkNotes: FrameworkNote[];
  diagnostics: AbandonedThreadDiagnostic[];
  completedTurns: TurnCompleted[];
};

export type UiSnapshot = {
  latestEventId: string | null;
  state: UiAppState;
};
import type { FileUpdateChange, RequestPermissionProfile } from '../protocol/index.js';
