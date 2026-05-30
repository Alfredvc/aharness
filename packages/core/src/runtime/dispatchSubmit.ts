/**
 * Phase 1 + 2a + 2b + 2c submit dispatcher — server-side handler for the codex
 * `item/tool/call` server-request that routes to the aharness
 * `aharness_submit` dynamic tool. Sole-WS-client topology: no MCP child,
 * no per-run UDS framing.
 *
 * Phase-1 scope (headless transport backbone, plan
 * `2026-05-12-headless-phase-1a-transport-backbone.md`):
 *   - Self-loop submits → reply terse `'ok'`.
 *   - Terminal submits → reply `Run complete. Terminal: <outcome>.` and
 *     fire `onTerminal`.
 *   - Off-state / off-exit / schema-fail paths return structured
 *     `success: false` replies — the actor is never mutated.
 *
 * Phase-2a scope (cross-state turn-end dance, plan
 * `2026-05-12-headless-phase-2a-cross-state.md`):
 *   - Cross-state submits commit + flush + log the transition, then
 *     dispatch the four-step turn-end dance via
 *     `scheduleCrossStateDance` with the FULL composed nudge for the
 *     new state (`composeActiveStateNudge` callback) and reply terse
 *     `'ok'`. The dance: register `item/completed` watcher → reply
 *     → await match → `turn/interrupt` → `turn/start({input: <nudge>})`.
 *
 * Phase-2b scope (owner-yield + await exits, plan
 * `2026-05-13-headless-phase-2b-owner-yield.md`):
 *   - `await` exits — `composeActiveStateNudge` emits the
 *     `request_user_input` preamble for any state whose meta declares
 *     `awaitsOwnerText`, and `awaitResolver` (wired in `runCli.ts`)
 *     fires the synthesized `AWAIT__<state>__<exit>` transition when
 *     codex returns the matching `function_call_output`.
 *   - The Phase-2a awaitsOwnerText-target guard is lifted —
 *     cross-state targets that declare `awaitsOwnerText` follow the
 *     same dance path as non-yielding states.
 *
 * State-entry scope:
 *   - submit-driven state entry awaits `onEntry` after the transition
 *     snapshot flush before any success reply can leave the handler.
 *
 * Out of scope for this dispatcher layer:
 *   - Per-state hooks + embed-runtime regression (Phase 2d).
 *   - Browser HTTP+SSE UI substrate (Phase 3).
 *   - Approvals (Phase 4).
 *
 * Wire shapes (Task 4 / commit 18cfa697): codex's `DynamicToolCallParams`
 * is camelCase (`threadId`, `turnId`, `callId`, `tool`, `arguments`);
 * responses use `contentItems` with the `{type: 'inputText', text}`
 * variant.
 *
 * R6 atomicity contract ("snapshot persisted ⇔ model saw success
 * reply"):
 *   1. commit  — `host.commitSubmit` advances the actor synchronously.
 *   2. flush   — `flushSnapshot(host.snapshot())` is synchronous; bytes
 *                durable on disk before any reply leaves the handler.
 *   3. log     — `onTransition?({from, exit, to})` fires for the stdout
 *                UI sink (Phase 1b Task 12).
 *   4. signal  — `onTerminal?(stateId)` fires synchronously for terminal
 *                targets so the §5.6 shutdown can arm.
 *   5. entry   — awaited `onEntry` before any success reply leaves the
 *                handler.
 *   6. schedule — cross-state targets: `composeActiveStateNudge()`
 *                 (reads the post-commit live host) → synchronous call
 *                 to `scheduleCrossStateDance`, which registers the
 *                 watcher synchronously before returning.
 *   7. reply   — terse `'ok'` for self-loop and cross-state, terminal
 *                 text for terminal.
 */
import type { AnyStateMachine } from 'xstate';

import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import { SUBMIT_TOOL_NAME } from '../protocol/submitTool.js';
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  JsonValue,
} from '../protocol/types.js';
import type { ServerRequestMeta } from '../jsonrpc/client.js';
import type { AharnessMeta, AharnessStateMeta, RunCtx, SchemaSidecar } from '../types.js';
import type { AharnessOps } from '../state/aharnessOps.js';
import {
  cloneCanonicalCallbackData,
  payloadWithCanonicalCommit,
  payloadWithCanonicalEmbeddedFinalCommit,
  payloadWithCanonicalSelectedBranch,
  prepareCanonicalSubmitCommit,
} from '../state/canonicalTransition.js';

