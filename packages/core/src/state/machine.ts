/**
 * `aharness.machine(config)` — wrapper that augments an XState v5 machine
 * config with framework-owned actions before handing it to `setup()` +
 * `createMachine()`.
 *
 * The wrapper walks the user's config in place (never JSON-clones — that
 * would strip functions: entry/exit actions, guards, `assign` thunks, the
 * `entryPrompt` function form, `stopGuidance`), and runs two passes:
 *
 * **Pass 1 — synthesis** (in `injectFrameworkActions`):
 *   For every stateful state, synthesizes `SUBMIT__<stateId>__<exitName>`
 *   `on:` keys from `meta.aharness.exits`.
 *   Authors never write these keys; the verifier check
 *   `no-handwritten-submit-await-handlers` rejects FSMs that try. Before
 *   overwriting any existing keys, the synthesizer snapshots them onto
 *   `meta.aharness.__aharness_authoredOnKeys` so the verifier can detect
 *   author collisions post-`createMachine`.
 *
 * **Pass 2 — framework action injection** (also in `injectFrameworkActions`):
 *   - Prepends a parameterised `__aharnessIncrementVisit` entry action on
 *     every stateful state (params: `{ stateId }`).
 *   - On synthesized `SUBMIT__*` transitions: prepends
 *     `__aharnessClearOwnerReply` UNLESS the branch is a self-loop (`to ===
 *     stateId`). Self-loop branches use `reenter: false` (XState 5 internal
 *     transition) and additionally prepend `__aharnessIncrementVisit` on the
 *     transition's action chain (entry does not re-fire on internal
 *     transitions, so visit++ must happen in the transition itself).
 *
 * Author-supplied `context` factory is forwarded with its full XState v5
 * args object so destructuring `({ input })` keeps working.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assign,
  raise,
  setup,
  type AnyEventObject,
  type AnyStateMachine,
  type EventObject,
  type MachineContext,
  type MetaObject,
  type ParameterizedObject,
  type ProvidedActor,
  type StateNodeConfig,
} from 'xstate';
import type { ArgSentinel, ResolveInput } from './args.js';
import {
  canonicalEmbeddedFinalCommitContext,
  isCanonicalDryRun,
  payloadWithCanonicalEmbeddedFinalCommit,
} from './canonicalTransition.js';
import { cloneConfigPreservingFns } from './cloneConfigPreservingFns.js';
import type { AharnessInput } from '../types.js';
import type { DefaultedExitDef, FinalConfig } from './exits.js';
import type { EmbeddedInputProjection, MinimalChildConfig } from './embed.js';

/**
 * Typed wrapper return of `aharness.machine({...})`. Extends `AnyStateMachine`
 * so existing call sites that consume the return as `AnyStateMachine`
 * continue to compile; adds two phantom slots that surface FSM-level type
 * facts at the type level:
 *
 *   - `__inputType` — the resolved `input:` declaration shape, consumed by
 *     `InputOf<typeof child>` (Task 12a).
 *   - `__finalsType` — a record of `<finalId, output-type>` entries
 *     extracted from the `states:` map's `final()` nodes, consumed by
 *     `embed()`'s `EmbedOptions.on` mapped type (Pain 5). Each entry's
 *     value is the resolved return type of the child final's `output()`
 *     callback (or `undefined` when no callback was provided).
 *
 * Runtime values of both phantom slots are always `undefined`; the fields
 * exist purely as TS-level carriers.
 *
 * `_TContext` and `_TEvent` are declared on the public surface to match
 * XState's convention and are threaded through the namespace's `machine`
 * return type for forward compatibility, but `AnyStateMachine` already
 * erases context / event types at this layer so the parameters are not
 * referenced in the body — hence the underscore prefix to satisfy
 * `no-unused-vars`.
 */
export interface AharnessMachine<
  _TContext,
  _TEvent,
  TInput,
  TFinals = Record<string, unknown>,
> extends AnyStateMachine {
  readonly __inputType?: TInput;
  readonly __finalsType?: TFinals;
}

