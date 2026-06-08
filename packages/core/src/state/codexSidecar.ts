import type { StateModelEffort } from './exits.js';

export const CODEX_SIDECAR_DEFAULT_TURN_TIMEOUT_MS = 120_000 as const;

export type CodexSidecarCwd<Data = unknown> = string | ((data: Readonly<Data>) => string);

export interface CodexSidecarModelOptions {
  readonly name?: string;
  readonly effort?: StateModelEffort;
}

export interface CodexSidecarInstructionOptions {
  readonly base?: string;
  readonly developer?: string;
}

export interface CodexSidecarThreadOptions<Data = unknown> {
  readonly cwd?: CodexSidecarCwd<Data>;
  readonly initialSkills?: readonly string[];
  readonly defaultTurnTimeoutMs?: number;
  readonly model?: CodexSidecarModelOptions;
  readonly instructions?: CodexSidecarInstructionOptions;
  readonly label?: string;
}

export type CodexSidecarImageDetail = 'auto' | 'low' | 'high' | 'original';

export interface CodexSidecarTextInput {
  readonly type: 'text';
  readonly text: string;
}

export interface CodexSidecarImageInput {
  readonly type: 'image';
  readonly url: string;
  readonly detail?: CodexSidecarImageDetail;
}

export interface CodexSidecarLocalImageInput {
  readonly type: 'localImage';
  readonly path: string;
  readonly detail?: CodexSidecarImageDetail;
}

export interface CodexSidecarMentionInput {
  readonly type: 'mention';
  readonly name: string;
  readonly path: string;
}

export type CodexSidecarInput =
  | CodexSidecarTextInput
  | CodexSidecarImageInput
  | CodexSidecarLocalImageInput
  | CodexSidecarMentionInput;

export interface CodexSidecarTurnOptions {
  readonly timeoutMs?: number;
}

export type CodexSidecarAnswerValue = string | readonly string[];
export type CodexSidecarAnswerPayload = Readonly<Record<string, CodexSidecarAnswerValue>>;

export interface CodexSidecarEvent {
  readonly type: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly message?: string;
  readonly data?: unknown;
}

export interface CodexSidecarTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly assistantText: string;
  readonly events: readonly CodexSidecarEvent[];
  readonly tokenUsage?: unknown;
  readonly artifactsChanged?: readonly string[];
}

export interface CodexSidecarInputRequestOption {
  readonly label: string;
  readonly description?: string;
}

export interface CodexSidecarInputRequestQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly isOther?: boolean;
  readonly isSecret?: boolean;
  readonly options?: readonly CodexSidecarInputRequestOption[];
}

export interface CodexSidecarInputRequest {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly questions: readonly CodexSidecarInputRequestQuestion[];
}

export interface CodexSidecarCompletedBoundary {
  readonly ok: true;
  readonly kind: 'completed';
  readonly turn: CodexSidecarTurn;
}

export interface CodexSidecarNeedsInputBoundary {
  readonly ok: true;
  readonly kind: 'needsInput';
  readonly request: CodexSidecarInputRequest;
  readonly events: readonly CodexSidecarEvent[];
}

export type CodexSidecarBoundary = CodexSidecarCompletedBoundary | CodexSidecarNeedsInputBoundary;

export type CodexSidecarFailureReason =
  | 'timeout'
  | 'interrupted'
  | 'thread_closed'
  | 'app_server_closed'
  | 'error';

export interface CodexSidecarFailureBoundaryBase {
  readonly ok: false;
  readonly reason: CodexSidecarFailureReason;
  readonly message: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly events: readonly CodexSidecarEvent[];
}

export interface CodexSidecarTimeoutBoundary extends CodexSidecarFailureBoundaryBase {
  readonly reason: 'timeout';
}

export interface CodexSidecarInterruptedBoundary extends CodexSidecarFailureBoundaryBase {
  readonly reason: 'interrupted';
}

export interface CodexSidecarThreadClosedBoundary extends CodexSidecarFailureBoundaryBase {
  readonly reason: 'thread_closed';
}

export interface CodexSidecarAppServerClosedBoundary extends CodexSidecarFailureBoundaryBase {
  readonly reason: 'app_server_closed';
}

export interface CodexSidecarErrorBoundary extends CodexSidecarFailureBoundaryBase {
  readonly reason: 'error';
  readonly cause?: unknown;
}

export type CodexSidecarFailureBoundary =
  | CodexSidecarTimeoutBoundary
  | CodexSidecarInterruptedBoundary
  | CodexSidecarThreadClosedBoundary
  | CodexSidecarAppServerClosedBoundary
  | CodexSidecarErrorBoundary;

export type CodexSidecarBoundaryResult = CodexSidecarBoundary | CodexSidecarFailureBoundary;

export interface CodexSidecarThread {
  readonly key: string;
  readonly threadId: string;
  readonly label?: string;

  send(
    input: string | readonly CodexSidecarInput[],
    opts?: CodexSidecarTurnOptions,
  ): Promise<CodexSidecarBoundaryResult>;

  sendOrThrow(
    input: string | readonly CodexSidecarInput[],
    opts?: CodexSidecarTurnOptions,
  ): Promise<CodexSidecarBoundary>;

  answer(
    requestId: string,
    answers: CodexSidecarAnswerPayload,
    opts?: CodexSidecarTurnOptions,
  ): Promise<CodexSidecarBoundaryResult>;

  close(): Promise<void>;
}

export interface CodexSidecarOps {
  createThread<Data = unknown>(
    key: string,
    options?: CodexSidecarThreadOptions<Data>,
  ): Promise<CodexSidecarThread>;
  thread(key: string): CodexSidecarThread;
}

export class CodexSidecarError extends Error {
  readonly reason: CodexSidecarFailureReason;
  readonly threadId: string;
  readonly turnId?: string;
  readonly events: readonly CodexSidecarEvent[];

  constructor(boundary: CodexSidecarFailureBoundary) {
    super(boundary.message);
    this.name = 'CodexSidecarError';
    this.reason = boundary.reason;
    this.threadId = boundary.threadId;
    if (boundary.turnId !== undefined) {
      this.turnId = boundary.turnId;
    }
    this.events = boundary.events;
    if (boundary.reason === 'error' && boundary.cause !== undefined) {
      this.cause = boundary.cause;
    }
  }
}
