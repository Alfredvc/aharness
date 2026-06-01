import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../protocol/types.js';
import { buildAbandonedToolRequestUserInputResponse } from '../runtime/abandonedThreadResponses.js';

export type BrowserReplyPayload =
  | { kind: 'owner-input'; requestId: string; answers: Record<string, string> }
  | { kind: 'owner-choice'; state: string; visitCount: number; label: string }
  | { kind: 'user-prompt'; text: string }
  | { kind: 'approval'; requestId: string; decision: string }
  | { kind: 'permission'; requestId: string; decision: string }
  | { kind: 'elicitation'; requestId: string; action: string; values?: Record<string, unknown> };

export type BrowserReplyResult = {
  status: number;
  body: unknown;
};

export type BrowserReplyLifecycleInput = {
  payload: unknown;
  kind?: string;
  requestId?: string;
  state?: string;
  visitCount?: number;
  label?: string;
};

export type BrowserReplyResolvedInput = BrowserReplyLifecycleInput & {
  result?: BrowserReplyResult;
  error?: Error;
};

export type BrowserReplyControllerOptions = {
  isOpen: () => boolean;
  sendUserPrompt: (text: string) => void | Promise<void>;
  onOwnerInputAccepted?: (requestId: string) => void;
  onOwnerInputResolved?: (requestId: string) => void;
  isAbandonedThread?: (threadId: string) => boolean;
  onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
  handleApprovalReply?: (payload: unknown) => Promise<BrowserReplyResult> | BrowserReplyResult;
  handleOwnerChoiceReply?: (
    payload: Extract<BrowserReplyPayload, { kind: 'owner-choice' }>,
  ) => Promise<BrowserReplyResult> | BrowserReplyResult;
  onReplySubmitted?: (input: BrowserReplyLifecycleInput) => void;
  onReplyResolved?: (input: BrowserReplyResolvedInput) => void;
};

export type BrowserReplyController = {
  parkOwnerInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
  abandonInactiveOwnerInput(): void;
  handleReply(payload: unknown): Promise<BrowserReplyResult>;
};