import type { ActorHost } from './actorHost.js';
import { resolveEntryPrompt } from './resolvePrompt.js';

export interface CreateSubmitDispatcherOpts {
  readonly host: ActorHost;
  /** The machine the host wraps; used to walk `iterStates` for the
   * projected next state's meta (the host's `currentMeta()` reflects
   * the live actor, but the dispatcher needs to read the *projected*
   * next state's meta before committing). */
  readonly machine: AnyStateMachine;
  readonly sidecar: SchemaSidecar;
  /**
   * Flush callback. Caller closes over `runDir.snapshotPath`, `threadId`,
   * and `aharnessSubmitToolName: 'aharness_submit'` and calls
   * `flushHeadlessSnapshotEnvelope` internally. The dispatcher passes only the
   * actor snapshot (`host.snapshot()`) because it does not know its own
   * threadId. See Phase 1b Task 17 step 11 for the closure shape.
   *
   * Synchronous-only: the dispatcher relies on bytes-on-disk before the
   * success reply returns.
   */
  readonly flushSnapshot: (xstateSnapshot: unknown) => void;
  /**
   * Terminal-detection callback. Invoked synchronously inside the
   * success path *before* the reply returns when the projected new leaf
   * is a terminal state, so the §5.6 shutdown sequence can run AFTER
   * the reply has been sent (the reply is what tells the model the FSM
   * advanced).
   */
  readonly onTerminal?: (terminalStateId: string, meta?: ServerRequestMeta) => void;
  /**
   * Optional hook to apply pending state-level model settings before
   * issuing the post-submit `turn/start` for a cross-state transition.
   */
  readonly applyStateModel?: () => Promise<void>;
  /**
   * Stdout-UI transition log hook (Phase 1b Task 12). Invoked
   * synchronously after commit + flush, before the reply returns, on
   * any successful transition.
   */
  readonly onTransition?: (info: { from: string; exit: string; to: string }) => void;
  /**
   * Phase 2a: schedule the cross-state turn-end dance for a submit
   * whose target is a different stateful state. Invoked synchronously
   * AFTER commit + flush + `onTransition`, BEFORE the reply returns —
   * the dance's watcher registration must complete before the reply
   * leaves the handler (otherwise codex's `item/completed` could land
   * before the watcher exists). The callable is responsible for
   * `markSubmittedThisTurn` and the four-step sequence (`await match
   * → turn/interrupt → turn/start({input: <orientationText>})`).
   *
   * When omitted, cross-state branches throw
   * `Error('crossStateDance not wired')` — the failure surface stays
   * loud for misconfigured test setups.
   */
  readonly scheduleCrossStateDance?: (args: {
    readonly threadId: string;
    readonly turnId: string;
    readonly callId: string;
    readonly orientationText: string;
    readonly applyStateModel?: () => Promise<void>;
  }) => void;
  /**
   * Slice 4 fresh-clear scheduling: when a committed non-self submit
   * enters a state whose meta declares `clearOnEntry`, schedule a
   * replacement parent thread after the submit response has been sent.
   * The fresh-clear scheduler owns thread interruption/unsubscribe and
   * replacement `turn/start`; the legacy cross-state dance is skipped.
   */
  readonly scheduleFreshClear?: (args: {
    readonly from: string;
    readonly to: string;
    readonly oldThreadId: string;
    readonly oldTurnId?: string;
    readonly afterReply: (callback: () => void | Promise<void>) => void;
  }) => void;
  /**
   * Phase 2a: compose the FULL nudge for the active (post-commit) state
   * — header (`[aharness] Now in state "<id>"`), schema-rendered valid
   * exits, resolved `entryPrompt`, optional `awaitsOwnerText` preamble,
   * optional `stopGuidance`. Same shape `driveForward`'s default branch
   * sends. Invoked AFTER `host.commitSubmit` so the closure reads the
   * live host (which has advanced to the new leaf).
   *
   * NOT invoked for self-loop or terminal targets. When omitted and a
   * cross-state branch fires, the dispatcher throws
   * `Error('composeActiveStateNudge not wired')`.
   */
  readonly composeActiveStateNudge?: () => string;
  /**
   * Run the active state's author `onEntry` hook after the transition
   * snapshot flush but before terminal/cross-state success side-effects
   * and before returning a success reply.
   */
  readonly runOnEntry?: () => Promise<void>;
  readonly ops?: AharnessOps;
  readonly writeFinalArtifacts?: (
    terminalStateId: string,
    context?: Record<string, unknown>,
  ) => Promise<void>;
}

