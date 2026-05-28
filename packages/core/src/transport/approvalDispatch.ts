import { DO_NOT_REPLY, type ServerRequestMeta } from '../jsonrpc/client.js';
import type { PermissionRequestDecision, PermissionRequestEvent } from '../state/hooks.js';
import type {
  BrowserApprovalDecision,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  FileUpdateChange,
  GrantedPermissionProfile,
  McpServerElicitationAction,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RequestPermissionProfile,
} from '../protocol/index.js';
import type { BrowserReplyResult } from '../ui/reply.js';
import {
  buildAbandonedCommandExecutionApprovalResponse,
  buildAbandonedFileChangeApprovalResponse,
  buildAbandonedMcpServerElicitationResponse,
  buildAbandonedPermissionsApprovalResponse,
} from '../runtime/abandonedThreadResponses.js';
import { createFileChangeTracker, type FileChangeTracker } from './fileChangeTracker.js';

type PermissionRequestPolicyResult = PermissionRequestDecision | { readonly decision?: unknown };

export type ApprovalDispatchEvent =
  | FileApprovalRequestEvent
  | CommandApprovalRequestEvent
  | PermissionApprovalRequestEvent
  | ElicitationRequestEvent
  | FileApprovalUpdatedEvent
  | ApprovalRequestResolvedEvent
  | ApprovalPolicyDiagnosticEvent;

export interface FileApprovalRequestEvent {
  readonly kind: 'ServerRequest';
  readonly id: string;
  readonly requestId: string;
  readonly method: 'item/fileChange/requestApproval';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason?: string;
  readonly grantRoot?: string;
  readonly changes: ReadonlyArray<FileUpdateChange>;
}

export interface CommandApprovalRequestEvent {
  readonly kind: 'ServerRequest';
  readonly id: string;
  readonly requestId: string;
  readonly method: 'item/commandExecution/requestApproval';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly approvalId?: string;
  readonly reason?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly commandActions?: ReadonlyArray<unknown>;
  readonly networkApprovalContext?: unknown;
}

export interface PermissionApprovalRequestEvent {
  readonly kind: 'ServerRequest';
  readonly id: string;
  readonly requestId: string;
  readonly method: 'item/permissions/requestApproval';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly cwd: string;
  readonly reason?: string;
  readonly permissions: RequestPermissionProfile;
}

export interface ElicitationRequestEvent {
  readonly kind: 'ServerRequest';
  readonly id: string;
  readonly requestId: string;
  readonly method: 'mcpServer/elicitation/request';
  readonly threadId: string;
  readonly turnId: string | null;
  readonly serverName: string;
  readonly mode: 'form' | 'url';
  readonly message: string;
  readonly requestedSchema?: unknown;
  readonly url?: string;
  readonly elicitationId?: string;
  readonly _meta?: unknown;
}

export interface FileApprovalUpdatedEvent {
  readonly kind: 'FileApprovalUpdated';
  readonly id: string;
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly changes: ReadonlyArray<FileUpdateChange>;
}

export interface ApprovalRequestResolvedEvent {
  readonly kind: 'ApprovalRequestResolved';
  readonly id: string;
  readonly requestId: string;
}

export interface ApprovalPolicyDiagnosticEvent {
  readonly kind: 'FrameworkNote';
  readonly id: string;
  readonly text: string;
  readonly variant: 'info' | 'warn' | 'orientation';
}

export interface ApprovalDispatcherOptions {
  readonly publish: (event: ApprovalDispatchEvent) => void;
  readonly fileChangeTracker?: FileChangeTracker;
  readonly isActiveThread?: (threadId: string) => boolean;
  readonly onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
  readonly permissionRequest?: (
    event: PermissionRequestEvent,
    meta?: ServerRequestMeta,
  ) => PermissionRequestPolicyResult | Promise<PermissionRequestPolicyResult>;
}

export interface ApprovalDispatcher {
  readonly fileChangeTracker: FileChangeTracker;
  handleCommandApproval(
    params: unknown,
    meta?: ServerRequestMeta,
  ): Promise<CommandExecutionRequestApprovalResponse> | CommandExecutionRequestApprovalResponse;
  handleFileApproval(
    params: unknown,
    meta?: ServerRequestMeta,
  ): Promise<FileChangeRequestApprovalResponse> | FileChangeRequestApprovalResponse;
  handlePermissionApproval(
    params: unknown,
    meta?: ServerRequestMeta,
  ): Promise<PermissionsRequestApprovalResponse> | PermissionsRequestApprovalResponse;
  handleElicitation(
    params: unknown,
    meta?: ServerRequestMeta,
  ): Promise<McpServerElicitationRequestResponse> | McpServerElicitationRequestResponse;
  handleBrowserReply(payload: unknown): BrowserReplyResult;
  handleServerRequestResolved(params: unknown): void;
  abandonInactiveRequests(): void;
  close(): void;
}