/**
 * Walk a literal `states:` map and project each `final()` entry into a
 * `<finalId, TOutput>` record. Non-final entries are filtered out via the
 * `as` remapping clause. The resolved `TOutput` is read from the phantom
 * `__outputType` slot stamped on `FinalConfig<TOutput>` by `final()` —
 * never set at runtime; consumed only at the type level.
 *
 * Falls back to a never-keyed empty record when `TStates` widens past the
 * literal shape (e.g. when the call site annotates `states: Record<string,
 * unknown>` instead of letting `const TStates` capture the literal). The
 * `aharness.machine`'s `const TStates` generic is the inference path that
 * keeps this walk live.
 */
export type ExtractFinals<TStates> = {
  [K in keyof TStates as TStates[K] extends FinalConfig<unknown>
    ? K
    : never]: TStates[K] extends FinalConfig<infer O> ? O : never;
};

const VISIT_ACTION = '__aharnessIncrementVisit';
const CLEAR_OWNER_REPLY = '__aharnessClearOwnerReply';
const EMBEDDED_FINAL_RAISE = '__aharnessEmbeddedFinalRaise';

type FinalOutputFn = (a: { context: unknown; event: unknown }) => unknown;
type OutputRegistry = Map<string, FinalOutputFn>;

// The wrapper input shape is intentionally loose. The user has already typed
// their config; we accept it as `Record<string, unknown>` and return
// `AnyStateMachine` because the resulting machine's generic parameters depend
// on the input in ways we cannot statically reconstruct.
type AnyConfig = Record<string, unknown>;

interface StateConfigShape {
  meta?: { aharness?: { kind?: string } };
  entry?: unknown;
  on?: Record<string, unknown>;
  states?: Record<string, StateConfigShape>;
}

function isStateful(node: StateConfigShape | undefined): boolean {
  return node?.meta?.aharness?.kind === 'stateful';
}

function isChoice(node: StateConfigShape | undefined): boolean {
  return node?.meta?.aharness?.kind === 'choice';
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? [...v] : [v];
}

function stripDotPrefix(s: string): string {
  return s.startsWith('.') ? s.slice(1) : s;
}

interface SynthesizedTransition {
  target: string;
  guard?: unknown;
  actions: unknown[];
  reenter?: boolean;
}

/**
 * Convert one author exit declaration into one or more XState transition
 * entries. Sugar form yields a one-element array; `when[]` yields one
 * entry per branch (preserving order — first-with-passing-guard wins,
 * last entry is the unguarded catch-all).
 *
 * For each branch, framework actions are prepended in this order:
 *   1. `__aharnessClearOwnerReply` if NOT a self-loop.
 *   2. `__aharnessIncrementVisit` if a self-loop (visit++ deposit;
 *      external transitions get visit++ via the destination state's
 *      entry action, internal self-loops have no dest-entry).
 *   3. ...branch.actions (author actions, untouched).
 *
 * Self-loops (`branch.to === sourceKey` — last segment of the dotted
 * path, since authors write sibling targets like `to: 'foo'`, not
 * dotted paths like `to: 'm.parent.foo'`) emit `reenter: false` so
 * XState 5 treats the transition as internal — author entry/exit
 * actions on the source state are NOT re-fired on each loop.
 *
 * Reads the post-default exit shape (`DefaultedExitDef` in `exits.ts`,
 * Task 1). The `state(...)` defaulting pass (Task 2) ensures every
 * exit has `kind: 'submit'` populated by the time this helper runs.
 */
function synthesizeBranches(
  exit: DefaultedExitDef,
  stateId: string,
  sourceKey: string,
): SynthesizedTransition[] {
  // Cast to a loose accessor type for property access inside the branches.
  // The runtime checks (`typeof exit.to`, `Array.isArray(exit.when)`) are the
  // true narrowing; the cast aligns TS with the runtime shape without widening
  // the function's public contract (the param is still the strict union).
  const e = exit as { to?: string; when?: Array<unknown>; actions?: unknown; guard?: unknown };
  // Sugar form: top-level `to:` (with optional `actions:`).
  if (typeof e.to === 'string') {
    return [buildBranch({ to: e.to, actions: e.actions, guard: e.guard }, stateId, sourceKey)];
  }
  // Multi-branch: `when:` array.
  if (Array.isArray(e.when)) {
    return e.when.map((b) =>
      buildBranch(b as { to?: string; actions?: unknown; guard?: unknown }, stateId, sourceKey),
    );
  }
  throw new Error(
    `synthesizeBranches: exit must declare 'to' (sugar) or 'when' (multi-branch); state '${stateId}'`,
  );
}