export type SubmitDispatcher = (
  params: DynamicToolCallParams,
  meta?: ServerRequestMeta,
) => Promise<DynamicToolCallResponse>;

/**
 * Build a submit dispatcher closed over one run's host + sidecar. The
 * returned function is the JSON-RPC server-request handler the runtime
 * registers for `item/tool/call` whose `tool === 'aharness_submit'`.
 */
export function createSubmitDispatcher(o: CreateSubmitDispatcherOpts): SubmitDispatcher {
  return (
    params: DynamicToolCallParams,
    serverMeta?: ServerRequestMeta,
  ): Promise<DynamicToolCallResponse> => dispatch(o, params, serverMeta);
}

async function dispatch(
  o: CreateSubmitDispatcherOpts,
  params: DynamicToolCallParams,
  serverMeta: ServerRequestMeta | undefined,
): Promise<DynamicToolCallResponse> {
  // Defensive: the runtime only routes `aharness_submit` to this handler,
  // but reject anything else with a clear internal error to avoid silent
  // misrouting.
  if (params.tool !== SUBMIT_TOOL_NAME) {
    return errReply(
      `internal: unexpected tool name '${params.tool}' on submit handler (expected '${SUBMIT_TOOL_NAME}')`,
    );
  }

  // Step 1: parse arguments. `arguments` is `JsonValue` — accept either
  // a JSON string (the common wire form when the model emits a function
  // call) or an already-parsed object/value.
  const parseResult = parseArguments(params.arguments);
  if (!parseResult.ok) return errReply(parseResult.message);
  const { state, exit, data } = parseResult.value;

  // Step 2: off-state guard.
  const cur = o.host.currentStateId();
  if (state !== cur) {
    return errReply(
      `Off-state submit. Current state is '${cur}'; you submitted for '${state}'. Re-call submit with state='${cur}'.`,
    );
  }

  // Step 3: off-exit guard. The current leaf must be stateful (the
  // verifier guarantees this for any state the submit tool can target,
  // but a defensive check costs nothing and surfaces a clear error if
  // the verifier is bypassed).
  const meta = currentStatefulMeta(o.host);
  if (!meta) {
    return errReply(
      `Internal aharness error: state '${cur}' is not stateful and has no submit exits.`,
    );
  }
  const exitDef = meta.exits[exit];
  if (!exitDef || exitDef.kind !== 'submit') {
    const validSubmitExits = Object.entries(meta.exits)
      .filter(([, def]) => def.kind === 'submit')
      .map(([name]) => `"${name}"`)
      .join(', ');
    return errReply(
      `Off-exit submit. State '${cur}' has no submit exit named '${exit}'. ` +
        `Valid submit exits: ${validSubmitExits || '(none)'}.`,
    );
  }

  // Step 4: schema validation.
  const sidecarEntry = o.sidecar[cur]?.[exit];
  if (!sidecarEntry) {
    return errReply(`Internal aharness error: no schema sidecar entry for (${cur}, ${exit}).`);
  }
  const validation = sidecarEntry.validate(data);
  if (!validation.ok) {
    const lines = validation.errors
      .map((e) => `  - ${humanizeAjvPath(e.path)} ${e.message}`)
      .join('\n');
    return errReply(`Schema validation failed:\n${lines}`);
  }

  // Step 5: dry-run + projected orientation/posture resolution. If
  // either step throws, the actor has not been mutated and we surface
  // an error reply.
  let commitPayload: unknown = validation.data;
  let dryRunPayload: unknown = validation.data;
  let nextContextForOrientation: Record<string, unknown> | undefined;
  let selectedBranchIndex: number | undefined;
  let selectedTarget: string | undefined;
  const canonicalSubmit = exitDef.__aharnessCanonical;
  if (canonicalSubmit?.kind === 'submit') {
    const selected = selectCanonicalSubmitBranch(
      canonicalSubmit,
      o.host.currentContext(),
      validation.data,
    );
    if (!selected.ok) {
      return errReply(
        `Canonical transition failed before commit for (${cur}, ${exit}): ${selected.error}. Submit not applied.`,
      );
    }
    selectedBranchIndex = selected.index;
    selectedTarget = targetForSubmitExit(exitDef, selected.index);
    dryRunPayload = payloadWithCanonicalSelectedBranch(validation.data, selected.index);
  } else {
    selectedTarget = targetForSubmitExit(exitDef);
  }

  const dry = o.host.dryRunSubmit(cur, exit, dryRunPayload);
  if (!dry.ok) {
    return errReply(
      `Internal aharness error during transition projection for (${cur}, ${exit}): ` +
        `${dry.error}. Submit not applied.`,
    );
  }
  nextContextForOrientation = dry.nextContext;

  if (canonicalSubmit?.kind === 'submit' && selectedBranchIndex !== undefined) {
    const selectedBranch = canonicalSubmit.branches[selectedBranchIndex];
    const prepared = await prepareCanonicalSubmitCommit({
      meta: canonicalSubmit,
      branchIndex: selectedBranchIndex,
      context: selectedBranch?.hasActions === true ? dry.nextContext : o.host.currentContext(),
      payload: validation.data,
      ...(o.ops !== undefined ? { ops: o.ops } : {}),
    });
    if (!prepared.ok) {
      return errReply(
        `Canonical transition failed before commit for (${cur}, ${exit}): ${prepared.error}. Submit not applied.`,
      );
    }
    commitPayload = payloadWithCanonicalCommit(
      validation.data,
      prepared.nextContext,
      selectedBranchIndex,
    );
    nextContextForOrientation = prepared.nextContext;
  }
  const embeddedPrepared = await o.host.prepareEmbeddedFinalCommit({
    sourceStateId: cur,
    target: selectedTarget,
    context: nextContextForOrientation,
    event: {
      type: `SUBMIT__${cur}__${exit}`,
      payload: commitPayload,
    },
    ...(o.ops !== undefined ? { ops: o.ops } : {}),
  });
  if (!embeddedPrepared.ok) {
    return errReply(
      `Canonical embedded final failed before commit for (${cur}, ${exit}): ${embeddedPrepared.error}. Submit not applied.`,
    );
  }
  if (embeddedPrepared.matched) {
    commitPayload = payloadWithCanonicalEmbeddedFinalCommit(
      commitPayload,
      embeddedPrepared.nextContext,
    );
    nextContextForOrientation = embeddedPrepared.nextContext;
  }
  const orientation = resolveOrientationForNextState({
    machine: o.machine,
    nextStateId: dry.nextStateId,
    nextContext: nextContextForOrientation,
  });
  if (!orientation.ok) {
    return errReply(
      `Internal aharness error while computing orientation for state '${dry.nextStateId}': ` +
        `${orientation.error}. Submit not applied.`,
    );
  }
  // Passive states are valid framework-owned transient/effect states,
  // but only when the state itself owns an invoked async transition that
  // settles before the model gets another turn. Plain passive submit
  // targets are still rejected: they have no exits to advertise, so the
  // model would have nothing to submit on the next turn.
  if (orientation.isPassive) {
    if (passiveTargetHasInvoke(o.machine, dry.nextStateId)) {
      o.host.commitSubmit(cur, exit, commitPayload);
      await o.host.waitForSnapshot(() => o.host.currentMeta()?.kind !== 'passive');
      const settledStateId = o.host.currentStateId();
      const settledMeta = o.host.currentMeta();
      if (!settledMeta || settledMeta.kind !== 'terminal') {
        return errReply(
          `Internal aharness error: passive submit target '${dry.nextStateId}' settled ` +
            `at non-terminal state '${settledStateId}'. Submit was applied.`,
        );
      }
      const artifactResult = await writeFinalArtifacts(o, settledStateId);
      if (!artifactResult.ok) return errReply(artifactResult.message);
      o.flushSnapshot(o.host.snapshot());
      o.onTransition?.({ from: cur, exit, to: settledStateId });
      callOnTerminal(o, settledStateId, serverMeta);
      return {
        success: true,
        contentItems: [
          { type: 'inputText', text: `Run complete. Terminal: ${settledMeta.outcome}.` },
        ],
      };
    }
    return errReply(
      `Submit rejected: exit '${exit}' on state '${cur}' targets state ` +
        `'${dry.nextStateId}', which is passive. Passive states have no exits and ` +
        `cannot be submit targets. This is an authoring error in the FSM — submit ` +
        `not applied.`,
    );
  }

  const isSelfLoop = dry.nextStateId === cur;
  const isCrossState = !isSelfLoop && !orientation.isTerminal;

  if (orientation.isTerminal) {
    const artifactResult = await writeFinalArtifacts(o, dry.nextStateId, nextContextForOrientation);
    if (!artifactResult.ok) return errReply(artifactResult.message);
  }

  // Step 6a: commit. Synchronous in XState v5.
  o.host.commitSubmit(cur, exit, commitPayload);

  // Step 6b: synchronous snapshot flush of the transition. Bytes are
  // on-disk before any reply leaves the handler (R6).
  o.flushSnapshot(o.host.snapshot());

  // Step 6c: transition log (stdout UI sink, Phase 1b).
  o.onTransition?.({ from: cur, exit, to: dry.nextStateId });

  // Step 6c.2: state-entry hook. This runs after the durable transition
  // snapshot and before terminal/cross-state scheduling or the success
  // reply.
  if (o.runOnEntry !== undefined) {
    await o.runOnEntry();
  }

  // Step 6d: terminal signalling — fire the callback BEFORE the reply
  // returns; the callback arms the shutdown sequence, the actual
  // shutdown work runs after the reply.
  if (orientation.isTerminal) {
    callOnTerminal(o, dry.nextStateId, serverMeta);
  }

  // Step 6e (Phase 2a): cross-state targets dispatch the turn-end
  // dance. Compose the full new-state nudge — composed AFTER commit so
  // the closure reads the live host at the new leaf — then schedule
  // the dance synchronously. The dance registers its watcher BEFORE
  // returning, so the watcher exists before the reply leaves the
  // handler (matching the §4.3.3 step 2 ordering invariant). Self-loop
  // and terminal paths skip both calls; drive-forward's default
  // branch re-orients the model for self-loop continuations.
  if (isCrossState) {
    if (currentStateDeclaresClearOnEntry(o.host)) {
      if (!o.scheduleFreshClear) {
        throw new Error('freshClear not wired');
      }
      o.scheduleFreshClear({
        from: cur,
        to: dry.nextStateId,
        oldThreadId: params.threadId,
        oldTurnId: params.turnId,
        afterReply: (callback) => {
          if (serverMeta !== undefined) {
            serverMeta.afterReply(callback);
          } else {
            void Promise.resolve().then(callback);
          }
        },
      });
      return { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] };
    }
    if (!o.composeActiveStateNudge) {
      throw new Error('composeActiveStateNudge not wired');
    }
    // F2 defense-in-depth: a throw between flush (R6 durable) and reply
    // would break R6 (snapshot persisted but model sees an error
    // envelope). Wrap the compose call so any throw becomes a fallback
    // nudge string; the cross-state path still reaches scheduleCross-
    // StateDance and still replies 'ok'. The fallback text mirrors the
    // shape used by `composeActiveStateNudge`'s own in-house catches at
    // `runCli.ts:584,596` so log scrubbers treat both cases the same.
    let nudge: string;
    try {
      nudge = o.composeActiveStateNudge();
    } catch (e) {
      nudge = `(aharness: error composing nudge for state '${dry.nextStateId}': ${(e as Error).message})`;
    }
    if (!o.scheduleCrossStateDance) {
      throw new Error('crossStateDance not wired');
    }
    const crossStateArgs: {
      threadId: string;
      turnId: string;
      callId: string;
      orientationText: string;
      applyStateModel?: () => Promise<void>;
    } = {
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      orientationText: nudge,
    };
    if (o.applyStateModel !== undefined) {
      crossStateArgs.applyStateModel = o.applyStateModel;
    }
    o.scheduleCrossStateDance(crossStateArgs);
  }

  // Step 6f: build the success reply. Terminal preserves the legacy
  // `Run complete. Terminal: <outcome>.` text; self-loop and
  // cross-state reply terse `'ok'`.
  const replyText = orientation.isTerminal
    ? `Run complete. Terminal: ${orientation.terminalOutcome ?? 'success'}.`
    : 'ok';
  return { success: true, contentItems: [{ type: 'inputText', text: replyText }] };
}

