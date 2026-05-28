import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type {
  DynamicToolDef,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
} from '../protocol/types.js';

import type { ActiveThreadBinding } from './activeThreadBinding.js';

export interface PerformFreshClearOpts {
  readonly client: Pick<JsonRpcClient, 'request'>;
  readonly activeThreadBinding: ActiveThreadBinding;
  readonly oldTurnId?: string;
  readonly cwd: string;
  readonly dynamicTools: ReadonlyArray<DynamicToolDef>;
  readonly composeActiveStateNudge: () => string;
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

  const replacement = await opts.client.request<ThreadStartResponse>(METHOD.threadStart, {
    cwd: opts.cwd,
    dynamicTools: opts.dynamicTools,
    sessionStartSource: 'clear',
  } satisfies ThreadStartParams);

  opts.activeThreadBinding.set(replacement.thread.id);
  const orientationText = opts.composeActiveStateNudge();
  await opts.client.request<TurnStartResponse>(METHOD.turnStart, {
    threadId: replacement.thread.id,
    input: [{ type: 'text', text: orientationText }],
  } satisfies TurnStartParams);

  return {
    previousThreadId: oldThreadId,
    nextThreadId: replacement.thread.id,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNonFatalInterruptError(error: Error): boolean {
  const message = error.message;
  return /no active turn to interrupt/.test(message) || /expected active turn id/.test(message);
}
