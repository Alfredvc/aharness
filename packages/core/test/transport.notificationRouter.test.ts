/**
 * Phase 1 notification-router tests (`transport/notificationRouter.ts`).
 *
 * The Phase 1 router is the sole-WS-client equivalent of the daemon
 * router: it filters notifications to the parent thread and surfaces a
 * sub-thread classifier backed by `receiverThreadIds` cached off the
 * `collabAgentToolCall` / `spawnAgentToolCall` items the parent sees
 * fan out to its children.
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-1a-transport-backbone.md` Task 7.
 */
import { describe, it, expect, vi } from 'vitest';

import { startNotificationRouter } from '../src/runtime.js';
import type { JsonRpcClient } from '../src/jsonrpc/client.js';
import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';

function makeStubClient() {
  const handlers = new Map<string, (params: unknown) => void>();
  return {
    onNotification: (m: string, h: (p: unknown) => void) => {
      handlers.set(m, h);
      return () => handlers.delete(m);
    },
    fire: (m: string, p: unknown) => handlers.get(m)?.(p),
  };
}

describe('notification router (Phase 1)', () => {
  it('caches receiverThreadIds and classifies inbound threadId as sub-thread', () => {
    const c = makeStubClient();
    const activeThreadBinding = createActiveThreadBinding('parent-1');
    const router = startNotificationRouter({
      client: c as unknown as JsonRpcClient,
      activeThreadBinding,
      onTurnCompleted: () => {},
      onItemStarted: () => {},
      onItemCompleted: () => {},
    });
    c.fire('item/completed', {
      threadId: 'parent-1',
      item: { type: 'collabAgentToolCall', receiverThreadIds: ['child-A'] },
    });
    expect(router.isSubThread('child-A')).toBe(true);
    expect(router.getSubThreadCorrelation('child-A')).toEqual(
      expect.objectContaining({
        receiverThreadId: 'child-A',
        parentThreadId: 'parent-1',
        toolKind: 'collabAgentToolCall',
      }),
    );
    expect(router.isSubThread('parent-1')).toBe(false);
    expect(router.isSubThread('unknown')).toBe(true); // M11: any non-parent is sub-thread
    router.close();
  });

  it('forwards turn/completed only for the parent thread', () => {
    const c = makeStubClient();
    const onTurnCompleted = vi.fn();
    const activeThreadBinding = createActiveThreadBinding('parent-1');
    startNotificationRouter({
      client: c as unknown as JsonRpcClient,
      activeThreadBinding,
      onTurnCompleted,
      onItemStarted: () => {},
      onItemCompleted: () => {},
    });
    c.fire('turn/completed', { threadId: 'parent-1' });
    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    c.fire('turn/completed', { threadId: 'child-A' });
    expect(onTurnCompleted).toHaveBeenCalledTimes(1); // sub-thread ignored
  });

  it('reports received sub-thread notifications without forwarding them to parent callbacks', () => {
    const c = makeStubClient();
    const activeThreadBinding = createActiveThreadBinding('parent-1');
    const onItemStarted = vi.fn();
    const subThreadNotifications: unknown[] = [];
    startNotificationRouter({
      client: c as unknown as JsonRpcClient,
      activeThreadBinding,
      onTurnCompleted: () => {},
      onItemStarted,
      onItemCompleted: () => {},
      onSubThreadNotification: (notification) => subThreadNotifications.push(notification),
    });

    c.fire('item/started', {
      threadId: 'parent-1',
      turnId: 'turn-parent',
      item: {
        type: 'spawnAgentToolCall',
        id: 'spawn-1',
        receiverThreadIds: ['child-1'],
      },
    });
    c.fire('item/started', {
      threadId: 'child-1',
      turnId: 'turn-child',
      item: { type: 'agentMessage', id: 'child-message' },
    });
    c.fire('turn/completed', { threadId: 'unknown-child', turn: { id: 'turn-unknown' } });

    expect(onItemStarted).toHaveBeenCalledTimes(1);
    expect(subThreadNotifications).toEqual([
      expect.objectContaining({
        source: 'itemStarted',
        threadId: 'child-1',
        turnId: 'turn-child',
        correlation: expect.objectContaining({
          parentThreadId: 'parent-1',
          parentTurnId: 'turn-parent',
          parentItemId: 'spawn-1',
        }),
      }),
      expect.objectContaining({
        source: 'turnCompleted',
        threadId: 'unknown-child',
        turnId: 'turn-unknown',
      }),
    ]);
  });

  it('uses the current binding after construction', () => {
    const c = makeStubClient();
    const activeThreadBinding = createActiveThreadBinding('parent-1');
    const onTurnCompleted = vi.fn();
    const router = startNotificationRouter({
      client: c as unknown as JsonRpcClient,
      activeThreadBinding,
      onTurnCompleted,
      onItemStarted: () => {},
      onItemCompleted: () => {},
    });

    activeThreadBinding.set('parent-2');
    c.fire('turn/completed', { threadId: 'parent-1' });
    c.fire('turn/completed', { threadId: 'parent-2' });

    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(router.isSubThread('parent-1')).toBe(true);
    expect(router.isSubThread('parent-2')).toBe(false);
  });

  it('reports identifiable notifications from abandoned parent threads without forwarding them', () => {
    const c = makeStubClient();
    const activeThreadBinding = createActiveThreadBinding('parent-1');
    const onItemCompleted = vi.fn();
    const diagnostics: Array<{ threadId: string; source: string; message: string }> = [];
    startNotificationRouter({
      client: c as unknown as JsonRpcClient,
      activeThreadBinding,
      onTurnCompleted: () => {},
      onItemStarted: () => {},
      onItemCompleted,
      onAbandonedThreadDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    activeThreadBinding.set('parent-2');
    c.fire('item/completed', {
      threadId: 'parent-1',
      turnId: 'turn-old',
      item: { type: 'fileChange', id: 'patch-old', changes: [] },
    });

    expect(onItemCompleted).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      expect.objectContaining({ threadId: 'parent-1', source: 'itemCompleted' }),
    ]);
  });

  it('treats the current thread as abandoned immediately after it is marked', () => {
    const c = makeStubClient();
    const activeThreadBinding = createActiveThreadBinding('parent-1');
    const onTurnCompleted = vi.fn();
    const diagnostics: Array<{ threadId: string; source: string; message: string }> = [];
    const router = startNotificationRouter({
      client: c as unknown as JsonRpcClient,
      activeThreadBinding,
      onTurnCompleted,
      onItemStarted: () => {},
      onItemCompleted: () => {},
      onAbandonedThreadDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    activeThreadBinding.markAbandoned('parent-1');
    c.fire('turn/completed', { threadId: 'parent-1' });

    expect(onTurnCompleted).not.toHaveBeenCalled();
    expect(router.isSubThread('parent-1')).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({ threadId: 'parent-1', source: 'turnCompleted' }),
    ]);
  });
});