// --- orientation resolution ---------------------------------------------

interface OrientationOk {
  readonly ok: true;
  readonly orientationText: string;
  readonly isTerminal: boolean;
  readonly isAwaitsOwnerText: boolean;
  readonly isPassive: boolean;
  readonly terminalOutcome?: string;
}
interface OrientationErr {
  readonly ok: false;
  readonly error: string;
}
type OrientationResult = OrientationOk | OrientationErr;

/**
 * Walk `iterStates` to find the projected next state's aharness meta and
 * resolve its orientation. Passive states ARE valid resting points in
 * general (reached via XState `always`/`entry` transitions), but they
 * cannot be SUBMIT TARGETS — a passive leaf has no exits to advertise,
 * so the model would have nothing to submit on the next turn. This
 * resolver's job is to flag passive targets so the dispatcher can reject
 * the submit before commit.
 *
 *   - `'stateful'` → resolve `entryPrompt` (string-or-function); detect
 *     `awaitsOwnerText` (Phase 2 boundary).
 *   - `'terminal'` → orientation text and `terminalOutcome` carried
 *     through for the reply.
 *   - `'passive'`  → empty orientation with `isPassive: true`; the
 *     dispatcher rejects the submit BEFORE commit.
 *   - missing meta → empty orientation; the verifier should have
 *     prevented this but the dispatcher does not block on it.
 *
 * Errors from a function-form `entryPrompt` propagate as
 * `{ ok: false }` so the dispatcher can refuse the submit before commit.
 */
