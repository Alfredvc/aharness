import { describe, expect, it, vi } from 'vitest';

import { createFsm } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import { createPermissionRequestDispatcher } from '../src/runtime/permissionRequest.js';
import type { AharnessStateMeta } from '../src/state/exits.js';
import type { PermissionRequestEvent } from '../src/state/hooks.js';

const baseEvent: PermissionRequestEvent = {
  kind: 'command',
  toolName: 'Bash',
  matcherAliases: [],
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'cmd-1',
  requestId: 'command:1',
  command: 'pnpm test',
  cwd: '/repo',
};

function hostWithMeta(meta: AharnessStateMeta | undefined, context: Record<string, unknown> = {}) {
  return {
    currentMeta: () => meta,
    currentContext: () => context,
    currentStateId: () => 'work',
  } as unknown as ActorHost;
}

function buildCanonicalPermissionHost(
  on: Parameters<ReturnType<typeof createFsm<{ count: number }>>['state']>[0]['on'],
): ActorHost {
  const fsm = createFsm<{ count: number }>();
  const machine = fsm.machine({
    id: 'm',
    initial: 'work',
    data: { count: 0 },
    states: {
      work: fsm.state({
        prompt: 'p',
        on,
      }),
      done: fsm.final({ outcome: 'success' }),
    },
  });
  const host = new ActorHost(machine, undefined);
  host.start();
  return host;
}