function buildBranch(
  branch: { to?: string; actions?: unknown; guard?: unknown },
  stateId: string,
  sourceKey: string,
): SynthesizedTransition {
  if (typeof branch.to !== 'string' || branch.to.length === 0) {
    throw new Error(`synthesizeBranches: branch missing 'to'; state '${stateId}'`);
  }
  // Self-loop detection mirrors the existing detector at machine.ts:75-99.
  // Compare against the last path segment (sibling key), not the full
  // dotted ID, because authors write sibling targets (`to: 'foo'`), not
  // dotted paths (`to: 'm.parent.foo'`). XState hash-id targets
  // (`to: '#someId'`) remain a documented limitation — same as the
  // legacy walker.
  const isSelfLoop = stripDotPrefix(branch.to) === sourceKey;
  const actions: unknown[] = [];
  if (!isSelfLoop) {
    // SUBMIT, non-self-loop: prepend CLEAR_OWNER_REPLY (decision #6 — keep
    // skipping on self-loops to preserve owner reply across iterations).
    actions.push({ type: CLEAR_OWNER_REPLY });
  }
  if (isSelfLoop) {
    // Self-loop visit++ deposit (decision #5). External transitions get
    // visit++ via dest-entry; only internal self-loops need it on the
    // transition itself.
    actions.push({ type: VISIT_ACTION, params: { stateId } });
  }
  for (const a of asArray(branch.actions)) {
    actions.push(a);
  }
  const out: SynthesizedTransition = {
    target: branch.to,
    actions,
    ...(branch.guard !== undefined ? { guard: branch.guard } : {}),
    ...(isSelfLoop ? { reenter: false } : {}),
  };
  return out;
}

function synthesizeChoiceBranches(
  options: ReadonlyArray<{ readonly label: string; readonly to: string }>,
  stateId: string,
  sourceKey: string,
): SynthesizedTransition[] {
  return options.map((option) => {
    const isSelfLoop = stripDotPrefix(option.to) === sourceKey;
    const actions: unknown[] = [{ type: CLEAR_OWNER_REPLY }];
    if (isSelfLoop) {
      actions.push({ type: VISIT_ACTION, params: { stateId } });
    }
    return {
      target: option.to,
      guard: ({ event }: { event: { payload?: { label?: unknown } } }) =>
        event.payload?.label === option.label,
      actions,
      ...(isSelfLoop ? { reenter: false } : {}),
    };
  });
}

function materializeEmbeddedChildContextAction(embedded: {
  input?: EmbeddedInputProjection;
  childConfig?: MinimalChildConfig & { context?: unknown };
}) {
  if (typeof embedded.input !== 'function') return undefined;
  return assign(({ context, spawn, self }) => {
    const projectedInput = embedded.input?.({ context: context as Record<string, unknown> }) ?? {};
    const childContext = resolveEmbeddedChildContext(embedded.childConfig?.context, {
      input: projectedInput,
      spawn,
      self,
    });
    return childContext;
  });
}

function resolveEmbeddedChildContext(
  childContext: unknown,
  args: {
    readonly input: Record<string, unknown>;
    readonly spawn: unknown;
    readonly self: unknown;
  },
): Record<string, unknown> {
  const resolved =
    typeof childContext === 'function'
      ? (childContext as (a: typeof args) => unknown)(args)
      : childContext;
  if (resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)) {
    return { ...(resolved as Record<string, unknown>) };
  }
  return {};
}