function resolveOrientationForNextState(args: {
  readonly machine: AnyStateMachine;
  readonly nextStateId: string;
  readonly nextContext: Record<string, unknown>;
}): OrientationResult {
  if (args.nextStateId === '') {
    return {
      ok: true,
      orientationText: '',
      isTerminal: false,
      isAwaitsOwnerText: false,
      isPassive: false,
    };
  }
  const meta = lookupAharnessMetaByPath(args.machine, args.nextStateId);
  if (!meta) {
    return {
      ok: true,
      orientationText: '',
      isTerminal: false,
      isAwaitsOwnerText: false,
      isPassive: false,
    };
  }
  if (meta.kind === 'terminal') {
    return {
      ok: true,
      orientationText: `Run complete. Terminal: ${meta.outcome}.`,
      isTerminal: true,
      isAwaitsOwnerText: false,
      isPassive: false,
      terminalOutcome: meta.outcome,
    };
  }
  if (meta.kind === 'passive') {
    return {
      ok: true,
      orientationText: '',
      isTerminal: false,
      isAwaitsOwnerText: false,
      isPassive: true,
    };
  }
  // Stateful (the remaining discriminant after terminal/passive above).
  try {
    const text = resolveEntryPrompt(meta.entryPrompt, args.nextContext as RunCtx);
    return {
      ok: true,
      orientationText: text,
      isTerminal: false,
      isAwaitsOwnerText: meta.awaitsOwnerText !== undefined,
      isPassive: false,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Walk the machine's state tree to find the aharness meta for `targetPath`.
 * Returns `undefined` when not found.
 */
function lookupAharnessMetaByPath(
  machine: AnyStateMachine,
  targetPath: string,
): AharnessMeta | undefined {
  for (const node of iterStates(machine)) {
    if (stateKeyPath(node) === targetPath) {
      return getAharnessMeta(node);
    }
  }
  return undefined;
}

function passiveTargetHasInvoke(machine: AnyStateMachine, targetPath: string): boolean {
  for (const node of iterStates(machine)) {
    if (stateKeyPath(node) !== targetPath) continue;
    return node.config.invoke !== undefined;
  }
  return false;
}

// --- helpers ------------------------------------------------------------

interface ParsedSubmitArgs {
  readonly state: string;
  readonly exit: string;
  readonly data: unknown;
}

type ParseResult =
  | { readonly ok: true; readonly value: ParsedSubmitArgs }
  | { readonly ok: false; readonly message: string };

/**
 * Parse `DynamicToolCallParams.arguments` into the dispatcher's
 * `{state, exit, data}` shape. Accepts either a JSON string or an
 * already-parsed object; both are valid `JsonValue` shapes.
 */
function parseArguments(raw: JsonValue): ParseResult {
  let value: unknown;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        message: `Failed to parse submit arguments as JSON: ${(e as Error).message}.`,
      };
    }
  } else {
    value = raw;
  }
  if (value === null || typeof value !== 'object') {
    return {
      ok: false,
      message: 'submit arguments must be an object with "state", "exit", and "data" fields.',
    };
  }
  const obj = value as Record<string, unknown>;
  const stateField = obj['state'];
  const exitField = obj['exit'];
  if (typeof stateField !== 'string' || typeof exitField !== 'string') {
    return {
      ok: false,
      message: 'submit arguments must include string "state" and "exit" discriminators.',
    };
  }
  // Mirror the outer-arg leniency for `data`: codex tool routing
  // sometimes round-trips function-call args as JSON strings (model-side
  // serialization quirk; the wire payload is `JsonValue` so a string
  // here is type-legal). Decode opportunistically — if the string is
  // not valid JSON, leave it as-is and let downstream schema validation
  // produce the user-facing error.
  let dataField: unknown = obj['data'];
  if (typeof dataField === 'string') {
    try {
      dataField = JSON.parse(dataField);
    } catch {
      // not JSON — pass through; schema validation will reject.
    }
  }
  return { ok: true, value: { state: stateField, exit: exitField, data: dataField } };
}

