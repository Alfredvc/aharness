/**
 * `embed(fsm, opts)` — author combinator that inlines a child harness machine
 * (compiled via `harness.machine(...)`) or a raw `MachineConfig` as a compound
 * state in another machine.
 *
 * The typical caller pattern:
 *
 *     // child.fsm.ts
 *     export default harness.machine({...});
 *
 *     // parent.fsm.ts
 *     import child from './child.fsm.js';
 *     const compound = embed(child, { on: {...} });
 *
 * `embed()` reads the pre-synthesis snapshot stashed on the compiled machine as
 * a non-enumerable `__harnessRawConfig` property (see `harness.machine()`'s
 * snapshot stash in `state/machine.ts`). The snapshot is a function-preserving
 * structural clone taken before `injectFrameworkActions` mutated the input
 * config, so the parent's synthesis pass receives a clean tree to walk under
 * qualified state IDs without colliding with the child's earlier synthesis.
 *
 * For advanced cases (inline tests, programmatic config builders) `embed()`
 * also accepts a raw `MachineConfig` object directly. The discriminator is the
 * presence of `__harnessRawConfig`: when present, the snapshot is used; when
 * absent, the argument is treated as a raw config.
 *
 * Returns a compound-state config (`{initial, states, meta: {harness: {embedded}}}`)
 * suitable for placement under `states:` in the parent. Synthesis of the
 * bare `<finalId>` entry-raise on each child final, and of the parent compound
 * state's `on:` keys for those events, happens in machine.ts (Task 8).
 */
import type {
  Action as XStateAction,
  AnyStateMachine,
  AnyStateNodeConfig,
  EventObject,
  GuardPredicate,
  MachineContext,
  ParameterizedObject,
  ProvidedActor,
} from 'xstate';
import type { ArgSentinel, InputOf } from './args.js';
import { cloneConfigPreservingFns } from './cloneConfigPreservingFns.js';

export interface EmbeddedMeta {
  /** Source provenance — the child config's `id`, for verifier diagnostics. */
  readonly source: string;
  /** Names of final states (keys in the child's `states` map whose `type` is `'final'`). */
  readonly exits: ReadonlyArray<string>;
  /** Author-supplied parent transition wiring keyed by final id. */
  readonly onMap: Readonly<Record<string, EmbeddedTransitionConfig>>;
  /**
   * Optional projection from the parent's machine-context to the child's
   * `input` shape. Read by machine.ts when wrapping the compound state's
   * entry actions.
   */
  readonly input?: EmbeddedInputProjection;
  /**
   * Canonical `createFsm().embed(...)` child-final handlers, keyed by child
   * final id. Runtime preflight consumes this in the full Task 2
   * implementation; primitive `embed(...)` leaves it unset.
   */
  readonly canonicalOnMap?: Readonly<Record<string, CanonicalEmbeddedFinalHandler>>;
  /**
   * Frozen reference to the resolved child config (the snapshot when one
   * was passed, otherwise the raw config) — used by verifier walks
   * (cycle detection in T5, input-satisfaction in T16). Do not mutate.
   */
  readonly childConfig: MinimalChildConfig;
}

export type EmbeddedInputProjection = (args: {
  readonly context: Record<string, unknown>;
}) => Record<string, unknown>;

export interface EmbeddedTransitionConfig {
  readonly target: string;
  readonly actions?: unknown;
  readonly guard?: unknown;
}

export interface CanonicalEmbeddedFinalHandler {
  readonly to: string;
  readonly effect?: unknown;
  readonly reduce?: unknown;
}

export interface EmbeddedCompoundConfig {
  readonly initial: string;
  readonly states: Record<string, AnyStateNodeConfig>;
  readonly meta: { readonly harness: { readonly embedded: EmbeddedMeta } };
  readonly entry?: AnyStateNodeConfig['entry'];
}

export interface MinimalChildConfig {
  readonly id?: string;
  readonly initial?: string;
  /**
   * Root-level `input` declaration: a record of `arg<T>()` sentinels keyed by
   * field name. Preserved verbatim by `cloneConfigPreservingFns` from the
   * child's source config so the verifier (Task 16) can read required (no-
   * default) field names without a TS-strict cast.
   */
  readonly input?: Record<string, ArgSentinel>;
  readonly states?: Record<
    string,
    {
      readonly type?: string;
      readonly meta?: { readonly harness?: { readonly kind?: string } };
      readonly on?: Record<string, unknown>;
    }
  >;
  readonly entry?: unknown;
}