/**
 * Walk every state node in place. Atomic replacement of the legacy
 * walker — synthesizes SUBMIT__ on: keys from `meta.aharness.exits`
 * (replacing any hand-written wrapping) and snapshots any pre-existing
 * SUBMIT__/AWAIT__ keys to a side-channel for the verifier to detect. AWAIT__
 * is snapshot only: await exits are retired and rejected before synthesis.
 *
 * Phase 2 additions (T8):
 *   - On embed-host nodes (`meta.aharness.embedded` set, no `kind`), synthesize
 *     `on: { <finalId>: <transition> }` keys from `embed.onMap` and update
 *     the recursion's `embeddedSource` cursor for descendants.
 *   - On `final()` nodes (`kind === 'terminal'`) reached while an embed
 *     subtree is active, append an `entry: __aharnessEmbeddedFinalRaise`
 *     action; the user's `output()` callback (when present) is registered
 *     in `outputRegistry` under a path-keyed identifier and resolved at
 *     run time by the named-action body via closure capture.
 */
function injectFrameworkActions(
  node: StateConfigShape,
  path: string[],
  embeddedSource: string | null,
  outputRegistry: OutputRegistry,
): void {
  // 1. Side-channel snapshot of authored SUBMIT__/AWAIT__ keys BEFORE any
  //    synthesis overwrites them. Runs on EVERY state node (not just stateful
  //    ones) so the verifier check `no-handwritten-submit-await-handlers` can
  //    detect author-written SUBMIT__/AWAIT__ keys on passive/terminal states
  //    too. Prefixed `__aharness_` so author keys cannot collide with this field.
  const aharnessMeta = node.meta?.aharness as
    | (Record<string, unknown> & {
        exits?: Record<
          string,
          { kind?: string; to?: string; when?: Array<unknown>; actions?: unknown }
        >;
        options?: ReadonlyArray<{ readonly label: string; readonly to: string }>;
        embedded?: {
          source: string;
          exits: ReadonlyArray<string>;
          onMap: Record<string, { target: string; actions?: unknown; guard?: unknown }>;
          input?: EmbeddedInputProjection;
          canonicalOnMap?: Record<string, unknown>;
          childConfig?: MinimalChildConfig & { context?: unknown };
        };
        kind?: string;
        outcome?: string;
        output?: FinalOutputFn;
      })
    | undefined;
  if (aharnessMeta) {
    // Embedded-compound nodes (`meta.aharness.embedded` set, no `kind`
    // discriminant) are not stateful leaves and do not get
    // framework-synthesized SUBMIT__/AWAIT__ keys. Writing the marker on
    // them would false-flag the compound for any grandparent re-embedding
    // walker that scans for `__aharness_authoredOnKeys` to detect authored
    // collisions. Spec §5.1. Skip the marker; the existing recursion below
    // still walks `node.states` so leaf descendants are processed.
    const isEmbeddedCompound =
      aharnessMeta['embedded'] !== undefined && aharnessMeta['kind'] === undefined;
    if (!isEmbeddedCompound) {
      const originalKeys: string[] = [];
      for (const k of Object.keys(node.on ?? {})) {
        if (/^(SUBMIT|AWAIT|OWNER_CHOICE)__/.test(k)) originalKeys.push(k);
      }
      (aharnessMeta as { __aharness_authoredOnKeys?: string[] }).__aharness_authoredOnKeys =
        originalKeys;
    }
  }

  // 1a. Embed-host node — synthesize the host's on['<finalId>'] keys from
  //     embed.onMap, and update the recursion's embeddedSource so descendant
  //     final() nodes know they are inside an embed subtree.
  let nextEmbeddedSource: string | null = embeddedSource;
  if (aharnessMeta?.embedded) {
    nextEmbeddedSource = aharnessMeta.embedded.source;
    const materializeInput = materializeEmbeddedChildContextAction(aharnessMeta.embedded);
    if (materializeInput !== undefined) {
      const entries = asArray(node.entry);
      entries.unshift(materializeInput);
      node.entry = entries;
    }
    if (!node.on) node.on = {};
    for (const [finalId, transition] of Object.entries(aharnessMeta.embedded.onMap)) {
      // Bare final-id event-type. Spec §5.2. Collision-safe because the host is
      // exclusive (verifier check `embedded-state-exclusive` in T11.5).
      const actions = asArray(transition.actions);
      if (aharnessMeta.embedded.canonicalOnMap?.[finalId] !== undefined) {
        actions.unshift(
          assign(({ event }) => {
            const commitContext = canonicalEmbeddedFinalCommitContext(event);
            if (commitContext === undefined) {
              if (isCanonicalDryRun()) return {};
              throw new Error(
                `Canonical embedded final '${finalId}' entered without aharness preflight metadata. ` +
                  'Drive canonical embeds through aharness submit, await, or event dispatchers.',
              );
            }
            return commitContext;
          }),
        );
      }
      node.on[finalId] = [
        {
          target: transition.target,
          ...(actions.length > 0 ? { actions } : {}),
          ...(transition.guard !== undefined ? { guard: transition.guard } : {}),
        },
      ];
    }
  }

  // 1b. Terminal node inside an embed subtree — inject the entry-raise.
  //     Stash the user's output fn (if any) in the per-machine registry under
  //     a path-keyed identifier; the named-action body resolves it at run time.
  if (aharnessMeta?.kind === 'terminal' && embeddedSource !== null) {
    const finalId = path[path.length - 1] ?? '';
    let registryKey: string | null = null;
    if (typeof aharnessMeta.output === 'function') {
      // Use '::output' as a separator — XState state-keys cannot contain colons,
      // so '<path>::output' cannot collide with any author identifier.
      registryKey = path.join('.') + '::output';
      outputRegistry.set(registryKey, aharnessMeta.output);
    }
    const entries = asArray(node.entry);
    entries.push({
      type: EMBEDDED_FINAL_RAISE,
      params: { finalId, registryKey },
    });
    node.entry = entries;
  }

  if (isStateful(node)) {
    const stateId = path.join('.');
    const sourceKey = path[path.length - 1] ?? '';
    // 2. Prepend VISIT_ACTION to entry (initial-entry visit++; self-loop
    //    visit++ is deposited on the synthesized transition action chain
    //    inside `buildBranch` since internal self-loops don't fire entry).
    const entries = asArray(node.entry);
    entries.unshift({ type: VISIT_ACTION, params: { stateId } });
    node.entry = entries;
    // 3. Synthesis pass — overwrite (or create) SUBMIT__ keys.
    const exits = aharnessMeta?.exits ?? {};
    if (!node.on) node.on = {};
    for (const [exitName, exit] of Object.entries(exits)) {
      if (exit.kind === 'await') {
        throw new Error(
          `aharness.machine(): await exit '${exitName}' is no longer accepted; use fsm.choice for framework-owned owner decisions.`,
        );
      }
      const eventKey = `SUBMIT__${stateId}__${exitName}`;
      const branches = synthesizeBranches(exit as DefaultedExitDef, stateId, sourceKey);
      node.on[eventKey] = branches;
    }
  }
  if (isChoice(node)) {
    const stateId = path.join('.');
    const sourceKey = path[path.length - 1] ?? '';
    const entries = asArray(node.entry);
    entries.unshift({ type: VISIT_ACTION, params: { stateId } });
    node.entry = entries;
    if (!node.on) node.on = {};
    node.on[`OWNER_CHOICE__${stateId}`] = synthesizeChoiceBranches(
      aharnessMeta?.options ?? [],
      stateId,
      sourceKey,
    );
  }
  // 4. Recurse, threading embeddedSource + registry.
  if (node.states) {
    for (const childKey of Object.keys(node.states)) {
      const child = node.states[childKey];
      if (child)
        injectFrameworkActions(child, [...path, childKey], nextEmbeddedSource, outputRegistry);
    }
  }
}

