/**
 * Daemon actor host — wraps a single XState v5 actor for a Codex run and
 * exposes the operations the dispatcher pipeline needs:
 *
 *   - `start()` / `currentStateId()` / `currentContext()` / `snapshot()`
 *   - `dryRunSubmit(stateId, exitName, payload)` — pure projection of the
 *     next snapshot without mutating the live actor. Used by the
 *     dispatcher to predict whether a candidate `SUBMIT__*` event would
 *     advance state, which turns the otherwise-side-effecting commit
 *     decision into a pre-validated one.
 *   - `commitSubmit(...)` / `commitAwait(...)` — actually send the event;
 *     the actor advances and the inspector pipeline (snapshot persist,
 *     trace) fires through the daemon's own subscriptions.
 *   - `currentMeta()` — `AharnessMeta` for the active leaf, used by the
 *     dispatcher to read posture (`open` / `entryPrompt` /
 *     `stopGuidance`) without having to walk `iterStates` again.
 *
 * **Pure-transition implementation choice (R10 — verified by Task 0
 * PREFLIGHT.md §5):** XState v5 (>= 5.19.0) ships a top-level
 * `transition(machine, snapshot, event)` function that returns
 * `[nextSnapshot, executableActions]`. It is documented as side-effect
 * free (entry/exit actions are *captured* in the returned array but not
 * executed). `dryRunSubmit` uses that path; the actor-clone fallback in
 * R10's branch B is unnecessary given @aharness/core's `xstate >= 5.19.0`
 * pin. See PREFLIGHT.md §5 for the audit trail.
 *
 * Active-leaf walk: this module reaches into `snapshot._nodes` to
 * derive the current state-id, mirroring the same pattern used by the
 * CC sdk's `internal/xstateInternals.ts`. `_nodes` is part of XState's
 * public d.ts but the underscore signals intent — the centralised
 * helper in `@aharness/core` is not exported on the public barrel, so we
 * inline the same one-liner here. When the XState pin moves the
 * comment above + this site are the audit points.
 */
import {
  createActor,
  transition,
  type AnyActor,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type SnapshotFrom,
  type StateNode,
} from 'xstate';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import {
  prepareCanonicalEmbeddedFinalCommit,
  payloadWithCanonicalCommit,
  payloadWithCanonicalEmbeddedFinalCommit,
  withCanonicalDryRun,
} from '../state/canonicalTransition.js';
import type { EmbeddedMeta } from '../state/embed.js';
import type { AharnessOps } from '../state/aharnessOps.js';
import type { AharnessMeta } from '../types.js';

/**
 * Result of `dryRunSubmit`. `ok: true` carries the projected post-
 * transition state-id and context; `ok: false` carries the throw
 * message from the pure `transition` call (e.g. unknown event,
 * unresolved guard).
 */
export type DryRunResult =
  | { ok: true; nextStateId: string; nextContext: Record<string, unknown> }
  | { ok: false; error: string };

export type EmbeddedFinalCommitResult =
  | { ok: true; matched: false; nextContext: Record<string, unknown> }
  | { ok: true; matched: true; nextContext: Record<string, unknown>; finalId: string }
  | { ok: false; error: string };

export class ActorHost {
  private actor: AnyActor;
  constructor(
    private machine: AnyStateMachine,
    snapshot: SnapshotFrom<AnyStateMachine> | undefined,
    input?: unknown,
  ) {
    // XState `createActor`'s second arg accepts at most one of `snapshot`
    // or `input`: snapshot resumes a serialised actor (input is ignored
    // because the actor's context is already materialised inside the
    // snapshot); `input` seeds the user's `context: ({ input }) => ...`
    // factory on a fresh boot.
    const opts = snapshot ? { snapshot } : input !== undefined ? { input } : undefined;
    this.actor = createActor(machine, opts);
  }

  start(): void {
    this.actor.start();
  }

  /**
   * Dotted state-key path of the first active leaf (atomic or final).
   * Empty string when no leaves are active (machine stopped or all
   * regions done). For nested/parallel states this returns the path
   * of the first leaf in `snapshot._nodes` order; @aharness/core's
   * dispatcher resolves orientation against this same first-leaf
   * convention.
   */
  currentStateId(): string {
    return leafStateId(this.actor.getSnapshot() as AnyMachineSnapshot);
  }

  currentContext(): Record<string, unknown> {
    const snap = this.actor.getSnapshot() as AnyMachineSnapshot;
    return snap.context as Record<string, unknown>;
  }

  snapshot(): SnapshotFrom<AnyStateMachine> {
    return this.actor.getSnapshot() as SnapshotFrom<AnyStateMachine>;
  }