/**
 * Resolve the input to a raw `MachineConfig`. If the input is a compiled
 * `harness.machine()` return value, read its non-enumerable `__harnessRawConfig`
 * snapshot (taken before synthesis mutated the input). If it's a raw config
 * object (no snapshot), use it directly.
 *
 * The returned config is the SAME reference as either the snapshot or the raw
 * argument — `embed()` clones it via `cloneConfigPreservingFns` before lifting
 * `states` into the compound (see `embed()` body). Without that per-call clone,
 * lifting the snapshot's `states` directly into a compound would let the
 * parent's synthesis pass mutate the snapshot's leaf nodes; a second `embed()`
 * of the same compiled child would then read mutated nodes and the second
 * compound's `SUBMIT__<qualifiedId>__<exit>` keys would clobber the first's.
 */
function resolveChildConfig(fsm: AnyStateMachine | MinimalChildConfig): MinimalChildConfig {
  const snap = (fsm as { __harnessRawConfig?: unknown }).__harnessRawConfig;
  if (snap !== undefined && typeof snap === 'object' && snap !== null) {
    return snap;
  }
  return fsm as MinimalChildConfig;
}

function listFinalIds(child: MinimalChildConfig): string[] {
  const out: string[] = [];
  for (const [name, node] of Object.entries(child.states ?? {})) {
    if (node?.type === 'final' || node?.meta?.harness?.kind === 'terminal') {
      out.push(name);
    }
  }
  return out;
}

/**
 * Project a compiled `harness.machine(...)` return down to its `__finalsType`
 * phantom slot — the per-final-id record stamped on `HarnessMachine<…, TFinals>`
 * by `harness.machine`'s `ExtractFinals<TStates>` walk (see
 * `state/machine.ts`). When the slot is absent (raw `MinimalChildConfig`
 * input, or an opaque `AnyStateMachine` annotation) the helper returns the
 * permissive `Record<string, unknown>` fallback so the mapped `on:` map below
 * keeps compiling with structural-shaped author wiring.
 */
export type FinalsOf<TFsm> = TFsm extends { __finalsType?: infer F }
  ? F extends Record<string, unknown>
    ? F
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * Event shape seen by the parent compound state's `on['<finalId>']` callback
 * after the embed-host's entry-raise drains. The `type` field is the bare
 * final id (no `FINAL_` prefix — see `EMBEDDED_FINAL_RAISE` in `state/machine.ts`)
 * and `output` carries the value returned by the child final's `output()`
 * callback verbatim.
 */
export interface EmbeddedFinalEvent<TFinalId extends string, TOutput> {
  readonly type: TFinalId;
  readonly output: TOutput;
}

type EmbedAction<
  TParentCtx extends MachineContext,
  TFinalId extends string,
  TOutput,
> = XStateAction<
  TParentCtx,
  EmbeddedFinalEvent<TFinalId, TOutput>,
  EventObject,
  ParameterizedObject['params'] | undefined,
  ProvidedActor,
  ParameterizedObject,
  ParameterizedObject,
  string,
  EventObject
>;

type EmbedGuard<TParentCtx extends MachineContext, TFinalId extends string, TOutput> =
  | string
  | { readonly type: string; readonly params?: Record<string, unknown> }
  | GuardPredicate<
      TParentCtx,
      EmbeddedFinalEvent<TFinalId, TOutput>,
      ParameterizedObject['params'] | undefined,
      ParameterizedObject
    >;

/**
 * Per-final transition entry on `EmbedOptions.on`. `actions` and `guard`
 * see the embed-host's `EmbeddedFinalEvent<K, TFinals[K]>` so author inline
 * callbacks (`assign(({event}) => event.output.topic)`) get `event.output`
 * typed against the child final's `output()` return type without manual
 * casts. Pain 5.
 */
export interface EmbeddedTransitionConfigTyped<
  TParentCtx extends MachineContext,
  TFinalId extends string,
  TOutput,
> {
  readonly target: string;
  readonly actions?:
    | EmbedAction<TParentCtx, TFinalId, TOutput>
    | ReadonlyArray<EmbedAction<TParentCtx, TFinalId, TOutput>>;
  readonly guard?: EmbedGuard<TParentCtx, TFinalId, TOutput>;
}

