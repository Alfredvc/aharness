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
  readonly onTurnCompleted: () => void | Promise<void>;
  readonly onTurnStarted?: (turnId: string | null) => void;
  readonly onItemStarted: (item: unknown, turnId: string | null) => void;
  readonly onItemCompleted: (item: unknown, turnId: string | null) => void;
  readonly onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
}

export interface NotificationRouterHandle {
  close(): void;
  /** True when threadId is not the parent. */
  isSubThread(threadId: string | undefined): boolean;
  /** Snapshot of cached sub-thread ids (for diagnostics + tests). */
  getKnownSubThreadIds(): ReadonlyArray<string>;
  /** Last turn/started.params.turn.id observed on the parent; cleared on turn/completed. */
  getCurrentTurnId(): string | null;
}

export function startNotificationRouter(o: NotificationRouterOpts): NotificationRouterHandle {
  const subThreadIds = new Set<string>();
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

  const cacheReceiverIdsFromItem = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    const i = item as { type?: unknown; receiverThreadIds?: unknown };
    if (i.type !== 'collabAgentToolCall' && i.type !== 'spawnAgentToolCall') return;
    const ids = Array.isArray(i.receiverThreadIds) ? i.receiverThreadIds : [];
    for (const id of ids) if (typeof id === 'string') subThreadIds.add(id);
  };

  const off1 = o.client.onNotification(METHOD.turnStarted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('turnStarted', params);
      return;
    }
    currentTurnId = readTurnId(params);
    o.onTurnStarted?.(currentTurnId);
  });
  const off2 = o.client.onNotification(METHOD.turnCompleted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('turnCompleted', params);
      return;
    }
    currentTurnId = null;
    void o.onTurnCompleted();
  });
  const off3 = o.client.onNotification(METHOD.itemStarted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('itemStarted', params);
      return;
    }
    const item = readItem(params);
    cacheReceiverIdsFromItem(item);
    o.onItemStarted(item, readItemTurnId(params));
  });
  const off4 = o.client.onNotification(METHOD.itemCompleted, (params) => {
    if (!isFromParent(params)) {
      reportAbandonedParent('itemCompleted', params);
      return;
    }
    const item = readItem(params);
    cacheReceiverIdsFromItem(item);
    o.onItemCompleted(item, readItemTurnId(params));
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
    getCurrentTurnId() {
      return currentTurnId;
    },
  };
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

function readItemTurnId(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null;
  const turnId = (params as { turnId?: unknown }).turnId;
  return typeof turnId === 'string' ? turnId : null;
}