/**
 * Augment the user's `context` factory to merge framework defaults.
 * Forwards the full XState v5 args object so destructured `({ input })`
 * authors keep working.
 */
function wrapContext(originalContext: unknown): unknown {
  const defaults = { __aharness_lastOwnerReply: undefined, __aharness_visitCount: {} };
  if (typeof originalContext === 'function') {
    return (args: unknown) => ({
      ...defaults,
      ...((originalContext as (a: unknown) => Record<string, unknown>)(args) ?? {}),
    });
  }
  if (originalContext && typeof originalContext === 'object') {
    return { ...defaults, ...(originalContext as Record<string, unknown>) };
  }
  return defaults;
}

/**
 * Context factory shape exposed on the `aharness.machine` wrapper. Mirrors
 * XState's `ContextFactory` but pins the `input` parameter to the resolved
 * shape of the FSM's `input: { field: arg<T>() }` declaration intersected
 * with the framework-injected `AharnessInput` slot (`runDir`, `runId`), so
 * authors read `input.runDir` / `input.runId` without the historical
 * `as unknown as AharnessInput` cast. The CLI runtime merges
 * `{runId, runDir, ...userInput}` into the actor input before `createActor`
 * (see `cli/main.ts`); this type just surfaces that contract. `spawn` and
 * `self` are intentionally typed as `unknown` — XState's downstream wiring
 * keeps working at runtime (the wrapper forwards the full args object
 * verbatim through `wrapContext`); authors who need typed actor/spawn
 * handles can fall back to XState's `setup({...}).createMachine(...)` directly.
 */
