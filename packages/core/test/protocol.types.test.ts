/**
 * Type-level test pinning the wire shape of the codex JSON-RPC protocol
 * types. The shapes are anchored to codex-rs at the pinned commit
 * (`SUPPORTED_CODEX.md`); breaking these expectations means the wire
 * contract changed and both the types and the call sites need an
 * audit.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentMessageDeltaNotification,
  BrowserApprovalDecision,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  DynamicToolCallOutputContentItem,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolDef,
  ErrorNotification,
  FileChangePatchUpdatedNotification,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  FileUpdateChange,
  GrantedPermissionProfile,
  HookCompletedNotification,
  HookStartedNotification,
  InitializeParams,
  InitializeResult,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  McpServerElicitationAction,
  PermissionGrantScope,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RequestUserInputAnswer,
  RequestUserInputOption,
  RequestUserInputQuestion,
  RequestPermissionProfile,
  ResponseItem,
  ServerRequestResolvedNotification,
  ServerNotification,
  ThreadInjectItemsParams,
  ThreadInjectItemsResponse,
  ThreadNameSetParams,
  ThreadNameSetResponse,
  ThreadRollbackParams,
  ThreadRollbackResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSnapshot,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  ThreadUnsubscribeStatus,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnSnapshot,
  TurnStartParams,
  TurnStartResponse,
  TurnStartedNotification,
  UserInput,
} from '../src/protocol/index.js';
import { DAEMON_PROBE_CLIENT_NAME } from '../src/protocol/types.js';

describe('protocol request/response types', () => {
  it('InitializeParams / InitializeResult shape (camelCase per codex serde rename_all)', () => {
    expectTypeOf<InitializeParams>().toMatchTypeOf<{
      clientInfo: { name: string; version: string };
    }>();
    expectTypeOf<InitializeResult>().toMatchTypeOf<{
      serverInfo: { name: string; version: string };
    }>();
  });

  it('DynamicToolDef shape (v2.rs:670-681 — wire key is `inputSchema`)', () => {
    expectTypeOf<DynamicToolDef>().toMatchTypeOf<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>();
    // `parameters` would be the wrong wire key — guard against accidental
    // re-introduction by ensuring it is not part of the type.
    expectTypeOf<DynamicToolDef>().not.toMatchTypeOf<{ parameters: unknown }>();
  });

  it('ThreadStartParams accepts narrow harness fields', () => {
    expectTypeOf<ThreadStartParams>().toMatchTypeOf<{
      baseInstructions?: string;
      dynamicTools?: ReadonlyArray<DynamicToolDef>;
      sessionStartSource?: 'startup' | 'clear';
    }>();
    const params: ThreadStartParams = { sessionStartSource: 'clear' };
    expect(params.sessionStartSource).toBe('clear');
  });

  it('ThreadStartResponse nests a Thread snapshot', () => {
    expectTypeOf<ThreadStartResponse>().toMatchTypeOf<{
      thread: ThreadSnapshot;
    }>();
    expectTypeOf<ThreadSnapshot>().toMatchTypeOf<{ id: string; ephemeral: boolean }>();
  });

  it('ThreadResume params + response', () => {
    expectTypeOf<ThreadResumeParams>().toMatchTypeOf<{ threadId: string }>();
    expectTypeOf<ThreadResumeResponse>().toMatchTypeOf<{ thread: ThreadSnapshot }>();
  });

  it('ThreadRollback params + response', () => {
    expectTypeOf<ThreadRollbackParams>().toMatchTypeOf<{
      threadId: string;
      numTurns: number;
    }>();
    expectTypeOf<ThreadRollbackResponse>().toEqualTypeOf<Record<string, never>>();
  });

  it('ThreadNameSet params + response', () => {
    expectTypeOf<ThreadNameSetParams>().toMatchTypeOf<{ threadId: string; name: string }>();
    // Empty struct on the wire — modelled as an empty Record.
    expectTypeOf<ThreadNameSetResponse>().toEqualTypeOf<Record<string, never>>();
  });

  it('ThreadUnsubscribe params + response', () => {
    expectTypeOf<ThreadUnsubscribeParams>().toMatchTypeOf<{ threadId: string }>();
    expectTypeOf<ThreadUnsubscribeStatus>().toEqualTypeOf<
      'notLoaded' | 'notSubscribed' | 'unsubscribed'
    >();
    const response: ThreadUnsubscribeResponse = { status: 'unsubscribed' };
    expect(response.status).toBe('unsubscribed');
  });

  it('ThreadInjectItemsParams shape (items: ResponseItem[])', () => {
    expectTypeOf<ThreadInjectItemsParams>().toMatchTypeOf<{
      threadId: string;
      items: ReadonlyArray<ResponseItem>;
    }>();
    expectTypeOf<ThreadInjectItemsResponse>().toEqualTypeOf<Record<string, never>>();
  });

  it('TurnStartParams + TurnStartResponse shape', () => {
    expectTypeOf<TurnStartParams>().toMatchTypeOf<{
      threadId: string;
      input: ReadonlyArray<UserInput>;
    }>();
    expectTypeOf<TurnStartResponse>().toMatchTypeOf<{ turn: { id: string } }>();
  });

  it('DynamicToolCallParams shape (v2.rs:7740-7747)', () => {
    expectTypeOf<DynamicToolCallParams>().toMatchTypeOf<{
      threadId: string;
      turnId: string;
      callId: string;
      tool: string;
    }>();
    // The wire field is `tool`, not `tool_name` — guard against drift.
    expectTypeOf<DynamicToolCallParams>().not.toMatchTypeOf<{ tool_name: string }>();
  });

  it('DynamicToolCallResponse shape (v2.rs:7786-7789)', () => {
    expectTypeOf<DynamicToolCallResponse>().toMatchTypeOf<{
      success: boolean;
      contentItems: ReadonlyArray<DynamicToolCallOutputContentItem>;
    }>();
    // The wire key is `contentItems`, not `content_items`.
    expectTypeOf<DynamicToolCallResponse>().not.toMatchTypeOf<{ content_items: unknown }>();
  });

  it('DynamicToolCallOutputContentItem is a tagged union (v2.rs:7795-7800)', () => {
    const text: DynamicToolCallOutputContentItem = { type: 'inputText', text: 'hi' };
    const image: DynamicToolCallOutputContentItem = {
      type: 'inputImage',
      imageUrl: 'https://example.com/x.png',
    };
    expect(text.type).toBe('inputText');
    expect(image.type).toBe('inputImage');
  });

  it('RequestUserInputQuestion shape (v2.rs:7828-7837)', () => {
    expectTypeOf<RequestUserInputQuestion>().toMatchTypeOf<{
      id: string;
      header: string;
      question: string;
      isOther: boolean;
      isSecret: boolean;
      options?: ReadonlyArray<RequestUserInputOption>;
    }>();
    // Options are objects (`{label, description}`), not bare strings.
    expectTypeOf<RequestUserInputOption>().toMatchTypeOf<{
      label: string;
      description: string;
    }>();
  });

  it('ToolRequestUserInputParams shape (v2.rs:7843-7848)', () => {
    expectTypeOf<ToolRequestUserInputParams>().toMatchTypeOf<{
      threadId: string;
      turnId: string;
      itemId: string;
      questions: ReadonlyArray<RequestUserInputQuestion>;
    }>();
  });

  it('ToolRequestUserInputResponse shape (v2.rs:7862-7864)', () => {
    expectTypeOf<ToolRequestUserInputResponse>().toMatchTypeOf<{
      answers: Record<string, RequestUserInputAnswer>;
    }>();
    expectTypeOf<RequestUserInputAnswer>().toMatchTypeOf<{
      answers: ReadonlyArray<string>;
    }>();
  });

  it('approval ServerRequest params and browser response decisions', () => {
    expectTypeOf<BrowserApprovalDecision>().toEqualTypeOf<
      'accept' | 'acceptForSession' | 'decline' | 'cancel'
    >();
    expectTypeOf<CommandExecutionRequestApprovalParams>().toMatchTypeOf<{
      threadId: string;
      turnId: string;
      itemId: string;
      approvalId?: string | null;
      command?: string | null;
      cwd?: string | null;
    }>();
    expectTypeOf<CommandExecutionRequestApprovalResponse>().toMatchTypeOf<{
      decision: BrowserApprovalDecision;
    }>();
    expectTypeOf<FileChangeRequestApprovalParams>().toMatchTypeOf<{
      threadId: string;
      turnId: string;
      itemId: string;
      reason?: string | null;
      grantRoot?: string | null;
    }>();
    expectTypeOf<FileChangeRequestApprovalParams>().not.toMatchTypeOf<{ path: string }>();
    expectTypeOf<FileChangeRequestApprovalParams>().not.toMatchTypeOf<{ patchUnified: string }>();
    expectTypeOf<FileChangeRequestApprovalResponse>().toMatchTypeOf<{
      decision: BrowserApprovalDecision;
    }>();
  });

  it('permission approval request/response shape', () => {
    expectTypeOf<RequestPermissionProfile>().toMatchTypeOf<{
      network: unknown;
      fileSystem: unknown;
    }>();
    expectTypeOf<GrantedPermissionProfile>().toMatchTypeOf<{
      network?: unknown;
      fileSystem?: unknown;
    }>();
    expectTypeOf<PermissionGrantScope>().toEqualTypeOf<'turn' | 'session'>();
    expectTypeOf<PermissionsRequestApprovalParams>().toMatchTypeOf<{
      threadId: string;
      turnId: string;
      itemId: string;
      cwd: string;
      reason: string | null;
      permissions: RequestPermissionProfile;
    }>();
    expectTypeOf<PermissionsRequestApprovalResponse>().toMatchTypeOf<{
      permissions: GrantedPermissionProfile;
      scope: PermissionGrantScope;
      strictAutoReview?: boolean;
    }>();
  });

  it('MCP elicitation request/response shape', () => {
    const form: McpServerElicitationRequestParams = {
      mode: 'form',
      threadId: 't',
      turnId: 'u',
      serverName: 'srv',
      _meta: null,
      message: 'fill form',
      requestedSchema: { type: 'object' },
    };
    const url: McpServerElicitationRequestParams = {
      mode: 'url',
      threadId: 't',
      turnId: null,
      serverName: 'srv',
      _meta: null,
      message: 'open url',
      url: 'https://example.test',
      elicitationId: 'e1',
    };
    const response: McpServerElicitationRequestResponse = {
      action: 'accept',
      content: { ok: true },
      _meta: null,
    };
    expectTypeOf<McpServerElicitationAction>().toEqualTypeOf<'accept' | 'decline' | 'cancel'>();
    expect(form.mode).toBe('form');
    expect(url.mode).toBe('url');
    expect(response.action).toBe('accept');
  });
});

describe('ServerNotification union', () => {
  it('TurnStartedNotification shape (v2.rs:6777-6780 — no originatorConnectionId)', () => {
    const n: TurnStartedNotification = {
      method: 'turn/started',
      params: { threadId: 't', turn: { id: 'turn-1' } },
    };
    expectTypeOf(n.method).toEqualTypeOf<'turn/started'>();
    expectTypeOf<TurnSnapshot>().toMatchTypeOf<{ id: string }>();
  });

  it('TurnCompletedNotification shape (v2.rs:6803-6806)', () => {
    const n: TurnCompletedNotification = {
      method: 'turn/completed',
      params: { threadId: 't', turn: { id: 'turn-1' } },
    };
    expectTypeOf(n.method).toEqualTypeOf<'turn/completed'>();
  });

  it('ItemStarted/Completed notifications carry threadId, turnId, item', () => {
    const started: ItemStartedNotification = {
      method: 'item/started',
      params: {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'i1' },
      },
    };
    const completed: ItemCompletedNotification = {
      method: 'item/completed',
      params: {
        threadId: 't',
        turnId: 'u',
        item: {
          type: 'functionCall',
          id: 'i1',
          callId: 'c1',
          name: 'submit',
        },
      },
    };
    expectTypeOf(started.method).toEqualTypeOf<'item/started'>();
    expectTypeOf(completed.method).toEqualTypeOf<'item/completed'>();
  });

  it('file-change notifications carry Codex changes snapshots', () => {
    const change: FileUpdateChange = {
      path: 'src/file.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@',
    };
    const n: FileChangePatchUpdatedNotification = {
      method: 'item/fileChange/patchUpdated',
      params: { threadId: 't', turnId: 'u', itemId: 'i', changes: [change] },
    };
    const started: ItemStartedNotification = {
      method: 'item/started',
      params: {
        threadId: 't',
        turnId: 'u',
        item: { type: 'fileChange', id: 'i', changes: [change], status: 'inProgress' },
      },
    };
    expectTypeOf(n.method).toEqualTypeOf<'item/fileChange/patchUpdated'>();
    expectTypeOf(started.params.item.type).toEqualTypeOf<'fileChange' | string>();
  });

  it('serverRequest/resolved notification carries JSON-RPC request id', () => {
    const n: ServerRequestResolvedNotification = {
      method: 'serverRequest/resolved',
      params: { threadId: 't', requestId: 7 },
    };
    expectTypeOf(n.method).toEqualTypeOf<'serverRequest/resolved'>();
    expectTypeOf(n.params.requestId).toEqualTypeOf<string | number>();
  });

  it('HookStarted/Completed notifications carry hookEvent and optional decision', () => {
    const started: HookStartedNotification = {
      method: 'hook/started',
      params: { threadId: 't', run: { hookEvent: 'Stop' } },
    };
    const completed: HookCompletedNotification = {
      method: 'hook/completed',
      params: { threadId: 't', run: { hookEvent: 'Stop', decision: 'block' } },
    };
    expectTypeOf(started.method).toEqualTypeOf<'hook/started'>();
    expectTypeOf(completed.method).toEqualTypeOf<'hook/completed'>();
  });

  it('AgentMessageDeltaNotification shape (v2.rs:6958-6963)', () => {
    const n: AgentMessageDeltaNotification = {
      method: 'item/agentMessage/delta',
      params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' },
    };
    expectTypeOf(n.method).toEqualTypeOf<'item/agentMessage/delta'>();
  });

  it('ErrorNotification shape', () => {
    const n: ErrorNotification = { method: 'error', params: { code: -32000, message: 'x' } };
    expectTypeOf(n.method).toEqualTypeOf<'error'>();
  });

  it('union covers every observed variant', () => {
    const variants: ServerNotification[] = [
      { method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } },
      { method: 'turn/completed', params: { threadId: 't', turn: { id: 'u' } } },
      {
        method: 'item/started',
        params: { threadId: 't', turnId: 'u', item: { type: 'agentMessage', id: 'i' } },
      },
      {
        method: 'item/completed',
        params: { threadId: 't', turnId: 'u', item: { type: 'agentMessage', id: 'i' } },
      },
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          threadId: 't',
          turnId: 'u',
          itemId: 'i',
          changes: [{ path: 'a', kind: { type: 'add' }, diff: 'x' }],
        },
      },
      { method: 'hook/started', params: { threadId: 't', run: { hookEvent: 'Stop' } } },
      {
        method: 'hook/completed',
        params: { threadId: 't', run: { hookEvent: 'Stop', decision: 'block' } },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'd' },
      },
      { method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'r' } },
      { method: 'error', params: { code: -32000, message: 'boom' } },
    ];
    for (const n of variants) {
      expect(typeof n.method).toBe('string');
    }
  });
});

describe('InitializeParams camelCase wire fields', () => {
  it('declares clientInfo (not client_info)', () => {
    const p: InitializeParams = {
      clientInfo: { name: 'x', version: '0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['fs/changed'] },
    };
    expect(p.clientInfo.name).toBe('x');
    // @ts-expect-error - client_info must not exist on the wire-shape type
    expect(p.client_info).toBeUndefined();
  });

  it('exports DAEMON_PROBE_CLIENT_NAME = "codex_app_server_daemon"', () => {
    expect(DAEMON_PROBE_CLIENT_NAME).toBe('codex_app_server_daemon');
  });
});
