import { describe, expect, it, vi } from 'vitest';

import {
  createFileChangeTracker,
  type FileApprovalChangesUpdate,
} from '../src/transport/fileChangeTracker.js';
import type { FileUpdateChange } from '../src/protocol/index.js';

const addChange: FileUpdateChange = {
  path: 'src/new.ts',
  kind: { type: 'add' },
  diff: '+hello\n',
};

const updateChange: FileUpdateChange = {
  path: 'src/existing.ts',
  kind: { type: 'update', move_path: null },
  diff: '@@ changed\n',
};

describe('createFileChangeTracker', () => {
  it('returns cached changes when they arrive before a pending approval', () => {
    const tracker = createFileChangeTracker();

    tracker.noteThreadItem({
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'fileChange',
        id: 'patch-1',
        changes: [addChange],
        status: 'inProgress',
      },
    });

    expect(
      tracker.noteFileApprovalPending({
        requestId: 'patch-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
      }),
    ).toEqual([addChange]);
  });

  it('allows approval before changes and publishes a refresh when changes arrive later', () => {
    const updates: FileApprovalChangesUpdate[] = [];
    const tracker = createFileChangeTracker({
      onPendingFileApprovalChanges: (update) => updates.push(update),
    });

    expect(
      tracker.noteFileApprovalPending({
        requestId: 'patch-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
      }),
    ).toEqual([]);

    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [updateChange],
    });

    expect(updates).toEqual([
      {
        requestId: 'patch-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        changes: [updateChange],
      },
    ]);
  });

  it('replaces changes with the latest patchUpdated snapshot', () => {
    const tracker = createFileChangeTracker();

    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [addChange],
    });
    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [updateChange],
    });

    expect(tracker.lookup('thread-1', 'turn-1', 'patch-1')).toEqual([updateChange]);
  });

  it('ignores malformed and unrelated notifications without throwing', () => {
    const onPendingFileApprovalChanges = vi.fn();
    const tracker = createFileChangeTracker({ onPendingFileApprovalChanges });

    expect(() => {
      tracker.noteThreadItem({
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-1' },
      });
      tracker.noteThreadItem({
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'fileChange', id: 'patch-1', changes: [{ path: 1 }] },
      });
      tracker.notePatchUpdated({
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        changes: [{ path: 'x', diff: 'missing kind' }],
      });
      tracker.notePatchUpdated(null);
    }).not.toThrow();

    expect(tracker.lookup('thread-1', 'turn-1', 'patch-1')).toEqual([]);
    expect(onPendingFileApprovalChanges).not.toHaveBeenCalled();
  });

  it('ignores thread item and patch updates for inactive threads', () => {
    let activeThreadId = 'thread-1';
    const updates: FileApprovalChangesUpdate[] = [];
    const diagnostics: Array<{ threadId: string; source: string; message: string }> = [];
    const tracker = createFileChangeTracker({
      isActiveThread: (threadId) => threadId === activeThreadId,
      onPendingFileApprovalChanges: (update) => updates.push(update),
      onAbandonedThreadDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    tracker.noteFileApprovalPending({
      requestId: 'patch-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });

    activeThreadId = 'thread-2';
    tracker.noteThreadItem({
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'fileChange',
        id: 'patch-1',
        changes: [addChange],
        status: 'inProgress',
      },
    });
    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [updateChange],
    });

    expect(tracker.lookup('thread-1', 'turn-1', 'patch-1')).toEqual([]);
    expect(updates).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ threadId: 'thread-1', source: 'fileChangeThreadItem' }),
      expect.objectContaining({ threadId: 'thread-1', source: 'fileChangePatchUpdated' }),
    ]);
  });

  it('accepts active-thread updates when configured with an active predicate', () => {
    const updates: FileApprovalChangesUpdate[] = [];
    const tracker = createFileChangeTracker({
      isActiveThread: (threadId) => threadId === 'thread-1',
      onPendingFileApprovalChanges: (update) => updates.push(update),
    });

    tracker.noteFileApprovalPending({
      requestId: 'patch-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });
    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [updateChange],
    });

    expect(tracker.lookup('thread-1', 'turn-1', 'patch-1')).toEqual([updateChange]);
    expect(updates).toEqual([
      {
        requestId: 'patch-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        changes: [updateChange],
      },
    ]);
  });

  it('returns defensive copies and stops updates after resolve', () => {
    const updates: FileApprovalChangesUpdate[] = [];
    const tracker = createFileChangeTracker({
      onPendingFileApprovalChanges: (update) => updates.push(update),
    });

    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [addChange],
    });

    const first = tracker.lookup('thread-1', 'turn-1', 'patch-1') as FileUpdateChange[];
    first[0]!.path = 'mutated.ts';

    expect(tracker.lookup('thread-1', 'turn-1', 'patch-1')).toEqual([addChange]);

    tracker.noteFileApprovalPending({
      requestId: 'patch-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });
    tracker.noteFileApprovalResolved('patch-1');
    tracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [updateChange],
    });

    expect(updates).toEqual([]);
  });
});