type AharnessContextFactory<TInput, TContext> = (args: {
  readonly input: AharnessInput & TInput;
  readonly spawn: unknown;
  readonly self: unknown;
}) => TContext;

interface AharnessNamespace {
  getAssetUrl(relativePath: string): URL;
  getAssetText(relativePath: string, encoding?: BufferEncoding): string;
  /**
   * Generic order is `<const TInput, TContext>` so TS's contextual-typing
   * pass infers `TInput` from the non-context-sensitive `input:` literal
   * first, then resolves the `context:` callback's `input` parameter via
   * `ResolveInput<TInput>` and infers `TContext` from the callback's
   * return type. Authors get a typed `input` automatically (no manual
   * `({input}: {input: {topic: string}}): Ctx => …` annotation) and a
   * typed `TContext` flowing from the factory's return value (no explicit
   * `aharness.machine<Ctx>(…)` generic). The `const` modifier on `TInput`
   * preserves `arg<string>(…)` as `ArgSentinel<string>` (otherwise TS
   * widens to `ArgSentinel<unknown>`). Pattern: TanStack Query's
   * `useQuery({queryFn, select})`.
   */
  machine<
    const TInput extends Record<string, ArgSentinel> = Record<string, never>,
    TContext extends MachineContext = MachineContext,
    const TStates extends Record<string, unknown> = Record<string, never>,
  >(
    config: Omit<
      StateNodeConfig<
        TContext,
        AnyEventObject,
        ProvidedActor,
        ParameterizedObject,
        ParameterizedObject,
        string,
        string,
        unknown,
        EventObject,
        // xstate@5.30.0's StateNodeConfig has 10 generics (types.d.ts).
        // The last is TMeta extends MetaObject; we pass `MetaObject` (the
        // xstate default, defined as `Record<string, any>`) so the public
        // API stays ergonomic — authors who care about meta typing can pass
        // `types: { meta: ... }` in the config which xstate consumes
        // downstream.
        MetaObject
      >,
      'output' | 'states'
    > & {
      // Top-level `MachineConfig` adds `version`, `output`, and a
      // conditional `context: …` intersection on top of `StateNodeConfig`.
      // We expose `version` and the aharness-typed `context:` directly here;
      // we deliberately DO NOT extend `MachineConfig` because the conditional
      // `(MachineContext extends TContext ? {context?:…} : {context:…})`
      // intersection breaks TS's contextual typing of our `context:` callback
      // and the destructured `({input})` parameter resolves to `any`. The
      // wrapper-level `output` slot is intentionally omitted — author FSMs
      // produce their final outputs through `final({output})` (see
      // `state/exits.ts`), not through the root machine's `output` slot.
      readonly version?: string;
      // Optional root-level `input` declaration: a record of `arg<T>()`
      // sentinels. The field stays on the root config after synthesis
      // (Phase 1's `embed()` already snapshots `__aharnessRawConfig` BEFORE
      // synthesis runs, so the snapshot preserves it for free); the
      // verifier and CLI loader read the declaration from
      // `embedded.childConfig.input` and `machine.config.input`
      // respectively. XState's runtime ignores unrecognised root keys —
      // the field is data, not behavior.
      readonly input?: TInput;
      // Typed root `context:` factory. The `input` parameter is
      // `ResolveInput<TInput>` — the resolved object shape of the FSM's
      // declared `input:` fields — so authors get a typed `input` without
      // manual `({input}: {input: {topic: string}}): Ctx => …` annotations.
      // The factory's return type is the inference site for `TContext`.
      readonly context?: AharnessContextFactory<ResolveInput<TInput>, TContext>;
      // Author-visible `states:` map. Lifted out of the `Omit<…>` parent
      // (we elide `'states'` above) and re-declared here with `const
      // TStates` literal-preserving inference so `ExtractFinals<TStates>`
      // can walk each `FinalConfig<TOutput>` entry to populate
      // `AharnessMachine.__finalsType`. The narrower `Record<string,
      // unknown>` constraint on `TStates` is structurally compatible with
      // XState's per-state config shape — the `aharnessMachineImpl` body
      // casts the config to `AnyConfig` before the synthesis walk runs
      // either way, so the public-surface relaxation does not weaken
      // runtime semantics.
      readonly states: TStates;
    },
  ): AharnessMachine<TContext, AnyEventObject, ResolveInput<TInput>, ExtractFinals<TStates>>;
}