type PendingOwnerInput = {
  requestId: string;
  threadId: string | null;
  params: ToolRequestUserInputParams;
  questionIds: string[];
  resolve: (response: ToolRequestUserInputResponse) => void;
  reject: (error: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(): BrowserReplyResult {
  return { status: 501, body: { error: 'reply-kind-unavailable' } };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function callLifecycleHook(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    // Reply lifecycle hooks are observability only.
  }
}

export function createBrowserReplyController(
  options: BrowserReplyControllerOptions,
): BrowserReplyController {
  let pendingOwnerInput: PendingOwnerInput | null = null;

  function handleOwnerInputReply(payload: Record<string, unknown>): BrowserReplyResult {
    const requestId = payload['requestId'];
    const rawAnswers = payload['answers'];
    if (typeof requestId !== 'string' || !isRecord(rawAnswers)) {
      return { status: 400, body: { error: 'invalid-owner-input-reply' } };
    }

    if (pendingOwnerInput === null) {
      return { status: 409, body: { error: 'no-pending-owner-input' } };
    }

    if (requestId !== pendingOwnerInput.requestId) {
      return { status: 409, body: { error: 'owner-input-request-mismatch' } };
    }

    const missingQuestionIds = pendingOwnerInput.questionIds.filter((questionId) => {
      return typeof rawAnswers[questionId] !== 'string';
    });
    if (missingQuestionIds.length > 0) {
      return {
        status: 400,
        body: { error: 'missing-owner-input-answer', missingQuestionIds },
      };
    }

    const answers: ToolRequestUserInputResponse['answers'] = {};
    for (const questionId of pendingOwnerInput.questionIds) {
      answers[questionId] = { answers: [rawAnswers[questionId] as string] };
    }

    const accepted = pendingOwnerInput;
    pendingOwnerInput = null;
    accepted.resolve({ answers });
    options.onOwnerInputAccepted?.(accepted.requestId);
    options.onOwnerInputResolved?.(accepted.requestId);

    return { status: 200, body: { ok: true } };
  }

  async function handleUserPromptReply(
    payload: Record<string, unknown>,
  ): Promise<BrowserReplyResult> {
    const text = payload['text'];
    if (typeof text !== 'string') {
      return { status: 400, body: { error: 'invalid-user-prompt-reply' } };
    }

    if (!options.isOpen()) {
      return { status: 409, body: { error: 'state-not-open' } };
    }

    await options.sendUserPrompt(text);
    return { status: 200, body: { ok: true } };
  }

  async function handleOwnerChoiceReply(
    payload: Record<string, unknown>,
  ): Promise<BrowserReplyResult> {
    const state = payload['state'];
    const visitCount = payload['visitCount'];
    const label = payload['label'];
    if (
      typeof state !== 'string' ||
      typeof visitCount !== 'number' ||
      !Number.isSafeInteger(visitCount) ||
      visitCount < 0 ||
      typeof label !== 'string'
    ) {
      return { status: 400, body: { error: 'invalid-owner-choice-reply' } };
    }
    return (
      (await options.handleOwnerChoiceReply?.({
        kind: 'owner-choice',
        state,
        visitCount,
        label,
      })) ?? unavailable()
    );
  }

  return {
    parkOwnerInput(params) {
      if (pendingOwnerInput !== null) {
        pendingOwnerInput.reject(
          new Error(`stale owner-input request: ${pendingOwnerInput.requestId}`),
        );
      }

      return new Promise<ToolRequestUserInputResponse>((resolve, reject) => {
        pendingOwnerInput = {
          requestId: params.itemId,
          threadId: typeof params.threadId === 'string' ? params.threadId : null,
          params,
          questionIds: params.questions.map((question) => question.id),
          resolve,
          reject,
        };
      });
    },
    abandonInactiveOwnerInput() {
      if (pendingOwnerInput === null) {
        return;
      }
      const abandoned = pendingOwnerInput;
      const threadId = abandoned.threadId;
      if (threadId === null) {
        return;
      }
      if (options.isAbandonedThread?.(threadId) !== true) {
        return;
      }

      pendingOwnerInput = null;
      abandoned.resolve(buildAbandonedToolRequestUserInputResponse(abandoned.params));
      options.onAbandonedThreadDiagnostic?.({
        threadId,
        source: 'parkedOwnerInput',
        message: 'parked owner input resolved after thread became inactive',
      });
      options.onOwnerInputResolved?.(abandoned.requestId);
    },
    async handleReply(payload) {
      const kind = isRecord(payload) ? payload['kind'] : undefined;
      const requestId = isRecord(payload) ? payload['requestId'] : undefined;
      const state = isRecord(payload) ? payload['state'] : undefined;
      const visitCount = isRecord(payload) ? payload['visitCount'] : undefined;
      const label = isRecord(payload) ? payload['label'] : undefined;
      const lifecycle = {
        payload,
        ...(typeof kind === 'string' ? { kind } : {}),
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(typeof state === 'string' ? { state } : {}),
        ...(typeof visitCount === 'number' ? { visitCount } : {}),
        ...(typeof label === 'string' ? { label } : {}),
      };
      callLifecycleHook(() => options.onReplySubmitted?.(lifecycle));
      if (!isRecord(payload) || typeof kind !== 'string') {
        const result = { status: 400, body: { error: 'invalid-reply-payload' } };
        callLifecycleHook(() => options.onReplyResolved?.({ ...lifecycle, result }));
        return result;
      }

      try {
        let result: BrowserReplyResult;
        switch (kind) {
          case 'owner-input':
            result = handleOwnerInputReply(payload);
            break;
          case 'user-prompt':
            result = await handleUserPromptReply(payload);
            break;
          case 'owner-choice':
            result = await handleOwnerChoiceReply(payload);
            break;
          case 'approval':
          case 'permission':
          case 'elicitation':
            result = (await options.handleApprovalReply?.(payload)) ?? unavailable();
            break;
          default:
            result = { status: 400, body: { error: 'unknown-reply-kind' } };
            break;
        }
        callLifecycleHook(() => options.onReplyResolved?.({ ...lifecycle, result }));
        return result;
      } catch (error) {
        callLifecycleHook(() =>
          options.onReplyResolved?.({
            ...lifecycle,
            error: asError(error),
          }),
        );
        throw error;
      }
    },
  };
}
