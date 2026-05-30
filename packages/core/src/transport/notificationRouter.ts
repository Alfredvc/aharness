/**
 * Phase 1 notification router for the sole-WS-client topology.
 * Spec §5.1, §5.6, §5.7.
 *
 * Subscribed methods: turn/started, turn/completed, item/started, item/completed.
 *
 * Sub-thread classification (CF-16, M11):
 *   - Cache receiverThreadIds from every parent item/started or item/completed
 *     whose type ∈ {collabAgentToolCall, spawnAgentToolCall}.
 *   - For each inbound notification, look up params.threadId. Parent ⇒ forward.
 *     Non-parent ⇒ swallow (Phase 1 does not render sub-thread output).
 *   - M11 finding: ThreadStarted is not emitted for auto-attached sub-threads,
 *     so the cache may lag; classifying-unknowns-as-sub-thread is safe.
 */
import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type { ActiveThreadBinding } from '../runtime/activeThreadBinding.js';

export interface NotificationRouterOpts {
  readonly client: JsonRpcClient;
  readonly activeThreadBinding: ActiveThreadBinding;
  readonly onTurnCompleted: (params?: unknown) => void | Promise<void>;
  readonly onTurnCompletedError?: (error: Error) => void;
  readonly onTurnStarted?: (turnId: string | null, params?: unknown) => void;
  readonly onItemStarted: (item: unknown, turnId: string | null, params?: unknown) => void;
  readonly onItemCompleted: (item: unknown, turnId: string | null, params?: unknown) => void;
  readonly onSubThreadNotification?: (notification: SubThreadNotification) => void;
  readonly onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
}

export interface SubThreadCorrelation {
  readonly receiverThreadId: string;
  readonly parentThreadId: string;
  readonly parentTurnId?: string;
  readonly parentItemId?: string;
  readonly toolKind?: string;
  readonly toolName?: string;
}

export interface SubThreadNotification {
  readonly source: 'turnStarted' | 'turnCompleted' | 'itemStarted' | 'itemCompleted';
  readonly threadId: string;
  readonly turnId: string | null;
  readonly params: unknown;
  readonly item?: unknown;
  readonly correlation?: SubThreadCorrelation;
}

export interface NotificationRouterHandle {
  close(): void;
  /** True when threadId is not the parent. */
  isSubThread(threadId: string | undefined): boolean;
  /** Snapshot of cached sub-thread ids (for diagnostics + tests). */
  getKnownSubThreadIds(): ReadonlyArray<string>;
  getSubThreadCorrelation(threadId: string): SubThreadCorrelation | undefined;
  /** Last turn/started.params.turn.id observed on the parent; cleared on turn/completed. */
  getCurrentTurnId(): string | null;
}

