import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type {
  CodexReasoningEffort,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
} from '../protocol/types.js';

import type { ActiveThreadBinding } from './activeThreadBinding.js';

export interface StateModelSettingsApplyRequest {
  readonly stateId: string;
  readonly model?: string;
  readonly effort?: CodexReasoningEffort;
}

export interface StateModelSettings {
  /**
   * Register a settings update in the shared gate immediately, but leave
   * the outbound request dormant until `apply()` is called. This lets
   * transition code make later `turn/start` producers wait without
   * reordering the JSON-RPC settings request ahead of an in-flight
   * server-request reply.
   */
  prepareApplyForActiveState(opts: StateModelSettingsApplyRequest): PreparedStateModelSettingsApply;
  /**
   * Queue a settings update for the active thread. Each call is serialized,
   * and `waitForSettled()` awaits all queued updates in order.
   */
  queueApplyForActiveState(opts: StateModelSettingsApplyRequest): Promise<void>;
  /**
   * Await until the latest queued settings update is fully acknowledged, or
   * reject if an update failed.
   */
  waitForSettled(): Promise<void>;
}

export interface PreparedStateModelSettingsApply {
  readonly promise: Promise<void>;
  apply(): Promise<void>;
}

export interface CreateStateModelSettingsOpts {
  readonly client: Pick<JsonRpcClient, 'request'>;
  readonly activeThreadBinding: ActiveThreadBinding;
  readonly onFatal?: (error: Error) => void;
}

export function createStateModelSettings(opts: CreateStateModelSettingsOpts): StateModelSettings {
  let chain: Promise<void> = Promise.resolve();
  let failed: Error | undefined;

  const markFailed = (error: unknown): Error => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (failed === undefined) {
      failed = normalized;
      opts.onFatal?.(failed);
    }
    return failed;
  };

  const guard = (): void => {
    if (failed !== undefined) {
      throw failed;
    }
  };

  const prepareApplyForActiveState = (
    req: StateModelSettingsApplyRequest,
  ): PreparedStateModelSettingsApply => {
    if (req.model === undefined && req.effort === undefined) {
      return {
        promise: chain,
        apply: async () => {
          await chain;
        },
      };
    }

    const request: ThreadSettingsUpdateParams = {
      threadId: opts.activeThreadBinding.require(),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.effort !== undefined ? { effort: req.effort } : {}),
    };

    let resolveGate!: () => void;
    let rejectGate!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    const prior = chain;
    const step = prior
      .then(() => {
        return guard();
      })
      .then(() => {
        return gate;
      });

    chain = step.catch((error) => {
      throw markFailed(error);
    });

    let applyPromise: Promise<void> | undefined;
    const apply = async (): Promise<void> => {
      applyPromise ??= (async () => {
        try {
          await prior;
          guard();
          await opts.client.request<ThreadSettingsUpdateResponse>(
            METHOD.threadSettingsUpdate,
            request,
          );
          resolveGate();
        } catch (error) {
          rejectGate(markFailed(error));
        }
        await chain;
      })();
      await applyPromise;
    };

    return { promise: chain, apply };
  };

  const queueApplyForActiveState = async (req: StateModelSettingsApplyRequest): Promise<void> => {
    const pending = prepareApplyForActiveState(req);
    await pending.apply();
  };

  const waitForSettled = async (): Promise<void> => {
    if (failed !== undefined) return Promise.reject(failed);
    await chain;
  };

  return {
    prepareApplyForActiveState,
    queueApplyForActiveState,
    waitForSettled,
  };
}