type PendingKind = 'command' | 'file' | 'permission' | 'elicitation';

type PendingEntry = {
  kind: PendingKind;
  requestId: string;
  codexRequestKey: string;
  threadId: string;
  params: unknown;
  resolve: (response: unknown) => void;
};

type ParkOptions = {
  kind: PendingKind;
  requestId: string;
  codexRequestId: string | number;
  threadId: string;
  params: unknown;
  event: ApprovalDispatchEvent;
  onResolve?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requestKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function metaRequestId(meta: ServerRequestMeta | undefined, fallback: string): string | number {
  return meta?.requestId ?? fallback;
}

function isApprovalDecision(value: unknown): value is BrowserApprovalDecision {
  return (
    value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel'
  );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function normalizePermissionPolicyDecision(
  result: PermissionRequestPolicyResult,
): BrowserApprovalDecision | 'delegate' | null {
  const decision = isRecord(result) ? result['decision'] : result;
  if (decision === undefined || decision === 'delegate') return 'delegate';
  if (isApprovalDecision(decision)) return decision;
  return null;
}

function isElicitationAction(value: unknown): value is McpServerElicitationAction {
  return value === 'accept' || value === 'decline' || value === 'cancel';
}

function isRequestPermissionProfile(value: unknown): value is RequestPermissionProfile {
  return (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'network') &&
    Object.prototype.hasOwnProperty.call(value, 'fileSystem')
  );
}

function grantedFromRequested(requested: RequestPermissionProfile): GrantedPermissionProfile {
  const granted: GrantedPermissionProfile = {};
  if (requested.network !== null) granted.network = requested.network;
  if (requested.fileSystem !== null) granted.fileSystem = requested.fileSystem;
  return granted;
}

function emptyPermissionGrant(): PermissionsRequestApprovalResponse {
  return buildAbandonedPermissionsApprovalResponse();
}

function abandonedPermissionPolicyResponse<
  T extends CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse,
>(event: PermissionRequestEvent): T {
  return (
    event.kind === 'command'
      ? buildAbandonedCommandExecutionApprovalResponse()
      : buildAbandonedFileChangeApprovalResponse()
  ) as T;
}

function safeSyntheticResponse(entry: PendingEntry): unknown {
  if (entry.kind === 'command') {
    return buildAbandonedCommandExecutionApprovalResponse();
  }
  if (entry.kind === 'file') {
    return buildAbandonedFileChangeApprovalResponse();
  }
  if (entry.kind === 'permission') {
    return buildAbandonedPermissionsApprovalResponse();
  }
  return buildAbandonedMcpServerElicitationResponse();
}

function commandParams(params: unknown): CommandExecutionRequestApprovalParams | null {
  if (!isRecord(params)) return null;
  if (
    typeof params['threadId'] !== 'string' ||
    typeof params['turnId'] !== 'string' ||
    typeof params['itemId'] !== 'string'
  ) {
    return null;
  }
  return params as unknown as CommandExecutionRequestApprovalParams;
}

function fileParams(params: unknown): FileChangeRequestApprovalParams | null {
  if (!isRecord(params)) return null;
  if (
    typeof params['threadId'] !== 'string' ||
    typeof params['turnId'] !== 'string' ||
    typeof params['itemId'] !== 'string'
  ) {
    return null;
  }
  return params as unknown as FileChangeRequestApprovalParams;
}

function codexRequestIdForEvent(meta: ServerRequestMeta | undefined): string | undefined {
  const id = meta?.requestId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function permissionParams(params: unknown): PermissionsRequestApprovalParams | null {
  if (!isRecord(params)) return null;
  if (
    typeof params['threadId'] !== 'string' ||
    typeof params['turnId'] !== 'string' ||
    typeof params['itemId'] !== 'string' ||
    typeof params['cwd'] !== 'string' ||
    !isRequestPermissionProfile(params['permissions'])
  ) {
    return null;
  }
  return params as unknown as PermissionsRequestApprovalParams;
}

function elicitationParams(params: unknown): McpServerElicitationRequestParams | null {
  if (!isRecord(params)) return null;
  if (
    typeof params['threadId'] !== 'string' ||
    !(typeof params['turnId'] === 'string' || params['turnId'] === null) ||
    typeof params['serverName'] !== 'string' ||
    typeof params['message'] !== 'string'
  ) {
    return null;
  }
  if (
    params['mode'] === 'form' &&
    Object.prototype.hasOwnProperty.call(params, 'requestedSchema')
  ) {
    return params as unknown as McpServerElicitationRequestParams;
  }
  if (
    params['mode'] === 'url' &&
    typeof params['url'] === 'string' &&
    typeof params['elicitationId'] === 'string'
  ) {
    return params as unknown as McpServerElicitationRequestParams;
  }
  return null;
}

export function createApprovalDispatcher(options: ApprovalDispatcherOptions): ApprovalDispatcher {
  let nextBrowserRequestId = 1;
  const pendingByRequestId = new Map<string, PendingEntry>();
  const pendingByCodexRequestKey = new Map<string, PendingEntry>();
  const isActiveThread = (threadId: string): boolean => options.isActiveThread?.(threadId) ?? true;
  const reportAbandonedThread = (threadId: string, source: string, message: string): void => {
    options.onAbandonedThreadDiagnostic?.({ threadId, source, message });
  };
  const tracker =
    options.fileChangeTracker ??
    createFileChangeTracker({
      isActiveThread,
      onAbandonedThreadDiagnostic: (diagnostic) =>
        options.onAbandonedThreadDiagnostic?.(diagnostic),
      onPendingFileApprovalChanges(update) {
        options.publish({
          kind: 'FileApprovalUpdated',
          id: update.requestId,
          requestId: update.requestId,
          threadId: update.threadId,
          turnId: update.turnId,
          itemId: update.itemId,
          changes: update.changes,
        });
      },
    });

  function removePending(entry: PendingEntry): void {
    pendingByRequestId.delete(entry.requestId);
    pendingByCodexRequestKey.delete(entry.codexRequestKey);
    if (entry.kind === 'file') tracker.noteFileApprovalResolved(entry.requestId);
  }

  function publishResolved(entry: PendingEntry): void {
    options.publish({
      kind: 'ApprovalRequestResolved',
      id: entry.requestId,
      requestId: entry.requestId,
    });
  }

  function browserRequestId(kind: PendingKind): string {
    return `${kind}:${nextBrowserRequestId++}`;
  }

  function park<TResponse>(p: ParkOptions): Promise<TResponse> {
    const codexRequestKey = requestKey(p.codexRequestId);
    const stale = pendingByRequestId.get(p.requestId);
    if (stale) {
      removePending(stale);
      stale.resolve(safeSyntheticResponse(stale));
      publishResolved(stale);
    }

    return new Promise<TResponse>((resolve) => {
      const entry: PendingEntry = {
        kind: p.kind,
        requestId: p.requestId,
        codexRequestKey,
        threadId: p.threadId,
        params: p.params,
        resolve: resolve as (response: unknown) => void,
      };
      pendingByRequestId.set(p.requestId, entry);
      pendingByCodexRequestKey.set(codexRequestKey, entry);
      p.onResolve?.();
      options.publish(p.event);
    });
  }

  function resolveBrowser(entry: PendingEntry, response: unknown): void {
    removePending(entry);
    entry.resolve(response);
    publishResolved(entry);
  }

  function commandBrowserPath(
    narrowed: CommandExecutionRequestApprovalParams,
    meta: ServerRequestMeta | undefined,
  ): Promise<CommandExecutionRequestApprovalResponse> {
    const requestId = browserRequestId('command');
    const approvalId = optionalString(narrowed.approvalId);
    const reason = optionalString(narrowed.reason);
    const command = optionalString(narrowed.command);
    const cwd = optionalString(narrowed.cwd);
    return park<CommandExecutionRequestApprovalResponse>({
      kind: 'command',
      requestId,
      codexRequestId: metaRequestId(meta, requestId),
      threadId: narrowed.threadId,
      params: narrowed,
      event: {
        kind: 'ServerRequest',
        id: requestId,
        requestId,
        method: 'item/commandExecution/requestApproval',
        threadId: narrowed.threadId,
        turnId: narrowed.turnId,
        itemId: narrowed.itemId,
        ...(approvalId ? { approvalId } : {}),
        ...(reason ? { reason } : {}),
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(narrowed.commandActions ? { commandActions: narrowed.commandActions } : {}),
        ...(narrowed.networkApprovalContext
          ? { networkApprovalContext: narrowed.networkApprovalContext }
          : {}),
      },
    });
  }

  function fileBrowserPath(
    narrowed: FileChangeRequestApprovalParams,
    meta: ServerRequestMeta | undefined,
  ): Promise<FileChangeRequestApprovalResponse> {
    const requestId = browserRequestId('file');
    const reason = optionalString(narrowed.reason);
    const grantRoot = optionalString(narrowed.grantRoot);
    const changes = tracker.noteFileApprovalPending({
      requestId,
      threadId: narrowed.threadId,
      turnId: narrowed.turnId,
      itemId: narrowed.itemId,
    });
    return park<FileChangeRequestApprovalResponse>({
      kind: 'file',
      requestId,
      codexRequestId: metaRequestId(meta, requestId),
      threadId: narrowed.threadId,
      params: narrowed,
      event: {
        kind: 'ServerRequest',
        id: requestId,
        requestId,
        method: 'item/fileChange/requestApproval',
        threadId: narrowed.threadId,
        turnId: narrowed.turnId,
        itemId: narrowed.itemId,
        ...(reason ? { reason } : {}),
        ...(grantRoot ? { grantRoot } : {}),
        changes,
      },
    });
  }

  function commandPermissionEvent(
    narrowed: CommandExecutionRequestApprovalParams,
    meta: ServerRequestMeta | undefined,
  ): PermissionRequestEvent {
    const requestId = codexRequestIdForEvent(meta);
    const approvalId = optionalString(narrowed.approvalId);
    const reason = optionalString(narrowed.reason);
    const command = optionalString(narrowed.command);
    const cwd = optionalString(narrowed.cwd);
    return {
      kind: 'command',
      toolName: 'Bash',
      matcherAliases: [],
      threadId: narrowed.threadId,
      turnId: narrowed.turnId,
      itemId: narrowed.itemId,
      ...(requestId ? { requestId } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(reason ? { reason } : {}),
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(narrowed.commandActions ? { commandActions: narrowed.commandActions } : {}),
      ...(narrowed.networkApprovalContext
        ? { networkApprovalContext: narrowed.networkApprovalContext }
        : {}),
    };
  }

  function filePermissionEvent(
    narrowed: FileChangeRequestApprovalParams,
    meta: ServerRequestMeta | undefined,
  ): PermissionRequestEvent {
    const requestId = codexRequestIdForEvent(meta);
    const reason = optionalString(narrowed.reason);
    const grantRoot = optionalString(narrowed.grantRoot);
    return {
      kind: 'file',
      toolName: 'apply_patch',
      matcherAliases: ['Write', 'Edit'],
      threadId: narrowed.threadId,
      turnId: narrowed.turnId,
      itemId: narrowed.itemId,
      ...(requestId ? { requestId } : {}),
      ...(reason ? { reason } : {}),
      ...(grantRoot ? { grantRoot } : {}),
    };
  }

  function publishPolicyDecision(event: PermissionRequestEvent, decision: BrowserApprovalDecision) {
    options.publish({
      kind: 'FrameworkNote',
      id: `permission-request-${event.kind}-${event.threadId}-${event.turnId}-${event.itemId}`,
      text: `PermissionRequest ${event.kind} approval resolved with ${decision}.`,
      variant: 'info',
    });
  }

  function applyPermissionPolicy<
    T extends CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse,
  >(
    event: PermissionRequestEvent,
    meta: ServerRequestMeta | undefined,
    browserPath: () => Promise<T>,
  ): T | Promise<T> {
    if (!options.permissionRequest) {
      if (!isActiveThread(event.threadId)) {
        reportAbandonedThread(
          event.threadId,
          event.kind === 'command' ? 'commandApproval' : 'fileApproval',
          `abandoned ${event.kind} approval declined`,
        );
        return abandonedPermissionPolicyResponse<T>(event);
      }
      return browserPath();
    }
    try {
      const result = options.permissionRequest(event, meta);
      if (isPromiseLike<PermissionRequestPolicyResult>(result)) {
        return result
          .then((resolved) => {
            if (!isActiveThread(event.threadId)) {
              reportAbandonedThread(
                event.threadId,
                event.kind === 'command' ? 'commandApproval' : 'fileApproval',
                `abandoned ${event.kind} approval declined after policy resolution`,
              );
              return abandonedPermissionPolicyResponse<T>(event);
            }
            const decision = normalizePermissionPolicyDecision(resolved);
            if (decision !== null && decision !== 'delegate') {
              publishPolicyDecision(event, decision);
              return { decision } as T;
            }
            return browserPath();
          })
          .catch(() => {
            if (!isActiveThread(event.threadId)) {
              reportAbandonedThread(
                event.threadId,
                event.kind === 'command' ? 'commandApproval' : 'fileApproval',
                `abandoned ${event.kind} approval declined after policy error`,
              );
              return abandonedPermissionPolicyResponse<T>(event);
            }
            return { decision: 'cancel' } as T;
          });
      }
      if (!isActiveThread(event.threadId)) {
        reportAbandonedThread(
          event.threadId,
          event.kind === 'command' ? 'commandApproval' : 'fileApproval',
          `abandoned ${event.kind} approval declined`,
        );
        return abandonedPermissionPolicyResponse<T>(event);
      }
      const decision = normalizePermissionPolicyDecision(result);
      if (decision !== null && decision !== 'delegate') {
        publishPolicyDecision(event, decision);
        return { decision } as T;
      }
      return browserPath();
    } catch {
      if (!isActiveThread(event.threadId)) {
        reportAbandonedThread(
          event.threadId,
          event.kind === 'command' ? 'commandApproval' : 'fileApproval',
          `abandoned ${event.kind} approval declined after policy error`,
        );
        return abandonedPermissionPolicyResponse<T>(event);
      }
      return { decision: 'cancel' } as T;
    }
  }

  return {
    fileChangeTracker: tracker,
    handleCommandApproval(params, meta) {
      const narrowed = commandParams(params);
      if (!narrowed) return buildAbandonedCommandExecutionApprovalResponse();
      if (!isActiveThread(narrowed.threadId)) {
        reportAbandonedThread(
          narrowed.threadId,
          'commandApproval',
          'abandoned command approval declined',
        );
        return buildAbandonedCommandExecutionApprovalResponse();
      }
      return applyPermissionPolicy(commandPermissionEvent(narrowed, meta), meta, () =>
        commandBrowserPath(narrowed, meta),
      );
    },
    handleFileApproval(params, meta) {
      const narrowed = fileParams(params);
      if (!narrowed) return buildAbandonedFileChangeApprovalResponse();
      if (!isActiveThread(narrowed.threadId)) {
        reportAbandonedThread(
          narrowed.threadId,
          'fileApproval',
          'abandoned file approval declined',
        );
        return buildAbandonedFileChangeApprovalResponse();
      }
      return applyPermissionPolicy(filePermissionEvent(narrowed, meta), meta, () =>
        fileBrowserPath(narrowed, meta),
      );
    },
    handlePermissionApproval(params, meta) {
      const narrowed = permissionParams(params);
      if (!narrowed) return emptyPermissionGrant();
      if (!isActiveThread(narrowed.threadId)) {
        reportAbandonedThread(
          narrowed.threadId,
          'permissionApproval',
          'abandoned permission approval declined',
        );
        return buildAbandonedPermissionsApprovalResponse();
      }
      const requestId = browserRequestId('permission');
      const reason = optionalString(narrowed.reason);
      return park<PermissionsRequestApprovalResponse>({
        kind: 'permission',
        requestId,
        codexRequestId: metaRequestId(meta, requestId),
        threadId: narrowed.threadId,
        params: narrowed,
        event: {
          kind: 'ServerRequest',
          id: requestId,
          requestId,
          method: 'item/permissions/requestApproval',
          threadId: narrowed.threadId,
          turnId: narrowed.turnId,
          itemId: narrowed.itemId,
          cwd: narrowed.cwd,
          ...(reason ? { reason } : {}),
          permissions: narrowed.permissions,
        },
      });
    },
    handleElicitation(params, meta) {
      const narrowed = elicitationParams(params);
      if (!narrowed) return buildAbandonedMcpServerElicitationResponse();
      if (!isActiveThread(narrowed.threadId)) {
        reportAbandonedThread(
          narrowed.threadId,
          'elicitation',
          'abandoned elicitation request cancelled',
        );
        return buildAbandonedMcpServerElicitationResponse();
      }
      const requestId = browserRequestId('elicitation');
      return park<McpServerElicitationRequestResponse>({
        kind: 'elicitation',
        requestId,
        codexRequestId: metaRequestId(meta, requestId),
        threadId: narrowed.threadId,
        params: narrowed,
        event: {
          kind: 'ServerRequest',
          id: requestId,
          requestId,
          method: 'mcpServer/elicitation/request',
          threadId: narrowed.threadId,
          turnId: narrowed.turnId,
          serverName: narrowed.serverName,
          mode: narrowed.mode,
          message: narrowed.message,
          _meta: narrowed._meta,
          ...(narrowed.mode === 'form'
            ? { requestedSchema: narrowed.requestedSchema }
            : { url: narrowed.url, elicitationId: narrowed.elicitationId }),
        },
      });
    },
    handleBrowserReply(payload) {
      if (!isRecord(payload) || typeof payload['kind'] !== 'string') {
        return { status: 400, body: { error: 'invalid-approval-reply-payload' } };
      }
      const requestId = payload['requestId'];
      if (typeof requestId !== 'string') {
        return { status: 400, body: { error: 'invalid-approval-request-id' } };
      }
      const entry = pendingByRequestId.get(requestId);
      if (!entry) {
        return { status: 409, body: { error: 'approval-request-not-pending' } };
      }

      if (payload['kind'] === 'approval') {
        if (entry.kind !== 'command' && entry.kind !== 'file') {
          return { status: 409, body: { error: 'approval-request-kind-mismatch' } };
        }
        const decision = payload['decision'];
        if (!isApprovalDecision(decision)) {
          return { status: 400, body: { error: 'invalid-approval-decision' } };
        }
        resolveBrowser(entry, { decision });
        return { status: 200, body: { ok: true } };
      }

      if (payload['kind'] === 'permission') {
        if (entry.kind !== 'permission') {
          return { status: 409, body: { error: 'approval-request-kind-mismatch' } };
        }
        const decision = payload['decision'];
        if (!isApprovalDecision(decision)) {
          return { status: 400, body: { error: 'invalid-permission-decision' } };
        }
        const params = entry.params as PermissionsRequestApprovalParams;
        const response: PermissionsRequestApprovalResponse =
          decision === 'accept' || decision === 'acceptForSession'
            ? {
                permissions: grantedFromRequested(params.permissions),
                scope: decision === 'acceptForSession' ? 'session' : 'turn',
              }
            : emptyPermissionGrant();
        resolveBrowser(entry, response);
        return { status: 200, body: { ok: true } };
      }

      if (payload['kind'] === 'elicitation') {
        if (entry.kind !== 'elicitation') {
          return { status: 409, body: { error: 'approval-request-kind-mismatch' } };
        }
        const action = payload['action'];
        if (!isElicitationAction(action)) {
          return { status: 400, body: { error: 'invalid-elicitation-action' } };
        }
        const params = entry.params as McpServerElicitationRequestParams;
        if (action === 'accept' && params.mode === 'form' && !isRecord(payload['values'])) {
          return { status: 400, body: { error: 'missing-elicitation-values' } };
        }
        resolveBrowser(entry, {
          action,
          content: action === 'accept' && isRecord(payload['values']) ? payload['values'] : null,
          _meta: null,
        });
        return { status: 200, body: { ok: true } };
      }

      return { status: 400, body: { error: 'unknown-approval-reply-kind' } };
    },
    handleServerRequestResolved(params) {
      if (!isRecord(params)) return;
      const threadId = params['threadId'];
      if (typeof threadId === 'string' && !isActiveThread(threadId)) {
        reportAbandonedThread(
          threadId,
          'serverRequestResolved',
          'serverRequest/resolved notification ignored for abandoned thread',
        );
        return;
      }
      const requestId = params['requestId'];
      if (!(typeof requestId === 'string' || typeof requestId === 'number')) return;
      const entry = pendingByCodexRequestKey.get(requestKey(requestId));
      if (!entry) return;
      removePending(entry);
      entry.resolve(DO_NOT_REPLY);
      publishResolved(entry);
    },
    abandonInactiveRequests() {
      const pending = Array.from(pendingByRequestId.values());
      for (const entry of pending) {
        if (isActiveThread(entry.threadId)) continue;
        removePending(entry);
        reportAbandonedThread(
          entry.threadId,
          'parkedApproval',
          'parked approval resolved after thread became inactive',
        );
        entry.resolve(safeSyntheticResponse(entry));
        publishResolved(entry);
      }
    },
    close() {
      const pending = Array.from(pendingByRequestId.values());
      for (const entry of pending) {
        removePending(entry);
        entry.resolve(safeSyntheticResponse(entry));
        publishResolved(entry);
      }
    },
  };
}
