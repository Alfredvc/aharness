import type {
  FileChangePatchUpdatedNotification,
  FileUpdateChange,
  ThreadItem,
} from '../protocol/index.js';

export interface PendingFileApprovalKey {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

export interface FileApprovalChangesUpdate extends PendingFileApprovalKey {
  readonly changes: ReadonlyArray<FileUpdateChange>;
}

export interface FileChangeTrackerOptions {
  readonly onPendingFileApprovalChanges?: (update: FileApprovalChangesUpdate) => void;
  readonly isActiveThread?: (threadId: string) => boolean;
  readonly onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
}

export interface FileChangeTracker {
  noteFileApprovalPending(key: PendingFileApprovalKey): ReadonlyArray<FileUpdateChange>;
  noteFileApprovalResolved(requestId: string): void;
  noteThreadItem(params: { threadId: string; turnId: string; item: unknown }): void;
  notePatchUpdated(params: unknown): void;
  lookup(threadId: string, turnId: string, itemId: string): ReadonlyArray<FileUpdateChange>;
}

type ChangeKey = `${string}\u0000${string}\u0000${string}`;

function makeKey(threadId: string, turnId: string, itemId: string): ChangeKey {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

function cloneChanges(changes: ReadonlyArray<FileUpdateChange>): ReadonlyArray<FileUpdateChange> {
  return changes.map((change) => ({
    path: change.path,
    kind: { ...change.kind },
    diff: change.diff,
  }));
}

function isFileUpdateChange(value: unknown): value is FileUpdateChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const kind = v['kind'];
  return (
    typeof v['path'] === 'string' &&
    typeof v['diff'] === 'string' &&
    typeof kind === 'object' &&
    kind !== null &&
    !Array.isArray(kind) &&
    typeof (kind as Record<string, unknown>)['type'] === 'string'
  );
}

function normalizeChanges(value: unknown): ReadonlyArray<FileUpdateChange> | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isFileUpdateChange)) return null;
  return cloneChanges(value);
}

function isFileChangeThreadItem(item: unknown): item is ThreadItem & {
  type: 'fileChange';
  id: string;
  changes: ReadonlyArray<FileUpdateChange>;
} {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const i = item as Record<string, unknown>;
  return (
    i['type'] === 'fileChange' &&
    typeof i['id'] === 'string' &&
    normalizeChanges(i['changes']) !== null
  );
}

function normalizePatchUpdated(
  params: unknown,
): FileChangePatchUpdatedNotification['params'] | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  const changes = normalizeChanges(p['changes']);
  if (
    typeof p['threadId'] !== 'string' ||
    typeof p['turnId'] !== 'string' ||
    typeof p['itemId'] !== 'string' ||
    changes === null
  ) {
    return null;
  }
  return {
    threadId: p['threadId'],
    turnId: p['turnId'],
    itemId: p['itemId'],
    changes,
  };
}

export function createFileChangeTracker(options: FileChangeTrackerOptions = {}): FileChangeTracker {
  const changesByKey = new Map<ChangeKey, ReadonlyArray<FileUpdateChange>>();
  const pendingByRequestId = new Map<string, PendingFileApprovalKey>();

  function isActiveThread(threadId: string): boolean {
    return options.isActiveThread?.(threadId) ?? true;
  }

  function reportAbandonedThread(threadId: string, source: string, message: string): void {
    options.onAbandonedThreadDiagnostic?.({ threadId, source, message });
  }

  function updateChanges(
    threadId: string,
    turnId: string,
    itemId: string,
    changes: ReadonlyArray<FileUpdateChange>,
  ): void {
    const cloned = cloneChanges(changes);
    const key = makeKey(threadId, turnId, itemId);
    changesByKey.set(key, cloned);

    for (const pending of pendingByRequestId.values()) {
      if (pending.threadId !== threadId || pending.turnId !== turnId || pending.itemId !== itemId) {
        continue;
      }
      options.onPendingFileApprovalChanges?.({
        ...pending,
        changes: cloneChanges(cloned),
      });
    }
  }

  return {
    noteFileApprovalPending(key) {
      pendingByRequestId.set(key.requestId, key);
      return this.lookup(key.threadId, key.turnId, key.itemId);
    },
    noteFileApprovalResolved(requestId) {
      pendingByRequestId.delete(requestId);
    },
    noteThreadItem(params) {
      if (!isActiveThread(params.threadId)) {
        reportAbandonedThread(
          params.threadId,
          'fileChangeThreadItem',
          'file-change thread item ignored for abandoned thread',
        );
        return;
      }
      if (!isFileChangeThreadItem(params.item)) return;
      const changes = normalizeChanges(params.item.changes);
      if (changes === null) return;
      updateChanges(params.threadId, params.turnId, params.item.id, changes);
    },
    notePatchUpdated(params) {
      const normalized = normalizePatchUpdated(params);
      if (normalized === null) return;
      if (!isActiveThread(normalized.threadId)) {
        reportAbandonedThread(
          normalized.threadId,
          'fileChangePatchUpdated',
          'file-change patch update ignored for abandoned thread',
        );
        return;
      }
      updateChanges(normalized.threadId, normalized.turnId, normalized.itemId, normalized.changes);
    },
    lookup(threadId, turnId, itemId) {
      const changes = changesByKey.get(makeKey(threadId, turnId, itemId));
      return changes ? cloneChanges(changes) : [];
    },
  };
}