  /**
   * Resolve when the live actor reaches a snapshot matching `predicate`.
   * Used for framework-owned transient/invoked states where the runtime
   * must wait for XState's next internal transition before replying to
   * the model.
   */
  waitForSnapshot(predicate: (snapshot: SnapshotFrom<AnyStateMachine>) => boolean): Promise<void> {
    const current = this.actor.getSnapshot() as SnapshotFrom<AnyStateMachine>;
    if (predicate(current)) return Promise.resolve();
    return new Promise((resolve) => {
      const sub = this.actor.subscribe((snapshot) => {
        if (!predicate(snapshot as SnapshotFrom<AnyStateMachine>)) return;
        sub.unsubscribe();
        resolve();
      });
    });
  }

  /**
   * Pure-transition projection. Does **not** mutate the live actor or
   * fire any entry/exit actions. Implemented via XState v5's top-level
   * `transition(machine, snapshot, event)` (see file header).
   */
  dryRunSubmit(stateId: string, exitName: string, payload: unknown): DryRunResult {
    const snap = this.actor.getSnapshot() as SnapshotFrom<AnyStateMachine>;
    const event = { type: `SUBMIT__${stateId}__${exitName}`, payload };
    let nextSnapshot: SnapshotFrom<AnyStateMachine>;
    try {
      // Top-level `transition` returns `[nextSnapshot, actions]` — we
      // discard the actions array since this is a pure projection.
      [nextSnapshot] = withCanonicalDryRun(() =>
        transition(this.machine, snap, event as Parameters<typeof transition>[2]),
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return {
      ok: true,
      nextStateId: leafStateId(nextSnapshot as AnyMachineSnapshot),
      nextContext: nextSnapshot.context as Record<string, unknown>,
    };
  }

  /**
   * Send `SUBMIT__<stateId>__<exitName>` with the validated payload.
   * The actor advances synchronously; the daemon's inspector observes
   * the resulting `@xstate.snapshot` event.
   */
  commitSubmit(stateId: string, exitName: string, payload: unknown): void {
    // `AnyActor.send` is typed against `EventObject` (just `{ type }`).
    // Our events carry a `payload` field; cast to keep the call site
    // honest about the shape we pass at runtime.
    this.actor.send({ type: `SUBMIT__${stateId}__${exitName}`, payload } as unknown as Parameters<
      AnyActor['send']
    >[0]);
  }

  /**
   * Send `AWAIT__<stateId>__<exitName>` with the user's reply text.
   * The aharness wrapper attaches `__aharnessAssignOwnerReply` to every
   * `AWAIT__*` transition, which copies `event.payload.ownerReply`
   * into context. The dispatcher passes the reply through under the
   * agreed payload shape.
   */
  commitAwait(
    stateId: string,
    exitName: string,
    messageFromUser: string,
    nextContext?: Record<string, unknown>,
    embeddedFinalContext?: Record<string, unknown>,
  ): void {
    let payload: unknown = { ownerReply: messageFromUser };
    if (nextContext !== undefined) {
      payload = payloadWithCanonicalCommit(payload, nextContext);
    }
    if (embeddedFinalContext !== undefined) {
      payload = payloadWithCanonicalEmbeddedFinalCommit(payload, embeddedFinalContext);
    }
    this.actor.send({
      type: `AWAIT__${stateId}__${exitName}`,
      payload,
    } as unknown as Parameters<AnyActor['send']>[0]);
  }

  /**
   * Send a canonical machine-local event into the live actor. The generic
   * event lowering path owns the corresponding XState `on` entries; this host
   * method only centralizes the runtime event envelope shape.
   */
  commitEvent(eventName: string, payload: unknown): void {
    this.actor.send({ type: eventName, payload } as unknown as Parameters<AnyActor['send']>[0]);
  }

  async prepareEmbeddedFinalCommit(args: {
    readonly sourceStateId: string;
    readonly target: string | undefined;
    readonly context: Record<string, unknown>;
    readonly event: unknown;
    readonly ops?: AharnessOps;
  }): Promise<EmbeddedFinalCommitResult> {
    const match = this.resolveCanonicalEmbeddedFinal(args.sourceStateId, args.target);
    if (match === undefined) {
      return { ok: true, matched: false, nextContext: args.context };
    }
    let output: unknown;
    try {
      const outputFn = readAharnessField(match.finalNode, 'output');
      output =
        typeof outputFn === 'function'
          ? (outputFn as (input: { context: unknown; event: unknown }) => unknown)({
              context: args.context,
              event: args.event,
            })
          : undefined;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const prepared = await prepareCanonicalEmbeddedFinalCommit({
      handler: match.handler,
      context: args.context,
      output,
      ...(args.ops !== undefined ? { ops: args.ops } : {}),
    });
    if (!prepared.ok) return prepared;
    return { ok: true, matched: true, finalId: match.finalId, nextContext: prepared.nextContext };
  }

  /**
   * `AharnessMeta` for the current leaf (post-commit). Returns
   * `undefined` when the leaf has no `meta.aharness` annotation.
   * Walks `iterStates` once per call — the dispatcher only invokes
   * this on transition boundaries, so the cost is negligible.
   */
  currentMeta(): AharnessMeta | undefined {
    const id = this.currentStateId();
    if (id === '') return undefined;
    return this.metaForState(id);
  }

  /**
   * `AharnessMeta` for an arbitrary state id in this actor's machine.
   * Dispatchers use this for pre-commit checks where the target state must be
   * classified before the live actor moves.
   */
  metaForState(stateId: string): AharnessMeta | undefined {
    for (const node of iterStates(this.machine)) {
      if (stateKeyPath(node) === stateId) return getAharnessMeta(node);
    }
    return undefined;
  }

  isTerminalState(stateId: string): boolean {
    return this.metaForState(stateId)?.kind === 'terminal';
  }

  resolveTargetStateId(sourceStateId: string, target: string): string | undefined {
    if (target.length === 0 || target.startsWith('#')) return undefined;
    if (target.startsWith('.')) {
      const childTarget = `${sourceStateId}${target}`;
      return this.metaForState(childTarget) === undefined ? undefined : childTarget;
    }
    if (this.metaForState(target) !== undefined) return target;
    const sourceParent = sourceStateId.split('.').slice(0, -1).join('.');
    const siblingTarget = sourceParent.length > 0 ? `${sourceParent}.${target}` : target;
    return this.metaForState(siblingTarget) === undefined ? undefined : siblingTarget;
  }

  private resolveCanonicalEmbeddedFinal(
    sourceStateId: string,
    target: string | undefined,
  ):
    | {
        readonly finalId: string;
        readonly handler: NonNullable<EmbeddedMeta['canonicalOnMap']>[string];
        readonly finalNode: StateNode;
      }
    | undefined {
    if (target === undefined || target.length === 0 || target.startsWith('#')) return undefined;
    const sourceSegments = sourceStateId.split('.').filter((part) => part.length > 0);
    for (let length = sourceSegments.length - 1; length > 0; length--) {
      const hostPath = sourceSegments.slice(0, length).join('.');
      const hostNode = this.findStateNode(hostPath);
      if (hostNode === undefined) continue;
      const embedded = readEmbeddedMeta(hostNode);
      if (embedded?.canonicalOnMap === undefined) continue;
      const finalPath = resolveTargetPath(hostPath, target);
      if (finalPath === undefined) continue;
      const finalNode = this.findStateNode(finalPath);
      if (finalNode === undefined || readAharnessField(finalNode, 'kind') !== 'terminal') {
        continue;
      }
      const finalId = finalPath.slice(hostPath.length + 1);
      if (!embedded.exits.includes(finalId)) continue;
      const handler = embedded.canonicalOnMap[finalId];
      if (handler === undefined) continue;
      return { finalId, handler, finalNode };
    }
    return undefined;
  }

  private findStateNode(path: string): StateNode | undefined {
    for (const node of iterStates(this.machine)) {
      if (stateKeyPath(node) === path) return node;
    }
    return undefined;
  }
}

/**
 * Pull the first active leaf node out of a snapshot and return its
 * `stateKeyPath`. Empty string when no leaves are active.
 *
 * Mirrors `@aharness/core`'s `getActiveLeafNodes` helper; the public
 * barrel does not export it, and this is daemon-internal code that
 * already understands the `_nodes` shape (see file header for the
 * audit-point note when the XState pin moves).
 */
function leafStateId(snapshot: AnyMachineSnapshot): string {
  const leaves = (snapshot._nodes as readonly StateNode[]).filter(
    (n) => n.type === 'atomic' || n.type === 'final',
  );
  const first = leaves[0];
  if (!first) return '';
  return stateKeyPath(first);
}

function readEmbeddedMeta(node: StateNode): EmbeddedMeta | undefined {
  const raw: unknown = node.config.meta;
  if (raw === null || typeof raw !== 'object') return undefined;
  const embedded = (raw as { aharness?: { embedded?: unknown } }).aharness?.embedded;
  if (embedded !== null && typeof embedded === 'object') return embedded as EmbeddedMeta;
  return undefined;
}

function readAharnessField(node: StateNode, field: string): unknown {
  const raw: unknown = node.config.meta;
  if (raw === null || typeof raw !== 'object') return undefined;
  return (raw as { aharness?: Record<string, unknown> }).aharness?.[field];
}

function resolveTargetPath(hostPath: string, target: string): string | undefined {
  const normalized = target.startsWith('.') ? target.slice(1) : target;
  if (normalized.length === 0) return undefined;
  if (normalized.startsWith(`${hostPath}.`)) return normalized;
  return `${hostPath}.${normalized}`;
}