export function startNotificationRouter(o: NotificationRouterOpts): NotificationRouterHandle {
  const subThreadIds = new Set<string>();
  const subThreadCorrelations = new Map<string, SubThreadCorrelation>();
  let currentTurnId: string | null = null;

  const isFromParent = (params: unknown): boolean => {
    const threadId = readThreadId(params);
    return (
      threadId !== undefined &&
      threadId === o.activeThreadBinding.require() &&
      !o.activeThreadBinding.isAbandoned(threadId)
    );
  };

  const reportAbandonedParent = (source: string, params: unknown): void => {
    const threadId = readThreadId(params);
    if (threadId === undefined || !o.activeThreadBinding.isAbandoned(threadId)) return;
    o.onAbandonedThreadDiagnostic?.({
      threadId,
      source,
      message: `${source} notification ignored for abandoned thread`,
    });
  };

  const emitSubThreadNotification = (
    source: SubThreadNotification['source'],
    params: unknown,
    item?: unknown,
  ): void => {
    const threadId = readThreadId(params);
    if (threadId === undefined) return;
    const correlation = subThreadCorrelations.get(threadId);
    o.onSubThreadNotification?.({
      source,
      threadId,
      turnId:
        source === 'turnStarted' || source === 'turnCompleted'
          ? readTurnId(params)
          : readItemTurnId(params),
      params,
      ...(item !== undefined ? { item } : {}),
      ...(correlation !== undefined ? { correlation } : {}),
    });
  };

  const cacheReceiverIdsFromItem = (params: unknown, item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    const i = item as { type?: unknown; receiverThreadIds?: unknown };
    if (i.type !== 'collabAgentToolCall' && i.type !== 'spawnAgentToolCall') return;
    const ids = Array.isArray(i.receiverThreadIds) ? i.receiverThreadIds : [];
    const parentThreadId = readThreadId(params);
    const parentTurnId = readItemTurnId(params) ?? undefined;
    const parentItemId = readItemId(item);
    const toolName = readToolName(item);
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      subThreadIds.add(id);
      if (parentThreadId !== undefined) {
        subThreadCorrelations.set(id, {
          receiverThreadId: id,
          parentThreadId,
          ...(parentTurnId !== undefined ? { parentTurnId } : {}),
          ...(parentItemId !== undefined ? { parentItemId } : {}),
          ...(typeof i.type === 'string' ? { toolKind: i.type } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
        });
      }
    }
  };

  const off1 = o.client.onNotification(METHOD.turnStarted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('turnStarted', params);
      if (!isAbandonedParentParams(o.activeThreadBinding, params)) {
        emitSubThreadNotification('turnStarted', params);
      }
      return;
    }
    currentTurnId = readTurnId(params);
    o.onTurnStarted?.(currentTurnId, params);
  });
  const off2 = o.client.onNotification(METHOD.turnCompleted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('turnCompleted', params);
      if (!isAbandonedParentParams(o.activeThreadBinding, params)) {
        emitSubThreadNotification('turnCompleted', params);
      }
      return;
    }
    currentTurnId = null;
    void Promise.resolve(o.onTurnCompleted(params)).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      if (o.onTurnCompletedError !== undefined) {
        o.onTurnCompletedError(err);
        return;
      }
      process.stderr.write(`[notificationRouter] turn/completed handler failed: ${err.message}\n`);
    });
  });
  const off3 = o.client.onNotification(METHOD.itemStarted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('itemStarted', params);
      if (!isAbandonedParentParams(o.activeThreadBinding, params)) {
        emitSubThreadNotification('itemStarted', params, readItem(params));
      }
      return;
    }
    const item = readItem(params);
    cacheReceiverIdsFromItem(params, item);
    o.onItemStarted(item, readItemTurnId(params), params);
  });
  const off4 = o.client.onNotification(METHOD.itemCompleted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('itemCompleted', params);
      if (!isAbandonedParentParams(o.activeThreadBinding, params)) {
        emitSubThreadNotification('itemCompleted', params, readItem(params));
      }
      return;
    }
    const item = readItem(params);
    cacheReceiverIdsFromItem(params, item);
    o.onItemCompleted(item, readItemTurnId(params), params);
  });

  return {
    close() {
      off1();
      off2();
      off3();
      off4();
    },
    isSubThread(threadId) {
      if (threadId === undefined) return false;
      return (
        threadId !== o.activeThreadBinding.require() || o.activeThreadBinding.isAbandoned(threadId)
      );
    },
    getKnownSubThreadIds() {
      return [...subThreadIds];
    },
    getSubThreadCorrelation(threadId) {
      return subThreadCorrelations.get(threadId);
    },
    getCurrentTurnId() {
      return currentTurnId;
    },
  };
}

function isAbandonedParentParams(binding: ActiveThreadBinding, params: unknown): boolean {
  const threadId = readThreadId(params);
  return threadId !== undefined && binding.isAbandoned(threadId);
}

function readThreadId(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const tid = (params as { threadId?: unknown }).threadId;
  return typeof tid === 'string' ? tid : undefined;
}

function readTurnId(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null;
  const turn = (params as { turn?: unknown }).turn;
  if (turn === null || typeof turn !== 'object') return null;
  const id = (turn as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function readItem(params: unknown): unknown {
  if (params === null || typeof params !== 'object') return null;
  return (params as { item?: unknown }).item ?? null;
}

function readItemId(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  const id = (item as { id?: unknown; callId?: unknown; call_id?: unknown }).id;
  if (typeof id === 'string') return id;
  const callId = (item as { callId?: unknown; call_id?: unknown }).callId;
  if (typeof callId === 'string') return callId;
  const snakeCallId = (item as { call_id?: unknown }).call_id;
  return typeof snakeCallId === 'string' ? snakeCallId : undefined;
}

function readToolName(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  const record = item as { name?: unknown; toolName?: unknown; tool?: unknown; type?: unknown };
  if (typeof record.name === 'string') return record.name;
  if (typeof record.toolName === 'string') return record.toolName;
  if (typeof record.tool === 'string') return record.tool;
  return typeof record.type === 'string' ? record.type : undefined;
}

function readItemTurnId(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null;
  const turnId = (params as { turnId?: unknown }).turnId;
  return typeof turnId === 'string' ? turnId : null;
}
