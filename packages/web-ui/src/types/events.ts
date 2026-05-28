// Local mirror of the codex events surface the headless CLI re-broadcasts over SSE.
// Trimmed to the shapes the UI actually consumes — production wiring will swap
// these for the generated types under codex-rs/app-server-protocol/schema/typescript/.
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
  // XState context, with harness-internal keys removed. Surfaced for the
  // dev-mode context inspector.
  context?: Record<string, unknown>;
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

export type AppEvent =
  | AgentMessageDelta
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

export type UiSnapshot = {
  latestEventId: string | null;
  state: UiAppState;
};
