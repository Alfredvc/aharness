/**
 * Per-state codex hook dispatcher factory.
 *
 * Spec: docs/specs/2026-05-08-per-state-hooks-design.md §5.6.
 *
 * One factory invocation per kind. Each returned function consumes a framed
 * UDS body (JSON, codex's snake_case wire form), runs the matched author
 * handlers against the active state, aggregates per-kind, and returns the
 * `OK <body>` reply for the framed UDS. Errors thrown by author handlers
 * propagate; in addition the dispatcher escalates the throw via
 * `setImmediate` so it bypasses the per-frame UDS try/catch in
 * `hookSocket.handleRequest` and fires as `uncaughtException` on the
 * daemon's process. The daemon's installed `process.on('uncaughtException')`
 * handler then writes a structured diagnostic to events.jsonl and calls
 * `onFatalError` (default `process.exit(1)`).
 */
import type { ActorHost } from './actorHost.js';
import type { ActiveThreadBinding } from './activeThreadBinding.js';
import type { DispatchResult } from './hookSocket.js';
import {
  cloneCanonicalCallbackData,
  payloadWithCanonicalCommit,
  prepareCanonicalEventCommit,
  runCanonicalEventReturn,
} from '../state/canonicalTransition.js';
import type { CanonicalEventMeta } from '../state/exits.js';
import type { AharnessOps } from '../state/aharnessOps.js';
import type {
  HookKind,
  PostToolUseDecision,
  PostToolUseEvent,
  PreToolUseDecision,
  PreToolUseEvent,
  ToolHookMatcher,
  UnmatchedHookHandler,
  UserPromptSubmitDecision,
  UserPromptSubmitEvent,
} from '../state/hooks.js';

export interface PerStateHookDispatcherInput {
  readonly kind: HookKind;
  readonly host: ActorHost;
  /**
   * Single active parent-thread binding. Used to tag `isSubThread` on
   * the event payload by comparing the wire `session_id` at dispatch time.
   */
  readonly activeThreadBinding: ActiveThreadBinding;
  /**
   * Called when an author handler throws. The dispatcher re-throws after
   * this returns so the daemon's uncaught-exception path can run; this
   * hook exists so the run's `events.jsonl` gets a structured diagnostic
   * with the state id + kind + matcher + error before the daemon exits
   * (spec §5.6 step 9 / §8). The callback itself MUST NOT throw —
   * the dispatcher does not wrap it in try/catch.
   */
  readonly onAuthorHandlerError?: (info: {
    readonly kind: HookKind;
    readonly stateId: string;
    readonly matcher: string | null;
    readonly error: Error;
  }) => void;
  readonly flushSnapshot?: (xstateSnapshot: unknown) => void;
  readonly ops?: AharnessOps;
  readonly writeFinalArtifacts?: (
    terminalStateId: string,
    context?: Record<string, unknown>,
  ) => Promise<void>;
  readonly isTerminalState?: (stateId: string) => boolean;
  readonly onTerminal?: (terminalStateId: string) => void;
  readonly onCanonicalEventError?: (info: CanonicalBuiltinEventErrorInfo) => void;
  readonly onAbandonedThreadDiagnostic?: (diagnostic: {
    readonly threadId: string;
    readonly source: string;
    readonly message: string;
  }) => void;
  readonly onCommittedTransition?: (info: {
    readonly from: string;
    readonly to: string;
    readonly oldThreadId?: string;
    readonly oldTurnId?: string;
  }) => void | Promise<void>;
}

export type PerStateHookDispatcher = (body: string) => Promise<DispatchResult>;

export type BuiltinHookEventName =
  | 'permissionRequest'
  | 'preToolUse'
  | 'postToolUse'
  | 'userPromptSubmit';

export type CanonicalBuiltinEventDispatchResult =
  | { readonly selected: false }
  | { readonly selected: true; readonly returnValue: unknown };

export interface CanonicalBuiltinEventErrorInfo {
  readonly eventName: BuiltinHookEventName;
  readonly stateId: string;
  readonly branchIndex: number;
  readonly phase: 'transition' | 'return';
  readonly error: Error;
}

