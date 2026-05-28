import type { CanonicalEventMeta, AharnessStateMeta } from '../state/exits.js';
import type { AharnessOps } from '../state/aharnessOps.js';
import {
  cloneCanonicalCallbackData,
  payloadWithCanonicalCommit,
  payloadWithCanonicalEmbeddedFinalCommit,
  prepareCanonicalEventCommit,
  runCanonicalEventReturn,
} from '../state/canonicalTransition.js';

import type { ActorHost } from './actorHost.js';

export interface CreateEventDispatcherOpts {
  readonly host: ActorHost;
  readonly flushSnapshot: (xstateSnapshot: unknown) => void;
  readonly ops?: AharnessOps;
  readonly onCanonicalEventError?: (info: CanonicalEventErrorInfo) => void;
  readonly isTerminalState?: (stateId: string) => boolean;
  readonly writeFinalArtifacts?: (
    terminalStateId: string,
    context?: Record<string, unknown>,
  ) => Promise<void>;
  readonly onTerminal?: (terminalStateId: string) => void;
  readonly onCommittedTransition?: (info: {
    readonly from: string;
    readonly to: string;
  }) => void | Promise<void>;
}

export interface CanonicalEventErrorInfo {
  readonly eventName: string;
  readonly stateId: string;
  readonly branchIndex: number;
  readonly phase: 'transition' | 'return';
  readonly error: Error;
}

export interface EventDispatchRequestDefaults {
  readonly request?: boolean;
  readonly defaultReturn?: unknown;
}

export interface EventDispatchResult {
  readonly handled: boolean;
  readonly stateChanged: boolean;
  readonly returnValue: unknown;
}

export type EventDispatcher = (
  eventName: string,
  payload: unknown,
  defaults?: EventDispatchRequestDefaults,
) => Promise<EventDispatchResult>;

export function createEventDispatcher(o: CreateEventDispatcherOpts): EventDispatcher {
  return (eventName, payload, defaults) => dispatch(o, eventName, payload, defaults);
}