describe('createPermissionRequestDispatcher', () => {
  it('delegates when the active state has no permissionRequest hooks', async () => {
    const dispatch = createPermissionRequestDispatcher({ host: hostWithMeta(undefined) });
    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'delegate' });
  });

  it('matches command approvals against Bash and invokes every matching handler', async () => {
    const first = vi.fn(() => 'accept' as const);
    const second = vi.fn(() => 'acceptForSession' as const);
    const dispatch = createPermissionRequestDispatcher({
      host: hostWithMeta({
        kind: 'stateful',
        open: false,
        entryPrompt: 'p',
        exits: {},
        hooks: {
          permissionRequest: [
            { matcher: '^Bash$', handler: first },
            { matcher: 'Bash', handler: second },
          ],
        },
      }),
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'acceptForSession' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('matches file approvals against apply_patch and matcher aliases Write/Edit', async () => {
    const byTool = vi.fn(() => 'delegate' as const);
    const byAlias = vi.fn(() => 'decline' as const);
    const dispatch = createPermissionRequestDispatcher({
      host: hostWithMeta({
        kind: 'stateful',
        open: false,
        entryPrompt: 'p',
        exits: {},
        hooks: {
          permissionRequest: [
            { matcher: '^apply_patch$', handler: byTool },
            { matcher: '^Write$', handler: byAlias },
          ],
        },
      }),
    });

    await expect(
      dispatch({
        ...baseEvent,
        kind: 'file',
        toolName: 'apply_patch',
        matcherAliases: ['Write', 'Edit'],
        itemId: 'patch-1',
        command: undefined,
        cwd: undefined,
      }),
    ).resolves.toEqual({ decision: 'decline' });
    expect(byTool).toHaveBeenCalledTimes(1);
    expect(byAlias).toHaveBeenCalledTimes(1);
  });

  it('applies cancel, decline, acceptForSession, accept, delegate precedence after all async handlers settle', async () => {
    const calls: string[] = [];
    const dispatch = createPermissionRequestDispatcher({
      host: hostWithMeta({
        kind: 'stateful',
        open: false,
        entryPrompt: 'p',
        exits: {},
        hooks: {
          permissionRequest: [
            {
              matcher: 'Bash',
              handler: async () => {
                calls.push('accept');
                return 'accept';
              },
            },
            {
              matcher: 'Bash',
              handler: async () => {
                calls.push('cancel');
                return 'cancel';
              },
            },
          ],
        },
      }),
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'cancel' });
    expect(calls).toEqual(['accept', 'cancel']);
  });

  it('fails closed and reports a tagged diagnostic when an author handler throws', async () => {
    const onAuthorHandlerError = vi.fn();
    const dispatch = createPermissionRequestDispatcher({
      host: hostWithMeta({
        kind: 'stateful',
        open: false,
        entryPrompt: 'p',
        exits: {},
        hooks: {
          permissionRequest: [
            {
              matcher: 'Bash',
              handler: () => {
                throw new Error('policy exploded');
              },
            },
          ],
        },
      }),
      onAuthorHandlerError,
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'cancel' });
    expect(onAuthorHandlerError).toHaveBeenCalledWith(
      expect.objectContaining({
        stateId: 'work',
        hookKind: 'PermissionRequest',
        matcher: 'Bash',
        error: expect.any(Error),
      }),
    );
  });

  it('dispatches permissionRequest through a canonical transition and returns after snapshot flush', async () => {
    const events: string[] = [];
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Bash$',
        reduce: (draft) => {
          draft.count += 1;
          events.push(`reduce:${draft.count}`);
        },
        return: (data, event) => {
          events.push(`return:${data.count}:${event.toolName}`);
          return data.count === 1 ? 'acceptForSession' : 'delegate';
        },
      },
    });
    const flushSnapshot = vi.fn(() => {
      events.push(`flush:${host.currentContext().count}`);
    });
    const dispatch = createPermissionRequestDispatcher({ host, flushSnapshot });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'acceptForSession' });
    expect(events).toEqual(['reduce:1', 'flush:1', 'return:1:Bash']);
  });

  it('reports committed canonical permissionRequest transitions after snapshot flush', async () => {
    const events: string[] = [];
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Bash$',
        to: 'done',
        return: () => 'accept',
      },
    });
    const dispatch = createPermissionRequestDispatcher({
      host,
      flushSnapshot: () => {
        events.push(`flush:${host.currentStateId()}`);
      },
      onCommittedTransition: (info) => {
        events.push(`committed:${info.from}->${info.to}`);
      },
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'accept' });

    expect(events).toEqual(['flush:done', 'committed:work->done']);
  });

  it('runs terminal artifact and completion callbacks for canonical permissionRequest transitions to finals', async () => {
    const order: string[] = [];
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Bash$',
        to: 'done',
        reduce: (draft) => {
          draft.count = 7;
        },
        return: () => 'accept',
      },
    });
    const flushSnapshot = vi.fn(() => {
      order.push(`flush:${host.currentStateId()}:${host.currentContext().count}`);
    });
    const writeFinalArtifacts = vi.fn(async (terminalStateId: string, context) => {
      order.push(`artifacts:${terminalStateId}:${(context as { count: number }).count}`);
    });
    const onTerminal = vi.fn((terminalStateId: string) => {
      order.push(`terminal:${terminalStateId}`);
    });
    const dispatch = createPermissionRequestDispatcher({
      host,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'accept' });
    expect(host.currentStateId()).toBe('done');
    expect(writeFinalArtifacts).toHaveBeenCalledWith('done', expect.objectContaining({ count: 7 }));
    expect(onTerminal).toHaveBeenCalledWith('done');
    expect(order).toEqual(['artifacts:done:7', 'flush:done:7', 'terminal:done']);
  });

  it('reports canonical permissionRequest final artifact failures and delegates before commit', async () => {
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Bash$',
        to: 'done',
        reduce: (draft) => {
          draft.count = 7;
        },
        return: () => 'accept',
      },
    });
    const flushSnapshot = vi.fn();
    const onTerminal = vi.fn();
    const onCanonicalEventError = vi.fn();
    const writeFinalArtifacts = vi.fn(async () => {
      throw new Error('disk full');
    });
    const dispatch = createPermissionRequestDispatcher({
      host,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
      onCanonicalEventError,
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'delegate' });
    expect(writeFinalArtifacts).toHaveBeenCalledWith('done', expect.objectContaining({ count: 7 }));
    expect(onCanonicalEventError).toHaveBeenCalledWith({
      eventName: 'permissionRequest',
      stateId: 'work',
      branchIndex: 0,
      phase: 'transition',
      error: expect.objectContaining({ message: 'disk full' }),
    });
    expect(host.currentStateId()).toBe('work');
    expect(host.currentContext().count).toBe(0);
    expect(flushSnapshot).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('matches canonical permissionRequest filters against matcher aliases', async () => {
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Write$',
        return: () => 'decline',
      },
    });
    const dispatch = createPermissionRequestDispatcher({ host, flushSnapshot: vi.fn() });

    await expect(
      dispatch({
        ...baseEvent,
        kind: 'file',
        toolName: 'apply_patch',
        matcherAliases: ['Write', 'Edit'],
        itemId: 'patch-1',
        command: undefined,
        cwd: undefined,
      }),
    ).resolves.toEqual({ decision: 'decline' });
  });

  it('uses the selected canonical route branch as the permission response owner', async () => {
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '.*',
        route: [
          {
            if: (_data, event) => event.kind === 'file',
            return: () => 'decline',
          },
          {
            return: () => 'accept',
          },
        ],
      },
    });
    const dispatch = createPermissionRequestDispatcher({ host, flushSnapshot: vi.fn() });

    await expect(
      dispatch({
        ...baseEvent,
        kind: 'file',
        toolName: 'apply_patch',
        matcherAliases: ['Write', 'Edit'],
        itemId: 'patch-1',
        command: undefined,
        cwd: undefined,
      }),
    ).resolves.toEqual({ decision: 'decline' });
  });

  it('falls back to legacy permissionRequest aggregation when no canonical handler is selected', async () => {
    const legacy = vi.fn(() => 'accept' as const);
    const fsm = createFsm<{ count: number }>();
    const canonicalState = fsm.state({
      prompt: 'p',
      on: {
        permissionRequest: {
          match: '^Edit$',
          return: () => 'decline',
        },
      },
    });
    const machine = fsm.machine({
      id: 'm',
      initial: 'work',
      data: { count: 0 },
      states: {
        work: {
          ...canonicalState,
          meta: {
            aharness: {
              ...canonicalState.meta.aharness,
              hooks: { permissionRequest: [{ matcher: '^Bash$', handler: legacy }] },
            },
          },
        },
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createPermissionRequestDispatcher({ host, flushSnapshot: vi.fn() });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'accept' });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('delegates when no canonical or legacy permissionRequest handler is selected', async () => {
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Edit$',
        return: () => 'decline',
      },
    });
    const dispatch = createPermissionRequestDispatcher({ host, flushSnapshot: vi.fn() });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'delegate' });
  });

  it('does not fall back to legacy permissionRequest aggregation after canonical selection', async () => {
    const legacy = vi.fn(() => 'accept' as const);
    const fsm = createFsm<{ count: number }>();
    const canonicalState = fsm.state({
      prompt: 'p',
      on: {
        permissionRequest: {
          match: '^Bash$',
          reduce: () => {
            throw new Error('canonical failed');
          },
          return: () => 'decline',
        },
      },
    });
    const machine = fsm.machine({
      id: 'm',
      initial: 'work',
      data: { count: 0 },
      states: {
        work: {
          ...canonicalState,
          meta: {
            aharness: {
              ...canonicalState.meta.aharness,
              hooks: { permissionRequest: [{ matcher: '^Bash$', handler: legacy }] },
            },
          },
        },
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createPermissionRequestDispatcher({ host, flushSnapshot: vi.fn() });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'delegate' });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('reports selected canonical permissionRequest transition failures', async () => {
    const onCanonicalEventError = vi.fn();
    const host = buildCanonicalPermissionHost({
      permissionRequest: {
        match: '^Bash$',
        reduce: () => {
          throw new Error('canonical failed');
        },
        return: () => 'decline',
      },
    });
    const dispatch = createPermissionRequestDispatcher({
      host,
      flushSnapshot: vi.fn(),
      onCanonicalEventError,
    });

    await expect(dispatch(baseEvent)).resolves.toEqual({ decision: 'delegate' });
    expect(onCanonicalEventError).toHaveBeenCalledWith({
      eventName: 'permissionRequest',
      stateId: 'work',
      branchIndex: 0,
      phase: 'transition',
      error: expect.objectContaining({ message: 'canonical failed' }),
    });
  });
});
