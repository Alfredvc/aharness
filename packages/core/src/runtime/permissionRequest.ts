import type { ActorHost } from './actorHost.js';
import { dispatchCanonicalBuiltinEvent } from './hookDispatchers.js';
import type { CanonicalBuiltinEventErrorInfo } from './hookDispatchers.js';
import type { ServerRequestMeta } from '../jsonrpc/client.js';
import type { HarnessOps } from '../state/harnessOps.js';
import type { PermissionRequestDecision, PermissionRequestEvent } from '../state/hooks.js';

export interface PermissionRequestResult {
  readonly decision: Exclude<PermissionRequestDecision, undefined>;
}

export interface PermissionRequestDispatcherInput {
  readonly host: ActorHost;
  readonly onAuthorHandlerError?: (info: {
    readonly stateId: string;
    readonly hookKind: 'PermissionRequest';
    readonly matcher: string;
    readonly error: Error;
  }) => void;
  readonly flushSnapshot?: (xstateSnapshot: unknown) => void;
  readonly ops?: HarnessOps;
  readonly writeFinalArtifacts?: (
    terminalStateId: string,
    context?: Record<string, unknown>,
  ) => Promise<void>;
  readonly isTerminalState?: (stateId: string) => boolean;
  readonly onTerminal?: (terminalStateId: string) => void;
  readonly onCanonicalEventError?: (info: CanonicalBuiltinEventErrorInfo) => void;
  readonly onCommittedTransition?: (info: {
    readonly from: string;
    readonly to: string;
    readonly oldTurnId?: string;
    readonly afterReply?: (callback: () => void | Promise<void>) => void;
  }) => void | Promise<void>;
}

export type PermissionRequestDispatcher = (
  event: PermissionRequestEvent,
  meta?: ServerRequestMeta,
) => Promise<PermissionRequestResult>;

export function createPermissionRequestDispatcher(
  input: PermissionRequestDispatcherInput,
): PermissionRequestDispatcher {
  return async (event, serverMeta) => {
    const stateMeta = input.host.currentMeta();
    if (!stateMeta || stateMeta.kind !== 'stateful') return { decision: 'delegate' };

    const canonical = await dispatchCanonicalBuiltinEvent({
      host: input.host,
      eventName: 'permissionRequest',
      payload: event,
      defaultReturn: 'delegate',
      ...(input.flushSnapshot !== undefined ? { flushSnapshot: input.flushSnapshot } : {}),
      ...(input.ops !== undefined ? { ops: input.ops } : {}),
      ...(input.writeFinalArtifacts !== undefined
        ? { writeFinalArtifacts: input.writeFinalArtifacts }
        : {}),
      ...(input.isTerminalState !== undefined ? { isTerminalState: input.isTerminalState } : {}),
      ...(input.onTerminal !== undefined ? { onTerminal: input.onTerminal } : {}),
      ...(input.onCanonicalEventError !== undefined
        ? { onCanonicalEventError: input.onCanonicalEventError }
        : {}),
      ...(input.onCommittedTransition !== undefined
        ? {
            onCommittedTransition: (info) =>
              input.onCommittedTransition?.({
                ...info,
                oldTurnId: event.turnId,
                ...(serverMeta !== undefined
                  ? { afterReply: serverMeta.afterReply.bind(serverMeta) }
                  : {}),
              }),
          }
        : {}),
    });
    if (canonical.selected) {
      return { decision: normalizeDecision(canonical.returnValue) };
    }

    const entries = stateMeta.hooks?.permissionRequest ?? [];
    if (entries.length === 0) return { decision: 'delegate' };

    const matched = entries.filter((entry) => matches(entry.matcher, event));
    if (matched.length === 0) return { decision: 'delegate' };

    const stateId = input.host.currentStateId();
    const ctx = input.host.currentContext();
    const decisions = await Promise.all(
      matched.map(async (entry) => {
        try {
          return await entry.handler(ctx, event);
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          input.onAuthorHandlerError?.({
            stateId,
            hookKind: 'PermissionRequest',
            matcher: entry.matcher,
            error,
          });
          return 'cancel' as const;
        }
      }),
    );

    return { decision: aggregate(decisions) };
  };
}

function normalizeDecision(value: unknown): Exclude<PermissionRequestDecision, undefined> {
  if (
    value === 'accept' ||
    value === 'acceptForSession' ||
    value === 'decline' ||
    value === 'cancel' ||
    value === 'delegate'
  ) {
    return value;
  }
  return 'delegate';
}

function matches(matcher: string, event: PermissionRequestEvent): boolean {
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    return false;
  }
  return [event.toolName, ...event.matcherAliases].some((value) => re.test(value));
}

function aggregate(
  decisions: ReadonlyArray<PermissionRequestDecision>,
): Exclude<PermissionRequestDecision, undefined> {
  if (decisions.includes('cancel')) return 'cancel';
  if (decisions.includes('decline')) return 'decline';
  if (decisions.includes('acceptForSession')) return 'acceptForSession';
  if (decisions.includes('accept')) return 'accept';
  return 'delegate';
}