export function createPerStateHookDispatcher(
  i: PerStateHookDispatcherInput,
): PerStateHookDispatcher {
  return async (body: string): Promise<DispatchResult> => {
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(body) as unknown;
      if (obj === null || typeof obj !== 'object') throw new Error('not an object');
      parsed = obj as Record<string, unknown>;
    } catch (e) {
      return {
        status: 'ERROR',
        body: JSON.stringify({ message: `bad ${i.kind} body: ${(e as Error).message}` }),
      };
    }

    const sessionId = typeof parsed['session_id'] === 'string' ? parsed['session_id'] : '';
    const turnId = typeof parsed['turn_id'] === 'string' ? parsed['turn_id'] : undefined;
    const committedTransitionSource = {
      ...(sessionId !== '' ? { oldThreadId: sessionId } : {}),
      ...(turnId !== undefined ? { oldTurnId: turnId } : {}),
    };
    if (sessionId !== '' && i.activeThreadBinding.isAbandoned(sessionId)) {
      i.onAbandonedThreadDiagnostic?.({
        threadId: sessionId,
        source: `hook:${i.kind}`,
        message: `${i.kind} hook frame ignored for abandoned thread`,
      });
      return { status: 'OK', body: '{}' };
    }

    const toolName = typeof parsed['tool_name'] === 'string' ? parsed['tool_name'] : '';

    // Sub-thread tagging.
    const isSubThread = sessionId !== '' && sessionId !== i.activeThreadBinding.require();

    // Look up author handlers on the active state.
    // Atomicity: serializeDispatch (daemon/serializeDispatch.ts) ensures no transition can fire between these host reads.
    const meta = i.host.currentMeta();
    if (!meta || meta.kind !== 'stateful') return { status: 'OK', body: '{}' };
    const stateHooks = meta.hooks;

    const ctx = i.host.currentContext();

    // Each handler call is wrapped so a thrown error is tagged with
    // its kind/stateId/matcher and reported to `onAuthorHandlerError`
    // before being re-thrown. Re-throwing preserves spec §8 / §5.6
    // step 9: the daemon's uncaught-exception path runs and the run
    // exits 1 — the callback exists only so the run's events.jsonl
    // carries a structured diagnostic.
    //
    // Why setImmediate: the per-frame UDS handler in
    // `hookSocket.ts::handleRequest` wraps the dispatcher call in
    // try/catch and converts any thrown error into an `ERROR` reply on
    // the wire. A plain re-throw therefore stays trapped inside the
    // framing layer and never reaches `process.on('uncaughtException')`
    // — the daemon would stay alive and silently absorb the bug. By
    // re-raising the same error from a `setImmediate` callback (a
    // fresh macrotask outside any try/catch), the throw escapes the
    // framing layer and triggers the daemon's installed
    // `uncaughtException` handler. Codex still sees `ERROR` on the
    // wire for that one turn (the synchronous re-throw also rejects
    // the in-flight Promise.all), but by the time codex's hook
    // timeout fires, the daemon will have exited and the WS will
    // close — which is the spec's intent.
    const stateId = i.host.currentStateId();
    const tagThrow = async <R>(matcher: string | null, run: () => R | Promise<R>): Promise<R> => {
      try {
        return await Promise.resolve(run());
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        i.onAuthorHandlerError?.({ kind: i.kind, stateId, matcher, error: err });
        // Escalate to the macrotask queue so the throw bypasses the
        // `hookSocket.handleRequest` try/catch and fires as
        // `uncaughtException` on the daemon's process. The daemon's
        // installed handler (see `daemon/main.ts`) logs and exits.
        setImmediate(() => {
          throw err;
        });
        throw err;
      }
    };

    if (i.kind === 'UserPromptSubmit') {
      // UserPromptSubmit has no toolName — reserved-tool guard not applicable.
      const event: UserPromptSubmitEvent = camelizeUserPromptSubmit(parsed, isSubThread, sessionId);
      const canonical = await dispatchCanonicalBuiltinEvent({
        host: i.host,
        eventName: 'userPromptSubmit',
        payload: event,
        ...(i.flushSnapshot !== undefined ? { flushSnapshot: i.flushSnapshot } : {}),
        ...(i.ops !== undefined ? { ops: i.ops } : {}),
        ...(i.writeFinalArtifacts !== undefined
          ? { writeFinalArtifacts: i.writeFinalArtifacts }
          : {}),
        ...(i.isTerminalState !== undefined ? { isTerminalState: i.isTerminalState } : {}),
        ...(i.onTerminal !== undefined ? { onTerminal: i.onTerminal } : {}),
        ...(i.onCanonicalEventError !== undefined
          ? { onCanonicalEventError: i.onCanonicalEventError }
          : {}),
        ...(i.onCommittedTransition !== undefined
          ? { onCommittedTransition: i.onCommittedTransition }
          : {}),
        committedTransitionSource,
      });
      if (canonical.selected) {
        return { status: 'OK', body: JSON.stringify(canonicalHookBody(canonical.returnValue)) };
      }

      const entries = stateHooks?.userPromptSubmit ?? [];
      if (entries.length === 0) return { status: 'OK', body: '{}' };
      const decisions = await Promise.all(
        entries.map(
          (e: UnmatchedHookHandler<unknown, UserPromptSubmitEvent, UserPromptSubmitDecision>) =>
            tagThrow(null, () => e.handler(ctx, event)),
        ),
      );
      return { status: 'OK', body: JSON.stringify(aggregateUserPromptSubmit(decisions)) };
    }

    if (i.kind === 'PreToolUse') {
      const event: PreToolUseEvent = camelizePreToolUse(parsed, isSubThread, sessionId);
      const canonical = await dispatchCanonicalBuiltinEvent({
        host: i.host,
        eventName: 'preToolUse',
        payload: event,
        ...(i.flushSnapshot !== undefined ? { flushSnapshot: i.flushSnapshot } : {}),
        ...(i.ops !== undefined ? { ops: i.ops } : {}),
        ...(i.writeFinalArtifacts !== undefined
          ? { writeFinalArtifacts: i.writeFinalArtifacts }
          : {}),
        ...(i.isTerminalState !== undefined ? { isTerminalState: i.isTerminalState } : {}),
        ...(i.onTerminal !== undefined ? { onTerminal: i.onTerminal } : {}),
        ...(i.onCanonicalEventError !== undefined
          ? { onCanonicalEventError: i.onCanonicalEventError }
          : {}),
        ...(i.onCommittedTransition !== undefined
          ? { onCommittedTransition: i.onCommittedTransition }
          : {}),
        committedTransitionSource,
      });
      if (canonical.selected) {
        return { status: 'OK', body: JSON.stringify(canonicalHookBody(canonical.returnValue)) };
      }

      const entries = stateHooks?.preToolUse ?? [];
      const matched = entries.filter((e) => testMatcher(e.matcher, toolName));
      if (matched.length === 0) return { status: 'OK', body: '{}' };
      const decisions = await Promise.all(
        matched.map((e: ToolHookMatcher<unknown, PreToolUseEvent, PreToolUseDecision>) =>
          tagThrow(e.matcher, () => e.handler(ctx, event)),
        ),
      );
      return { status: 'OK', body: JSON.stringify(aggregatePreToolUse(decisions)) };
    }

    // PostToolUse
    const event: PostToolUseEvent = camelizePostToolUse(parsed, isSubThread, sessionId);
    const canonical = await dispatchCanonicalBuiltinEvent({
      host: i.host,
      eventName: 'postToolUse',
      payload: event,
      ...(i.flushSnapshot !== undefined ? { flushSnapshot: i.flushSnapshot } : {}),
      ...(i.ops !== undefined ? { ops: i.ops } : {}),
      ...(i.writeFinalArtifacts !== undefined
        ? { writeFinalArtifacts: i.writeFinalArtifacts }
        : {}),
      ...(i.isTerminalState !== undefined ? { isTerminalState: i.isTerminalState } : {}),
      ...(i.onTerminal !== undefined ? { onTerminal: i.onTerminal } : {}),
      ...(i.onCanonicalEventError !== undefined
        ? { onCanonicalEventError: i.onCanonicalEventError }
        : {}),
      ...(i.onCommittedTransition !== undefined
        ? { onCommittedTransition: i.onCommittedTransition }
        : {}),
      committedTransitionSource,
    });
    if (canonical.selected) {
      return { status: 'OK', body: JSON.stringify(canonicalHookBody(canonical.returnValue)) };
    }

    const entries = stateHooks?.postToolUse ?? [];
    const matched = entries.filter((e) => testMatcher(e.matcher, toolName));
    if (matched.length === 0) return { status: 'OK', body: '{}' };
    const decisions = await Promise.all(
      matched.map((e: ToolHookMatcher<unknown, PostToolUseEvent, PostToolUseDecision>) =>
        tagThrow(e.matcher, () => e.handler(ctx, event)),
      ),
    );
    return { status: 'OK', body: JSON.stringify(aggregatePostToolUse(decisions)) };
  };
}

