import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type {
  CodexReasoningEffort,
  DynamicToolDef,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from '../protocol/types.js';

import type { ActiveThreadBinding } from './activeThreadBinding.js';

export interface PerformFreshClearOpts {
  readonly client: Pick<JsonRpcClient, 'request'>;
  readonly activeThreadBinding: ActiveThreadBinding;
  readonly oldTurnId?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly dynamicTools: ReadonlyArray<DynamicToolDef>;
  readonly waitForSettled?: () => Promise<void>;
  readonly composeActiveStateNudge: () => string;
  readonly composeActiveStateTurnInput?: () => {
    readonly input: ReadonlyArray<UserInput>;
    readonly commit: () => void;
  };
  readonly resetSkillInjectionForFreshThread?: () => void;
  readonly onCleanupError?: (error: Error) => void;
}

export interface PerformFreshClearResult {
  readonly previousThreadId: string;
  readonly nextThreadId: string;
}

export async function performFreshClear(
  opts: PerformFreshClearOpts,
): Promise<PerformFreshClearResult> {
  const oldThreadId = opts.activeThreadBinding.require();
  opts.activeThreadBinding.markAbandoned(oldThreadId);

  if (opts.oldTurnId !== undefined) {
    try {
      await opts.client.request<TurnInterruptResponse>(METHOD.turnInterrupt, {
        threadId: oldThreadId,
        turnId: opts.oldTurnId,
      } satisfies TurnInterruptParams);
    } catch (e) {
      const error = normalizeError(e);
      if (!isNonFatalInterruptError(error)) {
        opts.onCleanupError?.(error);
      }
    }
  }

  try {
    await opts.client.request<ThreadUnsubscribeResponse>(METHOD.threadUnsubscribe, {
      threadId: oldThreadId,
    } satisfies ThreadUnsubscribeParams);
  } catch (e) {
    opts.onCleanupError?.(normalizeError(e));
  }

  const threadStartConfig = buildFreshClearThreadStartConfig(opts.reasoningEffort);
  const replacement = await opts.client.request<ThreadStartResponse>(METHOD.threadStart, {
    cwd: opts.cwd,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(threadStartConfig !== undefined ? { config: threadStartConfig } : {}),
    dynamicTools: opts.dynamicTools,
    sessionStartSource: 'clear',
  } satisfies ThreadStartParams);

  opts.activeThreadBinding.set(replacement.thread.id);
  opts.resetSkillInjectionForFreshThread?.();
  const built =
    opts.composeActiveStateTurnInput?.() ??
    ({
      input: [{ type: 'text', text: opts.composeActiveStateNudge() }],
      commit: () => undefined,
    } satisfies {
      readonly input: ReadonlyArray<UserInput>;
      readonly commit: () => void;
    });
  await opts.waitForSettled?.();
  await opts.client.request<TurnStartResponse>(METHOD.turnStart, {
    threadId: replacement.thread.id,
    input: built.input,
  } satisfies TurnStartParams);
  built.commit();

  return {
    previousThreadId: oldThreadId,
    nextThreadId: replacement.thread.id,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function buildFreshClearThreadStartConfig(
  reasoningEffort: CodexReasoningEffort | undefined,
): Record<string, unknown> | undefined {
  if (reasoningEffort === undefined) return undefined;
  return { model_reasoning_effort: reasoningEffort };
}

function isNonFatalInterruptError(error: Error): boolean {
  const message = error.message;
  return /no active turn to interrupt/.test(message) || /expected active turn id/.test(message);
}