async function dispatch(
  o: CreateEventDispatcherOpts,
  eventName: string,
  payload: unknown,
  defaults: EventDispatchRequestDefaults | undefined,
): Promise<EventDispatchResult> {
  const meta = currentStatefulMeta(o.host);
  const eventMeta = meta?.canonicalEvents?.[eventName] as
    | CanonicalEventMeta<Record<string, unknown>, unknown, unknown>
    | undefined;
  const defaultReturn =
    eventMeta?.request === true
      ? eventMeta.defaultReturn
      : defaults?.request === true
        ? defaults.defaultReturn
        : undefined;

  if (eventMeta === undefined) {
    return result(false, false, defaultReturn);
  }

  const selected = selectCanonicalEventBranch(eventMeta, o.host.currentContext(), payload);
  if (!selected.ok) {
    return result(false, false, defaultReturn);
  }

  const prepared = await prepareCanonicalEventCommit({
    meta: eventMeta,
    branchIndex: selected.index,
    context: o.host.currentContext(),
    payload,
    ...(o.ops !== undefined ? { ops: o.ops } : {}),
  });
  if (!prepared.ok) {
    o.onCanonicalEventError?.({
      eventName,
      stateId: o.host.currentStateId(),
      branchIndex: selected.index,
      phase: 'transition',
      error: new Error(prepared.error),
    });
    return result(false, false, defaultReturn);
  }

  const from = o.host.currentStateId();
  let commitPayload = payloadWithCanonicalCommit(payload, prepared.nextContext, selected.index);
  const embeddedPrepared = await o.host.prepareEmbeddedFinalCommit({
    sourceStateId: from,
    target: selected.branch.to,
    context: prepared.nextContext,
    event: { type: eventName, payload: commitPayload },
    ...(o.ops !== undefined ? { ops: o.ops } : {}),
  });
  if (!embeddedPrepared.ok) {
    return result(false, false, defaultReturn);
  }
  if (embeddedPrepared.matched) {
    commitPayload = payloadWithCanonicalEmbeddedFinalCommit(
      commitPayload,
      embeddedPrepared.nextContext,
    );
  }
  const finalContext = embeddedPrepared.matched
    ? embeddedPrepared.nextContext
    : prepared.nextContext;
  const resolvedTarget =
    selected.branch.to === undefined
      ? undefined
      : o.host.resolveTargetStateId(from, selected.branch.to);
  const prewrittenTerminalStateId =
    resolvedTarget !== undefined && isTerminalTarget(o.host, o.isTerminalState, resolvedTarget)
      ? resolvedTarget
      : undefined;
  if (prewrittenTerminalStateId !== undefined) {
    try {
      await o.writeFinalArtifacts?.(prewrittenTerminalStateId, finalContext);
    } catch (e) {
      if (eventMeta.request !== true) throw e;
      o.onCanonicalEventError?.({
        eventName,
        stateId: o.host.currentStateId(),
        branchIndex: selected.index,
        phase: 'transition',
        error: normalizeError(e),
      });
      return result(false, false, defaultReturn);
    }
  }
  o.host.commitEvent(eventName, commitPayload);
  const terminalStateId = currentTerminalStateId(o.host);
  if (terminalStateId !== undefined && terminalStateId !== prewrittenTerminalStateId) {
    try {
      await o.writeFinalArtifacts?.(terminalStateId, o.host.currentContext());
    } catch (e) {
      if (eventMeta.request !== true) throw e;
      o.onCanonicalEventError?.({
        eventName,
        stateId: o.host.currentStateId(),
        branchIndex: selected.index,
        phase: 'transition',
        error: normalizeError(e),
      });
      return result(true, o.host.currentStateId() !== from, defaultReturn);
    }
  }
  o.flushSnapshot(o.host.snapshot());
  const to = o.host.currentStateId();
  if (to !== from) {
    await o.onCommittedTransition?.({ from, to });
  }
  if (terminalStateId !== undefined) {
    o.onTerminal?.(terminalStateId);
  }

  const returnResult =
    selected.branch.return === undefined
      ? ({ ok: true, value: defaultReturn } as const)
      : runCanonicalEventReturn({
          branch: selected.branch,
          context: o.host.currentContext(),
          payload,
        });
  const returnValue = returnResult.ok ? returnResult.value : defaultReturn;
  if (!returnResult.ok) {
    o.onCanonicalEventError?.({
      eventName,
      stateId: o.host.currentStateId(),
      branchIndex: selected.index,
      phase: 'return',
      error: new Error(returnResult.error),
    });
  }
  return result(true, to !== from, returnValue);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function currentStatefulMeta(host: ActorHost): AharnessStateMeta | undefined {
  const meta = host.currentMeta();
  if (meta?.kind === 'stateful') return meta;
  return undefined;
}

function currentTerminalStateId(host: ActorHost): string | undefined {
  const meta = host.currentMeta();
  if (meta?.kind !== 'terminal') return undefined;
  const stateId = host.currentStateId();
  return stateId.length > 0 ? stateId : undefined;
}

function isTerminalTarget(
  host: ActorHost,
  override: ((stateId: string) => boolean) | undefined,
  stateId: string,
): boolean {
  if (override !== undefined) return override(stateId);
  return host.isTerminalState(stateId);
}

function selectCanonicalEventBranch(
  meta: CanonicalEventMeta<Record<string, unknown>, unknown, unknown>,
  context: Record<string, unknown>,
  payload: unknown,
):
  | {
      readonly ok: true;
      readonly index: number;
      readonly branch: NonNullable<
        CanonicalEventMeta<Record<string, unknown>, unknown, unknown>['branches'][number]
      >;
    }
  | { readonly ok: false } {
  try {
    for (let i = 0; i < meta.branches.length; i++) {
      const branch = meta.branches[i];
      if (!branch) continue;
      if (
        branch.predicate === undefined ||
        branch.predicate(cloneCanonicalCallbackData(context), payload)
      ) {
        return { ok: true, index: i, branch };
      }
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function result(
  handled: boolean,
  stateChanged: boolean,
  returnValue: unknown,
): EventDispatchResult {
  return { handled, stateChanged, returnValue };
}