/**
 * Render an Ajv `instancePath` (JSON Pointer like `/foo/bar/0` or `''`
 * for root) as a human-readable dotted path rooted at `data`.
 */
function humanizeAjvPath(instancePath: string): string {
  if (instancePath === '') return 'data';
  const segments = instancePath.split('/').slice(1); // drop leading ''
  let out = 'data';
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
    } else {
      out += `.${seg.replace(/~1/g, '/').replace(/~0/g, '~')}`;
    }
  }
  return out;
}

/**
 * Read the current leaf's `AharnessStateMeta` if and only if the leaf is
 * stateful. Returns `undefined` for terminal/passive/missing meta — the
 * dispatcher has no business advancing those.
 */
function currentStatefulMeta(host: ActorHost): AharnessStateMeta | undefined {
  const meta = host.currentMeta();
  if (meta?.kind === 'stateful') return meta;
  return undefined;
}

function currentStateDeclaresClearOnEntry(host: ActorHost): boolean {
  const meta = currentStatefulMeta(host);
  return meta !== undefined && Object.prototype.hasOwnProperty.call(meta, 'clearOnEntry');
}

function errReply(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: 'inputText', text }] };
}

function selectCanonicalSubmitBranch(
  meta: NonNullable<AharnessStateMeta['exits'][string]['__aharnessCanonical']> & {
    kind: 'submit';
  },
  context: Record<string, unknown>,
  payload: unknown,
): { readonly ok: true; readonly index: number } | { readonly ok: false; readonly error: string } {
  try {
    for (let i = 0; i < meta.branches.length; i++) {
      const branch = meta.branches[i];
      if (!branch) continue;
      if (
        branch.predicate === undefined ||
        branch.predicate(cloneCanonicalCallbackData(context), payload)
      ) {
        return { ok: true, index: i };
      }
    }
    return { ok: false, error: 'no canonical route branch matched' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function targetForSubmitExit(
  exitDef: AharnessStateMeta['exits'][string],
  branchIndex = 0,
): string | undefined {
  if (exitDef.kind === 'await') return exitDef.to;
  if ('to' in exitDef && typeof exitDef.to === 'string') return exitDef.to;
  if (hasSubmitBranches(exitDef)) {
    const target = exitDef.when[branchIndex]?.to;
    return typeof target === 'string' ? target : undefined;
  }
  return undefined;
}

function hasSubmitBranches(
  exitDef: AharnessStateMeta['exits'][string],
): exitDef is AharnessStateMeta['exits'][string] & {
  readonly when: ReadonlyArray<{ readonly to?: unknown }>;
} {
  return 'when' in exitDef && Array.isArray(exitDef.when);
}

async function writeFinalArtifacts(
  o: CreateSubmitDispatcherOpts,
  terminalStateId: string,
  context?: Record<string, unknown>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  if (o.writeFinalArtifacts === undefined) return { ok: true };
  try {
    await o.writeFinalArtifacts(terminalStateId, context);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: `Final artifact write failed for terminal state '${terminalStateId}': ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

function callOnTerminal(
  o: CreateSubmitDispatcherOpts,
  terminalStateId: string,
  serverMeta: ServerRequestMeta | undefined,
): void {
  if (!o.onTerminal) return;
  if (serverMeta === undefined) o.onTerminal(terminalStateId);
  else o.onTerminal(terminalStateId, serverMeta);
}