export async function dispatchCanonicalBuiltinEvent(i: {
  readonly host: ActorHost;
  readonly eventName: BuiltinHookEventName;
  readonly payload: unknown;
  readonly defaultReturn?: unknown;
  readonly flushSnapshot?: (xstateSnapshot: unknown) => void;
  readonly ops?: AharnessOps;
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
    readonly oldThreadId?: string;
    readonly oldTurnId?: string;
  }) => void | Promise<void>;
  readonly committedTransitionSource?: {
    readonly oldThreadId?: string;
    readonly oldTurnId?: string;
  };
}): Promise<CanonicalBuiltinEventDispatchResult> {
  const meta = i.host.currentMeta();
  if (!meta || meta.kind !== 'stateful') return { selected: false };
  const eventMeta = meta.canonicalEvents?.[i.eventName];
  if (eventMeta === undefined || eventMeta.eventKind !== i.eventName) {
    return { selected: false };
  }
  if (!canonicalBuiltinMatchPasses(i.eventName, eventMeta, i.payload)) {
    return { selected: false };
  }
  const selected = selectCanonicalEventBranch(eventMeta, i.host.currentContext(), i.payload);
  if (!selected.ok) {
    return { selected: false };
  }

  const defaultReturn =
    eventMeta.defaultReturn !== undefined ? eventMeta.defaultReturn : i.defaultReturn;
  const prepared = await prepareCanonicalEventCommit({
    meta: eventMeta as CanonicalEventMeta<Record<string, unknown>, unknown, unknown>,
    branchIndex: selected.index,
    context: i.host.currentContext(),
    payload: i.payload,
    ...(i.ops !== undefined ? { ops: i.ops } : {}),
  });
  if (!prepared.ok) {
    i.onCanonicalEventError?.({
      eventName: i.eventName,
      stateId: i.host.currentStateId(),
      branchIndex: selected.index,
      phase: 'transition',
      error: new Error(prepared.error),
    });
    return { selected: true, returnValue: defaultReturn };
  }

  const from = i.host.currentStateId();
  const commitPayload = payloadWithCanonicalCommit(i.payload, prepared.nextContext, selected.index);
  const resolvedTarget =
    selected.branch.to === undefined
      ? undefined
      : i.host.resolveTargetStateId(from, selected.branch.to);
  const prewrittenTerminalStateId =
    resolvedTarget !== undefined && isTerminalTarget(i.host, i.isTerminalState, resolvedTarget)
      ? resolvedTarget
      : undefined;
  if (prewrittenTerminalStateId !== undefined) {
    try {
      await i.writeFinalArtifacts?.(prewrittenTerminalStateId, prepared.nextContext);
    } catch (e) {
      i.onCanonicalEventError?.({
        eventName: i.eventName,
        stateId: i.host.currentStateId(),
        branchIndex: selected.index,
        phase: 'transition',
        error: normalizeError(e),
      });
      return { selected: true, returnValue: defaultReturn };
    }
  }
  i.host.commitEvent(i.eventName, commitPayload);
  const terminalStateId = currentTerminalStateId(i.host);
  if (terminalStateId !== undefined && terminalStateId !== prewrittenTerminalStateId) {
    try {
      await i.writeFinalArtifacts?.(terminalStateId, i.host.currentContext());
    } catch (e) {
      i.onCanonicalEventError?.({
        eventName: i.eventName,
        stateId: i.host.currentStateId(),
        branchIndex: selected.index,
        phase: 'transition',
        error: normalizeError(e),
      });
      return { selected: true, returnValue: defaultReturn };
    }
  }
  i.flushSnapshot?.(i.host.snapshot());
  const to = i.host.currentStateId();
  if (to !== from) {
    await i.onCommittedTransition?.({
      from,
      to,
      ...(i.committedTransitionSource?.oldThreadId !== undefined
        ? { oldThreadId: i.committedTransitionSource.oldThreadId }
        : {}),
      ...(i.committedTransitionSource?.oldTurnId !== undefined
        ? { oldTurnId: i.committedTransitionSource.oldTurnId }
        : {}),
    });
  }
  if (terminalStateId !== undefined) {
    i.onTerminal?.(terminalStateId);
  }

  if (selected.branch.return === undefined) {
    return { selected: true, returnValue: defaultReturn };
  }
  const returned = runCanonicalEventReturn({
    branch: selected.branch,
    context: i.host.currentContext(),
    payload: i.payload,
  });
  if (!returned.ok) {
    i.onCanonicalEventError?.({
      eventName: i.eventName,
      stateId: i.host.currentStateId(),
      branchIndex: selected.index,
      phase: 'return',
      error: new Error(returned.error),
    });
  }
  return { selected: true, returnValue: returned.ok ? returned.value : defaultReturn };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

function canonicalHookBody(value: unknown): unknown {
  return value === undefined ? {} : value;
}

function canonicalBuiltinMatchPasses(
  eventName: BuiltinHookEventName,
  meta: CanonicalEventMeta,
  payload: unknown,
): boolean {
  if (meta.match === undefined) return true;
  const matcher = meta.match;
  const values = canonicalMatchValues(eventName, payload);
  return values.some((value) => testMatcher(matcher, value));
}

function canonicalMatchValues(
  eventName: BuiltinHookEventName,
  payload: unknown,
): ReadonlyArray<string> {
  if (eventName === 'userPromptSubmit') return [];
  const toolName = stringProp(payload, 'toolName');
  if (eventName !== 'permissionRequest') return toolName === undefined ? [] : [toolName];
  const aliases = arrayProp(payload, 'matcherAliases');
  return [toolName, ...aliases].filter((value): value is string => value !== undefined);
}

function selectCanonicalEventBranch(
  meta: CanonicalEventMeta,
  context: Record<string, unknown>,
  payload: unknown,
):
  | {
      readonly ok: true;
      readonly index: number;
      readonly branch: NonNullable<CanonicalEventMeta['branches'][number]>;
    }
  | { readonly ok: false } {
  try {
    for (let index = 0; index < meta.branches.length; index++) {
      const branch = meta.branches[index];
      if (branch === undefined) continue;
      if (branch.predicate === undefined) return { ok: true, index, branch };
      if (branch.predicate(cloneCanonicalCallbackData(context), payload)) {
        return { ok: true, index, branch };
      }
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function stringProp(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' ? prop : undefined;
}

function arrayProp(value: unknown, key: string): ReadonlyArray<string> {
  if (value === null || typeof value !== 'object') return [];
  const prop = (value as Record<string, unknown>)[key];
  return Array.isArray(prop) ? prop.filter((item): item is string => typeof item === 'string') : [];
}

function testMatcher(matcher: string, toolName: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    return false;
  }
  return re.test(toolName);
}

// ─── camelization (snake_case wire → camelCase TS) ────────────────────────

function camelizeBaseEvent(
  p: Record<string, unknown>,
  isSubThread: boolean,
  sessionId: string,
): PreToolUseEvent {
  return {
    sessionId,
    cwd: stringField(p, 'cwd', ''),
    transcriptPath: typeof p['transcript_path'] === 'string' ? p['transcript_path'] : null,
    model: stringField(p, 'model', ''),
    permissionMode: stringField(
      p,
      'permission_mode',
      'default',
    ) as PreToolUseEvent['permissionMode'],
    turnId: stringField(p, 'turn_id', ''),
    toolName: stringField(p, 'tool_name', ''),
    toolUseId: stringField(p, 'tool_use_id', ''),
    toolInput: p['tool_input'] ?? null,
    triggeredAt: stringField(p, 'triggered_at', ''),
    isSubThread,
    ...(isSubThread ? { subThreadId: sessionId } : {}),
  };
}

function camelizePreToolUse(
  p: Record<string, unknown>,
  isSubThread: boolean,
  sessionId: string,
): PreToolUseEvent {
  return camelizeBaseEvent(p, isSubThread, sessionId);
}

function camelizePostToolUse(
  p: Record<string, unknown>,
  isSubThread: boolean,
  sessionId: string,
): PostToolUseEvent {
  return {
    ...camelizeBaseEvent(p, isSubThread, sessionId),
    toolResponse: p['tool_response'] ?? null,
  };
}

function camelizeUserPromptSubmit(
  p: Record<string, unknown>,
  isSubThread: boolean,
  sessionId: string,
): UserPromptSubmitEvent {
  return {
    sessionId,
    cwd: stringField(p, 'cwd', ''),
    transcriptPath: typeof p['transcript_path'] === 'string' ? p['transcript_path'] : null,
    model: stringField(p, 'model', ''),
    permissionMode: stringField(
      p,
      'permission_mode',
      'default',
    ) as UserPromptSubmitEvent['permissionMode'],
    turnId: stringField(p, 'turn_id', ''),
    prompt: stringField(p, 'prompt', ''),
    triggeredAt: stringField(p, 'triggered_at', ''),
    isSubThread,
    ...(isSubThread ? { subThreadId: sessionId } : {}),
  };
}

function stringField(p: Record<string, unknown>, key: string, dflt: string): string {
  const v = p[key];
  return typeof v === 'string' ? v : dflt;
}

// ─── aggregation ──────────────────────────────────────────────────────────

function aggregatePreToolUse(decisions: ReadonlyArray<PreToolUseDecision>): unknown {
  const denies: string[] = [];
  const asks: string[] = [];
  let suppressOutput: boolean | undefined;
  const systemMessages: string[] = [];
  for (const d of decisions) {
    if (d === undefined) continue;
    const out = d.hookSpecificOutput;
    if (out.permissionDecision === 'deny') {
      denies.push(out.permissionDecisionReason ?? '');
    } else if (out.permissionDecision === 'ask') {
      asks.push(out.permissionDecisionReason ?? '');
    }
    if (typeof d.suppressOutput === 'boolean') suppressOutput = d.suppressOutput;
    if (typeof d.systemMessage === 'string') systemMessages.push(d.systemMessage);
  }
  if (denies.length > 0) {
    const out: Record<string, unknown> = {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: denies.filter((s) => s.length > 0).join('\n\n'),
      },
    };
    if (suppressOutput !== undefined) out['suppressOutput'] = suppressOutput;
    if (systemMessages.length > 0) out['systemMessage'] = systemMessages.join('\n\n');
    return out;
  }
  if (asks.length > 0) {
    return {
      hookSpecificOutput: {
        permissionDecision: 'ask',
        permissionDecisionReason: asks.filter((s) => s.length > 0).join('\n\n'),
      },
    };
  }
  return {};
}

function aggregatePostToolUse(decisions: ReadonlyArray<PostToolUseDecision>): unknown {
  const blocks: string[] = [];
  const additionalContexts: string[] = [];
  for (const d of decisions) {
    if (d === undefined) continue;
    if ((d as { decision?: 'block' }).decision === 'block') {
      blocks.push((d as { reason: string }).reason);
    }
    const ctx = d.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) additionalContexts.push(ctx);
  }
  const out: Record<string, unknown> = {};
  if (blocks.length > 0) {
    out['decision'] = 'block';
    out['reason'] = blocks.filter((s) => s.length > 0).join('\n\n');
  }
  if (additionalContexts.length > 0) {
    out['hookSpecificOutput'] = { additionalContext: additionalContexts.join('\n\n') };
  }
  return out;
}

function aggregateUserPromptSubmit(decisions: ReadonlyArray<UserPromptSubmitDecision>): unknown {
  const additionalContexts: string[] = [];
  for (const d of decisions) {
    if (d === undefined) continue;
    const ctx = d.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) additionalContexts.push(ctx);
  }
  if (additionalContexts.length > 0) {
    return { hookSpecificOutput: { additionalContext: additionalContexts.join('\n\n') } };
  }
  return {};
}