// Implementation: `aharness.machine(config)`. Author-facing generics
// (`TContext`, `TEvent`, `TInput`) are declared on the `AharnessNamespace`
// signature above and erased here — the body cannot prove its concrete
// return shape is assignable to the call-site-instantiated generic, so the
// implementation accepts `config: unknown` and returns `AnyStateMachine`,
// then the `aharness` export casts the assembled namespace literal as
// `AharnessNamespace` (a single boundary cast). Runtime semantics are
// identical to the typed public surface.
function aharnessMachineImpl(config: unknown): AnyStateMachine {
  // Internally re-cast to the loose walker type because
  // `injectFrameworkActions` mutates the config (adding synthesized `on:`
  // keys, prepending entry actions) — operations that are awkward to
  // express against the strict `MachineConfig<…>` shape without per-state
  // generics.
  const looseConfig = config as AnyConfig;
  // Snapshot the input config BEFORE the in-place synthesis pass mutates
  // it. The snapshot is a structural deep-clone that preserves function
  // references (callbacks, action factories, function-form
  // `entryPrompt`, etc.) — `structuredClone` would strip them. The
  // top-level is shallow-frozen so callers cannot replace `states`; inner
  // objects stay writable so `embed()` can clone them and mutate the clone.
  // Spec §5.1: `embed()` reads this snapshot via `__aharnessRawConfig` to
  // walk a clean pre-synthesis copy of the child config.
  const rawSnapshot = Object.freeze(cloneConfigPreservingFns(looseConfig));
  // Per-machine registry of `final({output})` callbacks, keyed by the
  // qualified state path. The synthesizer registers each callback during
  // the walk; the named action `__aharnessEmbeddedFinalRaise` resolves
  // entries at run time via closure capture below. No module-global
  // state — multiple compiled machines in the same process keep their
  // own callbacks. Spec §5.2.
  const outputRegistry: OutputRegistry = new Map();
  // Mutate in place — never JSON-clone. The user's config is consumed once
  // by `aharness.machine` so in-place augmentation is safe.
  injectFrameworkActions(looseConfig, [], null, outputRegistry);
  const augmentedConfig = {
    ...(looseConfig as object),
    context: wrapContext((looseConfig as { context?: unknown }).context),
  };

  const setupResult = setup({
    actions: {
      // VISIT_ACTION uses XState v5's params channel: implementations
      // receive `(_, params)`. The state id cannot be derived from the
      // triggering event (entry actions fire on every entry regardless of
      // event type), so we encode it in `params` at config-walk time.
      [VISIT_ACTION]: assign(({ context }, params) => {
        if (
          params === null ||
          typeof params !== 'object' ||
          typeof (params as { stateId?: unknown }).stateId !== 'string'
        ) {
          throw new Error(
            `__aharnessIncrementVisit: missing or non-string 'stateId' param (got ${JSON.stringify(params)})`,
          );
        }
        const { stateId } = params as { stateId: string };
        const counts =
          (context as { __aharness_visitCount?: Record<string, number> }).__aharness_visitCount ??
          {};
        return {
          __aharness_visitCount: {
            ...counts,
            [stateId]: (counts[stateId] ?? 0) + 1,
          },
        };
      }),
      // CLEAR_OWNER_REPLY clears unconditionally. Self-loops never receive
      // this action — `injectFrameworkActions` skips them at config-walk
      // time so the resolved transition's action array stays untouched.
      [CLEAR_OWNER_REPLY]: assign(() => ({ __aharness_lastOwnerReply: undefined })),
      // EMBEDDED_FINAL_RAISE — entry action injected on every `final()` node
      // reached inside an embed subtree. Resolves the user's `output()`
      // callback (registered by `injectFrameworkActions`) via closure-captured
      // `outputRegistry`, then raises a bare-named event `{type: <finalId>,
      // output}`. XState's run-to-completion semantics drain the raise within
      // the same macrostep so subscribers see only the post-drain snapshot
      // (spec §5.2). Bare type — no `FINAL_` prefix; collision-safe because
      // the embed-host is exclusive (verifier check `embedded-state-exclusive`).
      [EMBEDDED_FINAL_RAISE]: raise(({ context, event }, params) => {
        if (
          params === null ||
          typeof params !== 'object' ||
          typeof (params as { finalId?: unknown }).finalId !== 'string'
        ) {
          throw new Error(
            `${EMBEDDED_FINAL_RAISE}: missing or non-string 'finalId' param (got ${JSON.stringify(params)})`,
          );
        }
        const { finalId, registryKey } = params as {
          finalId: string;
          registryKey: string | null;
        };
        let output: unknown = undefined;
        if (registryKey !== null) {
          const fn = outputRegistry.get(registryKey);
          if (fn) output = fn({ context, event });
        }
        const embeddedCommitContext = canonicalEmbeddedFinalCommitContext(event);
        return {
          type: finalId,
          output,
          ...(embeddedCommitContext !== undefined
            ? { payload: payloadWithCanonicalEmbeddedFinalCommit({}, embeddedCommitContext) }
            : {}),
        };
      }),
    },
  });

  // The `aharness.machine` wrapper accepts any user config shape (typed
  // through their own `setup({ types: { context, events } })` call).
  // Setup's `createMachine` expects a config narrowed against the resolved
  // generic types of the inner setup() — but our inner setup() only declares
  // framework actions, so the user's full event/context types do not flow
  // through. The cast bridges that gap; runtime semantics are unchanged.
  type CreateMachineArg = Parameters<typeof setupResult.createMachine>[0];
  const machine = setupResult.createMachine(augmentedConfig as CreateMachineArg);

  // Stash the pre-synthesis raw config on the compiled machine as a
  // non-enumerable, non-configurable, non-writable property. `embed()`
  // (spec §5.1) reads this to walk a clean pre-mutation copy of the
  // child's config under qualified state IDs. Non-enumerable so it does
  // not surface in `Object.keys` / `JSON.stringify`; non-configurable +
  // non-writable so callers cannot redefine or overwrite it.
  Object.defineProperty(machine, '__aharnessRawConfig', {
    value: rawSnapshot,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return machine as AnyStateMachine;
}

function getAssetUrlImpl(relativePath: string): URL {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('file://')) {
    throw new Error(
      'aharness.getAssetUrl: installed-package asset calls must be compiled and validated ' +
        'by the package-aware loader before runtime',
    );
  }

  const url = new URL(relativePath);
  if (url.protocol !== 'file:') {
    throw new Error('aharness.getAssetUrl: compiled asset URL must use the file: protocol');
  }
  return pathToFileURL(fileURLToPath(url));
}

function getAssetTextImpl(relativePath: string, encoding: BufferEncoding = 'utf8'): string {
  return readFileSync(getAssetUrlImpl(relativePath), encoding);
}

// Cast the implementation to the typed namespace surface. The runtime
// `aharnessMachineImpl` returns `AnyStateMachine`; the namespace declares
// `AharnessMachine<TContext, TEvent, {…}>` parameterised by the call site.
// Both are equal at runtime — `AharnessMachine<…>` extends `AnyStateMachine`
// and adds only phantom (compile-time-only) fields whose runtime value is
// `undefined`. The single `as AharnessNamespace` cast is the boundary where
// the implementation's erased type meets the typed public surface.
export const aharness: AharnessNamespace = {
  getAssetUrl: getAssetUrlImpl,
  getAssetText: getAssetTextImpl,
  machine: aharnessMachineImpl,
} as AharnessNamespace;
