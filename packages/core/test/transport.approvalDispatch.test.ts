import { describe, expect, it, vi } from 'vitest';

import { DO_NOT_REPLY } from '../src/jsonrpc/client.js';
import {
  createApprovalDispatcher,
  type ApprovalDispatchEvent,
} from '../src/transport/approvalDispatch.js';
import { createFileChangeTracker } from '../src/transport/fileChangeTracker.js';
import type { FileUpdateChange } from '../src/protocol/index.js';

const change: FileUpdateChange = {
  path: 'src/file.ts',
  kind: { type: 'update', move_path: null },
  diff: '@@',
};

function createAharness() {
  const events: ApprovalDispatchEvent[] = [];
  const dispatcher = createApprovalDispatcher({ publish: (event) => events.push(event) });
  return { dispatcher, events };
}

function createActiveThreadAharness(initialThreadId = 'thread-1') {
  let activeThreadId = initialThreadId;
  const events: ApprovalDispatchEvent[] = [];
  const diagnostics: Array<{ threadId: string; source: string; message: string }> = [];
  const permissionRequest = vi.fn(() => 'delegate' as const);
  const dispatcher = createApprovalDispatcher({
    publish: (event) => events.push(event),
    permissionRequest,
    isActiveThread: (threadId) => threadId === activeThreadId,
    onAbandonedThreadDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return {
    dispatcher,
    events,
    diagnostics,
    permissionRequest,
    setActiveThread(threadId: string) {
      activeThreadId = threadId;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createApprovalDispatcher', () => {
  it('short-circuits command approvals when permissionRequest returns a direct decision', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const permissionRequest = vi.fn(async () => 'accept' as const);
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      permissionRequest,
    });

    const result = dispatcher.handleCommandApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      approvalId: 'approval-1',
      command: 'pnpm test',
      cwd: '/repo',
    });

    dispatcher.close();
    await expect(result).resolves.toEqual({ decision: 'accept' });
    expect(permissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'command',
        toolName: 'Bash',
        matcherAliases: [],
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        approvalId: 'approval-1',
        command: 'pnpm test',
        cwd: '/repo',
      }),
      undefined,
    );
    expect(events).toEqual([
      {
        kind: 'FrameworkNote',
        id: 'permission-request-command-thread-1-turn-1-cmd-1',
        text: 'PermissionRequest command approval resolved with accept.',
        variant: 'info',
      },
    ]);
  });

  it('delegates command approvals to the browser path when permissionRequest delegates', () => {
    const events: ApprovalDispatchEvent[] = [];
    const permissionRequest = vi.fn(() => 'delegate' as const);
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      permissionRequest,
    });

    void dispatcher.handleCommandApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      command: 'pnpm test',
    });

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      kind: 'ServerRequest',
      method: 'item/commandExecution/requestApproval',
      requestId: 'command:1',
    });
    dispatcher.close();
  });

  it('short-circuits file approvals without publishing a pending browser card', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const permissionRequest = vi.fn(async () => 'decline' as const);
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      permissionRequest,
    });

    const result = dispatcher.handleFileApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      reason: 'needs write access',
      grantRoot: '/repo',
    });

    dispatcher.close();
    await expect(result).resolves.toEqual({ decision: 'decline' });
    expect(permissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'file',
        toolName: 'apply_patch',
        matcherAliases: ['Write', 'Edit'],
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        reason: 'needs write access',
        grantRoot: '/repo',
      }),
      undefined,
    );
    expect(events).toEqual([
      {
        kind: 'FrameworkNote',
        id: 'permission-request-file-thread-1-turn-1-patch-1',
        text: 'PermissionRequest file approval resolved with decline.',
        variant: 'info',
      },
    ]);
  });

  it('parks command approvals and resolves legal browser approval replies', async () => {
    const { dispatcher, events } = createAharness();

    const parked = dispatcher.handleCommandApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        approvalId: 'approval-1',
        command: 'npm test',
        cwd: '/repo',
      },
      { requestId: 10 },
    );

    expect(events[0]).toMatchObject({
      kind: 'ServerRequest',
      approvalId: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      command: 'npm test',
    });
    const event = events[0];
    if (!event || event.kind !== 'ServerRequest') throw new Error('missing command event');

    const result = await dispatcher.handleBrowserReply({
      kind: 'approval',
      requestId: event.requestId,
      decision: 'accept',
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    await expect(parked).resolves.toEqual({ decision: 'accept' });
    expect(events.at(-1)).toEqual({
      kind: 'ApprovalRequestResolved',
      id: event.requestId,
      requestId: event.requestId,
    });
  });

  it('records raw canonical request payloads before publishing browser approval cards', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const records: unknown[] = [];
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      record: (input) => records.push(input),
    });

    const parked = dispatcher.handleCommandApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        approvalId: 'approval-1',
        command: 'npm test',
        cwd: '/repo',
        commandActions: [{ label: 'allow once' }],
        proposedNetworkPolicyAmendments: [{ host: 'example.test' }],
      },
      { requestId: 10 },
    );

    expect(records[0]).toEqual(
      expect.objectContaining({
        type: 'request.created',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        requestId: 'command:1',
        data: expect.objectContaining({
          kind: 'command-approval',
          status: 'pending',
          hasCommand: true,
        }),
        raw: {
          params: expect.objectContaining({
            command: 'npm test',
            cwd: '/repo',
            commandActions: [{ label: 'allow once' }],
            proposedNetworkPolicyAmendments: [{ host: 'example.test' }],
          }),
        },
      }),
    );
    expect(events[0]).toMatchObject({ kind: 'ServerRequest', requestId: 'command:1' });

    await dispatcher.handleBrowserReply({
      kind: 'approval',
      requestId: 'command:1',
      decision: 'accept',
    });
    await expect(parked).resolves.toEqual({ decision: 'accept' });
    expect(records.at(-1)).toEqual(
      expect.objectContaining({ type: 'request.resolved', requestId: 'command:1' }),
    );
  });

  it('records raw canonical permission approval request payloads', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const records: unknown[] = [];
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      record: (input) => records.push(input),
    });

    const parked = dispatcher.handlePermissionApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'perm-1',
        cwd: '/repo',
        reason: 'network access',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      { requestId: 11 },
    );

    expect(records[0]).toEqual(
      expect.objectContaining({
        type: 'request.created',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'perm-1',
        requestId: 'permission:1',
        data: expect.objectContaining({
          kind: 'permission-approval',
          status: 'pending',
        }),
        raw: {
          params: expect.objectContaining({
            cwd: '/repo',
            reason: 'network access',
            permissions: { network: { enabled: true }, fileSystem: null },
          }),
        },
      }),
    );
    expect(events[0]).toMatchObject({ kind: 'ServerRequest', requestId: 'permission:1' });

    await dispatcher.handleBrowserReply({
      kind: 'permission',
      requestId: 'permission:1',
      decision: 'acceptForSession',
    });
    await expect(parked).resolves.toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
  });

  it('records raw canonical elicitation request payloads for form and url modes', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const records: unknown[] = [];
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      record: (input) => records.push(input),
    });
    const requestedSchema = { type: 'object', properties: { choice: { type: 'string' } } };

    const formParked = dispatcher.handleElicitation(
      {
        mode: 'form',
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'srv',
        _meta: { trace: 'form' },
        message: 'choose',
        requestedSchema,
      },
      { requestId: 12 },
    );

    expect(records[0]).toEqual(
      expect.objectContaining({
        type: 'request.created',
        threadId: 'thread-1',
        turnId: 'turn-1',
        requestId: 'elicitation:1',
        data: expect.objectContaining({
          kind: 'elicitation',
          mode: 'form',
          hasSchema: true,
        }),
        raw: {
          params: expect.objectContaining({
            mode: 'form',
            message: 'choose',
            requestedSchema,
            _meta: { trace: 'form' },
          }),
        },
      }),
    );
    await dispatcher.handleBrowserReply({
      kind: 'elicitation',
      requestId: 'elicitation:1',
      action: 'decline',
    });
    await expect(formParked).resolves.toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });

    const urlParked = dispatcher.handleElicitation(
      {
        mode: 'url',
        threadId: 'thread-1',
        turnId: null,
        serverName: 'srv',
        _meta: { trace: 'url' },
        message: 'open this',
        url: 'https://example.test',
        elicitationId: 'url-1',
      },
      { requestId: 13 },
    );

    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'request.created',
        threadId: 'thread-1',
        requestId: 'elicitation:2',
        data: expect.objectContaining({
          kind: 'elicitation',
          mode: 'url',
          hasUrl: true,
        }),
        raw: {
          params: expect.objectContaining({
            mode: 'url',
            message: 'open this',
            url: 'https://example.test',
            elicitationId: 'url-1',
            _meta: { trace: 'url' },
          }),
        },
      }),
    );
    await dispatcher.handleBrowserReply({
      kind: 'elicitation',
      requestId: 'elicitation:2',
      action: 'cancel',
    });
    await expect(urlParked).resolves.toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
  });

  it('records raw canonical file-change update payloads for pending approvals', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const records: unknown[] = [];
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      record: (input) => records.push(input),
    });

    const parked = dispatcher.handleFileApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        reason: 'needs write access',
        grantRoot: '/repo',
      },
      { requestId: 'rpc-file' },
    );
    dispatcher.fileChangeTracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [change],
    });

    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'request.updated',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        requestId: 'file:1',
        data: expect.objectContaining({
          kind: 'file-approval',
          status: 'pending',
          changeCount: 1,
        }),
        raw: {
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'patch-1',
            changes: [change],
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'FileApprovalUpdated', requestId: 'file:1' }),
    );

    await dispatcher.handleBrowserReply({
      kind: 'approval',
      requestId: 'file:1',
      decision: 'decline',
    });
    await expect(parked).resolves.toEqual({ decision: 'decline' });
  });

  it('records raw canonical request payloads for permissionRequest auto-decisions', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const records: unknown[] = [];
    const permissionRequest = vi.fn(() => 'accept' as const);
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      record: (input) => records.push(input),
      permissionRequest,
    });

    const result = dispatcher.handleCommandApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        approvalId: 'approval-1',
        command: 'npm test',
        cwd: '/repo',
      },
      { requestId: 10 },
    );

    expect(result).toEqual({ decision: 'accept' });
    expect(records).toEqual([
      expect.objectContaining({
        type: 'request.created',
        requestId: 'policy:command:10',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        data: expect.objectContaining({
          kind: 'command-approval',
          status: 'pending',
        }),
        raw: {
          params: expect.objectContaining({
            command: 'npm test',
            cwd: '/repo',
          }),
        },
      }),
      expect.objectContaining({
        type: 'request.resolved',
        requestId: 'policy:command:10',
        raw: { params: { response: { decision: 'accept' } } },
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'FrameworkNote',
        text: expect.stringContaining('resolved with accept'),
      }),
    ]);
  });

  it('returns safe fallback responses for malformed params', async () => {
    const { dispatcher, events } = createAharness();

    expect(dispatcher.handleCommandApproval({})).toEqual({ decision: 'decline' });
    expect(dispatcher.handleFileApproval({})).toEqual({ decision: 'decline' });
    expect(dispatcher.handlePermissionApproval({})).toEqual({
      permissions: {},
      scope: 'turn',
    });
    expect(dispatcher.handleElicitation({})).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
    expect(events).toEqual([]);
  });

  it('does not record malformed or inactive approval fallbacks as accepted requests', () => {
    const events: ApprovalDispatchEvent[] = [];
    const records: unknown[] = [];
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      record: (input) => records.push(input),
      isActiveThread: (threadId) => threadId === 'thread-live',
    });

    expect(dispatcher.handleCommandApproval({})).toEqual({ decision: 'decline' });
    expect(
      dispatcher.handleFileApproval({
        threadId: 'thread-old',
        turnId: 'turn-1',
        itemId: 'patch-1',
      }),
    ).toEqual({ decision: 'decline' });
    expect(
      dispatcher.handlePermissionApproval({
        threadId: 'thread-old',
        turnId: 'turn-1',
        itemId: 'perm-1',
        cwd: '/repo',
        permissions: { network: null, fileSystem: null },
      }),
    ).toEqual({ permissions: {}, scope: 'turn' });
    expect(
      dispatcher.handleElicitation({
        mode: 'url',
        threadId: 'thread-old',
        turnId: null,
        serverName: 'srv',
        _meta: null,
        message: 'open',
        url: 'https://example.test',
        elicitationId: 'url-1',
      }),
    ).toEqual({ action: 'cancel', content: null, _meta: null });

    expect(events).toEqual([]);
    expect(records).toEqual([]);
  });

  it('declines inactive-thread approval requests without publishing browser cards', async () => {
    const { dispatcher, events, diagnostics, permissionRequest } =
      createActiveThreadAharness('thread-1');

    await expect(
      Promise.resolve(
        dispatcher.handleCommandApproval({
          threadId: 'thread-old',
          turnId: 'turn-1',
          itemId: 'cmd-1',
          command: 'pnpm test',
        }),
      ),
    ).resolves.toEqual({ decision: 'decline' });
    await expect(
      Promise.resolve(
        dispatcher.handleFileApproval({
          threadId: 'thread-old',
          turnId: 'turn-1',
          itemId: 'patch-1',
        }),
      ),
    ).resolves.toEqual({ decision: 'decline' });
    await expect(
      Promise.resolve(
        dispatcher.handlePermissionApproval({
          threadId: 'thread-old',
          turnId: 'turn-1',
          itemId: 'perm-1',
          cwd: '/repo',
          permissions: { network: null, fileSystem: null },
        }),
      ),
    ).resolves.toEqual({ permissions: {}, scope: 'turn' });
    await expect(
      Promise.resolve(
        dispatcher.handleElicitation({
          mode: 'url',
          threadId: 'thread-old',
          turnId: null,
          serverName: 'srv',
          _meta: null,
          message: 'open',
          url: 'https://example.test',
          elicitationId: 'url-1',
        }),
      ),
    ).resolves.toEqual({ action: 'cancel', content: null, _meta: null });

    expect(permissionRequest).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ threadId: 'thread-old', source: 'commandApproval' }),
      expect.objectContaining({ threadId: 'thread-old', source: 'fileApproval' }),
      expect.objectContaining({ threadId: 'thread-old', source: 'permissionApproval' }),
      expect.objectContaining({ threadId: 'thread-old', source: 'elicitation' }),
    ]);
  });

  it('declines command approval when async policy delegates after the thread becomes inactive', async () => {
    let activeThreadId = 'thread-1';
    const events: ApprovalDispatchEvent[] = [];
    const policy = deferred<'delegate'>();
    const permissionRequest = vi.fn(() => policy.promise);
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      permissionRequest,
      isActiveThread: (threadId) => threadId === activeThreadId,
    });

    const result = dispatcher.handleCommandApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      command: 'pnpm test',
    });

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    activeThreadId = 'thread-2';
    dispatcher.abandonInactiveRequests();
    policy.resolve('delegate');

    await expect(Promise.resolve(result)).resolves.toEqual({ decision: 'decline' });
    expect(events).toEqual([]);
  });

  it('declines file approval when async policy decides after the thread becomes inactive', async () => {
    let activeThreadId = 'thread-1';
    const events: ApprovalDispatchEvent[] = [];
    const policy = deferred<'accept'>();
    const permissionRequest = vi.fn(() => policy.promise);
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      permissionRequest,
      isActiveThread: (threadId) => threadId === activeThreadId,
    });

    const result = dispatcher.handleFileApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    activeThreadId = 'thread-2';
    dispatcher.abandonInactiveRequests();
    policy.resolve('accept');

    await expect(Promise.resolve(result)).resolves.toEqual({ decision: 'decline' });
    expect(events).toEqual([]);
  });

  it('declines command approval when throwing policy changes the active thread first', async () => {
    let activeThreadId = 'thread-1';
    const events: ApprovalDispatchEvent[] = [];
    const permissionRequest = vi.fn(() => {
      activeThreadId = 'thread-2';
      throw new Error('policy failed after thread swap');
    });
    const dispatcher = createApprovalDispatcher({
      publish: (event) => events.push(event),
      permissionRequest,
      isActiveThread: (threadId) => threadId === activeThreadId,
    });

    const result = dispatcher.handleCommandApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      command: 'pnpm test',
    });

    expect(result).toEqual({ decision: 'decline' });
    expect(events).toEqual([]);
  });

  it('publishes file approvals with changes from the tracker', async () => {
    const events: ApprovalDispatchEvent[] = [];
    const fileChangeTracker = createFileChangeTracker({
      onPendingFileApprovalChanges: (update) =>
        events.push({
          kind: 'FileApprovalUpdated',
          id: update.requestId,
          requestId: update.requestId,
          threadId: update.threadId,
          turnId: update.turnId,
          itemId: update.itemId,
          changes: update.changes,
        }),
    });
    fileChangeTracker.notePatchUpdated({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      changes: [change],
    });
    const dispatcher = createApprovalDispatcher({
      fileChangeTracker,
      publish: (event) => events.push(event),
    });

    const parked = dispatcher.handleFileApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        reason: 'needs write access',
        grantRoot: '/repo',
      },
      { requestId: 'rpc-file' },
    );

    expect(events[0]).toEqual({
      kind: 'ServerRequest',
      id: expect.stringMatching(/^file:/),
      requestId: expect.stringMatching(/^file:/),
      method: 'item/fileChange/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
      reason: 'needs write access',
      grantRoot: '/repo',
      changes: [change],
    });
    const event = events[0];
    if (!event || event.kind !== 'ServerRequest') throw new Error('missing file event');

    await dispatcher.handleBrowserReply({
      kind: 'approval',
      requestId: event.requestId,
      decision: 'decline',
    });
    await expect(parked).resolves.toEqual({ decision: 'decline' });
  });

  it('keeps invalid browser replies parked and rejects wrong kinds', async () => {
    const { dispatcher } = createAharness();
    const parked = dispatcher.handleFileApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });
    const requestId = 'file:1';

    expect(
      await dispatcher.handleBrowserReply({
        kind: 'permission',
        requestId,
        decision: 'accept',
      }),
    ).toMatchObject({ status: 409 });
    expect(
      await dispatcher.handleBrowserReply({
        kind: 'approval',
        requestId,
        decision: 'approve',
      }),
    ).toMatchObject({ status: 400 });

    expect(
      await dispatcher.handleBrowserReply({
        kind: 'approval',
        requestId,
        decision: 'acceptForSession',
      }),
    ).toMatchObject({ status: 200 });
    await expect(parked).resolves.toEqual({ decision: 'acceptForSession' });
  });

  it('maps permission decisions to Codex permission response shapes', async () => {
    const { dispatcher } = createAharness();
    const parked = dispatcher.handlePermissionApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'perm-1',
      cwd: '/repo',
      reason: 'network',
      permissions: { network: { enabled: true }, fileSystem: null },
    });

    expect(
      await dispatcher.handleBrowserReply({
        kind: 'permission',
        requestId: 'permission:1',
        decision: 'acceptForSession',
      }),
    ).toMatchObject({ status: 200 });
    await expect(parked).resolves.toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
  });

  it('maps elicitation replies to Codex response content', async () => {
    const { dispatcher, events } = createAharness();
    const parked = dispatcher.handleElicitation({
      mode: 'form',
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'srv',
      _meta: null,
      message: 'choose',
      requestedSchema: { type: 'object' },
    });

    const event = events[0];
    expect(event).toMatchObject({
      kind: 'ServerRequest',
      method: 'mcpServer/elicitation/request',
      requestId: 'elicitation:1',
    });

    expect(
      await dispatcher.handleBrowserReply({
        kind: 'elicitation',
        requestId: 'elicitation:1',
        action: 'accept',
        values: { choice: 'yes' },
      }),
    ).toMatchObject({ status: 200 });
    await expect(parked).resolves.toEqual({
      action: 'accept',
      content: { choice: 'yes' },
      _meta: null,
    });
  });

  it('cleans pending requests on serverRequest/resolved without sending a second response', async () => {
    const { dispatcher, events } = createAharness();
    const parked = dispatcher.handleFileApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
      },
      { requestId: 42 },
    );

    dispatcher.handleServerRequestResolved({ threadId: 'thread-1', requestId: 42 });

    await expect(parked).resolves.toBe(DO_NOT_REPLY);
    expect(events.at(-1)).toEqual({
      kind: 'ApprovalRequestResolved',
      id: 'file:1',
      requestId: 'file:1',
    });
    expect(
      await dispatcher.handleBrowserReply({
        kind: 'approval',
        requestId: 'file:1',
        decision: 'accept',
      }),
    ).toMatchObject({ status: 409 });
  });

  it('ignores inactive-thread serverRequest/resolved notifications', async () => {
    const { dispatcher, events } = createActiveThreadAharness('thread-1');
    const parked = dispatcher.handleFileApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
      },
      { requestId: 42 },
    );

    dispatcher.handleServerRequestResolved({ threadId: 'thread-old', requestId: 42 });

    expect(events).toHaveLength(1);
    expect(
      await dispatcher.handleBrowserReply({
        kind: 'approval',
        requestId: 'file:1',
        decision: 'accept',
      }),
    ).toMatchObject({ status: 200 });
    await expect(parked).resolves.toEqual({ decision: 'accept' });
  });

  it('abandons inactive parked requests with safe synthetic responses', async () => {
    const { dispatcher, events, diagnostics, setActiveThread } =
      createActiveThreadAharness('thread-1');
    const command = dispatcher.handleCommandApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
    });
    const file = dispatcher.handleFileApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });
    const permission = dispatcher.handlePermissionApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'perm-1',
      cwd: '/repo',
      permissions: { network: null, fileSystem: null },
    });
    const elicitation = dispatcher.handleElicitation({
      mode: 'form',
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'srv',
      _meta: null,
      message: 'choose',
      requestedSchema: { type: 'object' },
    });

    setActiveThread('thread-2');
    dispatcher.abandonInactiveRequests();

    await expect(command).resolves.toEqual({ decision: 'decline' });
    await expect(file).resolves.toEqual({ decision: 'decline' });
    await expect(permission).resolves.toEqual({ permissions: {}, scope: 'turn' });
    await expect(elicitation).resolves.toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
    expect(events.slice(4)).toEqual([
      { kind: 'ApprovalRequestResolved', id: 'command:1', requestId: 'command:1' },
      { kind: 'ApprovalRequestResolved', id: 'file:2', requestId: 'file:2' },
      { kind: 'ApprovalRequestResolved', id: 'permission:3', requestId: 'permission:3' },
      { kind: 'ApprovalRequestResolved', id: 'elicitation:4', requestId: 'elicitation:4' },
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ threadId: 'thread-1', source: 'parkedApproval' }),
      expect.objectContaining({ threadId: 'thread-1', source: 'parkedApproval' }),
      expect.objectContaining({ threadId: 'thread-1', source: 'parkedApproval' }),
      expect.objectContaining({ threadId: 'thread-1', source: 'parkedApproval' }),
    ]);
    expect(
      await dispatcher.handleBrowserReply({
        kind: 'approval',
        requestId: 'command:1',
        decision: 'accept',
      }),
    ).toMatchObject({ status: 409 });
  });

  it('closes all pending requests with safe synthetic responses', async () => {
    const { dispatcher } = createAharness();
    const command = dispatcher.handleCommandApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
    });
    const permission = dispatcher.handlePermissionApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'perm-1',
      cwd: '/repo',
      reason: null,
      permissions: { network: null, fileSystem: null },
    });
    const elicitation = dispatcher.handleElicitation({
      mode: 'url',
      threadId: 'thread-1',
      turnId: null,
      serverName: 'srv',
      _meta: null,
      message: 'open',
      url: 'https://example.test',
      elicitationId: 'url-1',
    });

    dispatcher.close();

    await expect(command).resolves.toEqual({ decision: 'decline' });
    await expect(permission).resolves.toEqual({ permissions: {}, scope: 'turn' });
    await expect(elicitation).resolves.toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
  });

  it('resolves stale same-id requests with safe synthetic responses', async () => {
    const { dispatcher } = createAharness();
    const first = dispatcher.handleCommandApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
      },
      { requestId: 'rpc-1' },
    );
    const second = dispatcher.handleCommandApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-2',
      },
      { requestId: 'rpc-2' },
    );

    dispatcher.close();

    await expect(first).resolves.toEqual({ decision: 'decline' });
    await expect(second).resolves.toEqual({ decision: 'decline' });
  });

  it('keeps opaque browser ids isolated across approval families', async () => {
    const { dispatcher, events } = createAharness();
    const file = dispatcher.handleFileApproval({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'elicitation:1',
    });
    const elicitation = dispatcher.handleElicitation({
      mode: 'form',
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'srv',
      _meta: null,
      message: 'choose',
      requestedSchema: { type: 'object' },
    });

    const fileEvent = events[0];
    const elicitationEvent = events[1];
    if (!fileEvent || fileEvent.kind !== 'ServerRequest') throw new Error('missing file event');
    if (!elicitationEvent || elicitationEvent.kind !== 'ServerRequest') {
      throw new Error('missing elicitation event');
    }
    expect(fileEvent.requestId).toMatch(/^file:/);
    expect(elicitationEvent.requestId).toMatch(/^elicitation:/);
    expect(fileEvent.requestId).not.toBe(elicitationEvent.requestId);

    await dispatcher.handleBrowserReply({
      kind: 'approval',
      requestId: fileEvent.requestId,
      decision: 'accept',
    });
    await dispatcher.handleBrowserReply({
      kind: 'elicitation',
      requestId: elicitationEvent.requestId,
      action: 'decline',
    });

    await expect(file).resolves.toEqual({ decision: 'accept' });
    await expect(elicitation).resolves.toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('rejects form elicitation accept replies without values', async () => {
    const { dispatcher } = createAharness();
    const parked = dispatcher.handleElicitation({
      mode: 'form',
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'srv',
      _meta: null,
      message: 'choose',
      requestedSchema: { type: 'object' },
    });

    expect(
      await dispatcher.handleBrowserReply({
        kind: 'elicitation',
        requestId: 'elicitation:1',
        action: 'accept',
      }),
    ).toMatchObject({ status: 400 });

    await dispatcher.handleBrowserReply({
      kind: 'elicitation',
      requestId: 'elicitation:1',
      action: 'decline',
    });
    await expect(parked).resolves.toEqual({ action: 'decline', content: null, _meta: null });
  });
});