export interface EmbedOptions<
  TParentCtx extends MachineContext = MachineContext,
  TChildInput = Record<string, unknown>,
  TFinals extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly input?: (parent: { context: TParentCtx }) => TChildInput;
  readonly on: {
    readonly [K in keyof TFinals]: EmbeddedTransitionConfigTyped<
      TParentCtx,
      K & string,
      TFinals[K]
    >;
  };
}

/**
 * `embed()` accepts either a compiled `harness.machine(...)` result or a raw
 * `MachineConfig`. The first generic captures whichever the author passed in;
 * the second is the parent's machine context (defaults to a permissive shape
 * for authors who do not type their context explicitly).
 *
 * The projection's return type is constrained to `InputOf<TChildFsm>` —
 * the resolved object shape of the child's `input:` declaration. TS rejects
 * projection mismatch at user `tsc` time; the verifier's runtime probe
 * (Task 16) covers spread expressions and dynamic-keys cases the type system
 * cannot statically check.
 *
 * The `on:` map is statically keyed by the child's `final()` ids via
 * `FinalsOf<TChildFsm>` — the `__finalsType` phantom stamped on the typed
 * `HarnessMachine<…>` return. Each entry's `actions` / `guard` callbacks see
 * `event.output` typed as the corresponding child final's `output()` return
 * type (Pain 5). Authors who pass a raw `MinimalChildConfig` (no phantom)
 * fall back to the permissive `Record<string, unknown>` shape.
 */
export function embed<
  TChildFsm extends AnyStateMachine | MinimalChildConfig,
  TParentCtx extends MachineContext = MachineContext,
>(
  fsm: TChildFsm,
  opts: EmbedOptions<TParentCtx, InputOf<TChildFsm>, FinalsOf<TChildFsm>>,
): EmbeddedCompoundConfig {
  if (typeof fsm !== 'object' || fsm === null) {
    throw new TypeError('embed(): first argument must be a compiled machine or raw MachineConfig');
  }
  const childResolved = resolveChildConfig(fsm);
  // Clone fresh per embed() call. Parent's `injectFrameworkActions` mutates
  // states on the lifted tree (writing qualified `SUBMIT__inner.go__out` keys);
  // without a fresh clone, a second embed of the same compiled child would
  // read post-mutation nodes and the second compound's keys would clobber the
  // first's. The clone preserves function references (callbacks, action
  // factories) — the same helper `harness.machine()` uses for the snapshot.
  const child = cloneConfigPreservingFns(childResolved);
  if (typeof child.initial !== 'string' || child.initial.length === 0) {
    throw new TypeError('embed(): child config has no `initial` state');
  }
  if (!child.states || Object.keys(child.states).length === 0) {
    throw new TypeError('embed(): child config has no `states`');
  }
  const finals = listFinalIds(child);
  if (finals.length === 0) {
    throw new TypeError('embed(): child config declares no final() states');
  }
  const onKeys = Object.keys(opts.on ?? {});
  const finalSet = new Set(finals);
  const onSet = new Set(onKeys);
  const missing = finals.filter((f) => !onSet.has(f));
  const extra = onKeys.filter((k) => !finalSet.has(k));
  if (missing.length > 0) {
    throw new TypeError(`embed(): on-map missing entries for final(s): ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    throw new TypeError(`embed(): on-map references unknown final(s): ${extra.join(', ')}`);
  }
  const meta: EmbeddedMeta = {
    source: child.id ?? '<inline>',
    exits: finals,
    onMap: { ...opts.on },
    childConfig: child,
    // Widen the typed projection (parent: {context: TParentCtx}) => InputOf<TChildFsm>
    // back to the storage shape `EmbeddedInputProjection`. The author surface is
    // typed to reject projection mismatch at user `tsc` time; the runtime stash
    // is intentionally loose so machine.ts can read it without parameterizing
    // every consumer on the parent's context type.
    ...(opts.input !== undefined ? { input: opts.input as EmbeddedInputProjection } : {}),
  };
  const compound: EmbeddedCompoundConfig = {
    initial: child.initial,
    states: child.states as Record<string, AnyStateNodeConfig>,
    meta: { harness: { embedded: meta } },
    ...(child.entry !== undefined ? { entry: child.entry } : {}),
  };
  return compound;
}

export function isEmbeddedNode(node: unknown): node is EmbeddedCompoundConfig {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as { meta?: { harness?: { embedded?: unknown } } }).meta?.harness?.embedded ===
      'object'
  );
}
