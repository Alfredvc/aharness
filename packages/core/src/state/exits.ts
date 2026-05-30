/**
 * State primitive for stateful states — `docs/specs/2026-04-29-state-posture-and-exits-design.md` §3.
 *
 * Authors call `state({ exits, open?, entryPrompt, stopGuidance? })`. The function
 * returns a full XState state config (`{ meta: { aharness: ... } }`) that can be placed
 * directly as the state node value in a `aharness.machine(...)` config — no additional
 * `meta.aharness` wrapper is needed. Submit exits are wrapped in an `exit<TPayload>({...})`
 * factory call; the `<TPayload>` type argument is read by the loader via the TypeScript
 * compiler API to emit a JSON Schema 7 fragment per submit exit. At runtime the factory
 * returns the body verbatim plus an opaque `__aharnessPayloadMarker: true` sentinel.
 */
import type {
  Action as XStateAction,
  EventObject,
  GuardPredicate,
  MachineContext,
  ParameterizedObject,
  ProvidedActor,
} from 'xstate';
import type { RunCtx } from '../types.js';
import type { AharnessOps } from './aharnessOps.js';
import type { StateHooks } from './hooks.js';
import { isSkillRef, type SkillRef } from './skills.js';

/**
 * Submit-event shape seen by inline `actions` / `guard` callbacks declared
 * inside an exit. The `type` field is the synthesized
 * `SUBMIT__<stateId>__<exitName>` key (authors do not write these); the
 * payload is the data the model submits via `aharness_submit`.
 */
export interface SubmitEventLike<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
}

/**
 * XState 5 action and guard reference shapes. Authors write either a
 * named reference (string), a parameterised reference, or an inline
 * function — the synthesizer passes them through verbatim into the
 * resolved transition config; XState's `setup({actions, guards})` resolves
 * names against the framework + author registries.
 *
 * Generic in `<TContext, TPayload>` so inline `assign(({event}) => …)` and
 * inline `({event}) => …` guards see `event.payload` typed as `TPayload`
 * and `context` typed as `TContext`. The callable arms reuse xstate's
 * own `Action` / `GuardPredicate` types so no fresh structural mismatch
 * arises with `assign(...)` outputs. The `params` channel is xstate v5's
 * orthogonal "params" slot (used by framework actions like
 * `__aharnessIncrementVisit({stateId})`) — distinct from `event.payload`;
 * do not thread `TPayload` into the params slot.
 */
export type Action<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> = XStateAction<
  TContext,
  SubmitEventLike<TPayload>,
  EventObject,
  ParameterizedObject['params'] | undefined,
  ProvidedActor,
  ParameterizedObject,
  ParameterizedObject,
  string,
  EventObject
>;

export type Guard<TContext extends MachineContext = MachineContext, TPayload = unknown> =
  | string
  | { readonly type: string; readonly params?: Record<string, unknown> }
  | GuardPredicate<
      TContext,
      SubmitEventLike<TPayload>,
      ParameterizedObject['params'] | undefined,
      ParameterizedObject
    >;

/**
 * One branch of a multi-branch (`when[]`) submit exit. Each branch is a
 * fully self-contained transition — there is no "default actions that
 * always run" bound at the exit level. The synthesizer emits one XState
 * transition entry per branch; the final entry MUST be unguarded
 * (verifier check `when-last-unguarded`) so coverage is total.
 */
export interface SubmitBranch<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> {
  readonly guard?: Guard<TContext, TPayload>;
  readonly to: string;
  readonly actions?: Action<TContext, TPayload> | ReadonlyArray<Action<TContext, TPayload>>;
  readonly __aharnessCanonical?: CanonicalSubmitBranchMeta<TContext, TPayload>;
}

/**
 * Single-branch submit exit (the sugar form). 95% of states use this.
 * `kind` defaults to `'submit'` if omitted — only `await` exits require
 * an explicit `kind`. The verifier rejects mixing this shape with
 * `when:` (check `exit-shape-exclusive`).
 *
 * Authors construct submit exits via the `exit<TPayload>({...})` factory,
 * which stamps `__aharnessPayloadMarker: true` on the returned object. The
 * loader anchors on the `exit<T>(...)` call expression to extract `T` for
 * JSON Schema emission; the sentinel flag is the runtime check used by
 * `state(...)`'s belt-and-suspenders validator.
 */
export interface SubmitExitSugar<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> {
  readonly kind?: 'submit';
  readonly __aharnessPayloadMarker: true;
  readonly to: string;
  readonly guard?: Guard<TContext, TPayload>;
  readonly actions?: Action<TContext, TPayload> | ReadonlyArray<Action<TContext, TPayload>>;
  readonly description?: string;
  readonly __aharnessCanonical?: CanonicalSubmitMeta<TContext, TPayload>;
}

/**
 * Multi-branch submit exit. `when:` MUST have `length >= 2`; the last
 * entry MUST be unguarded (the catch-all). The verifier enforces both
 * (`when-array-min-length-2`, `when-last-unguarded`).
 */
export interface SubmitExitMulti<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> {
  readonly kind?: 'submit';
  readonly __aharnessPayloadMarker: true;
  readonly when: ReadonlyArray<SubmitBranch<TContext, TPayload>>;
  readonly description?: string;
  readonly __aharnessCanonical?: CanonicalSubmitMeta<TContext, TPayload>;
}

/**
 * Await exit — single-branch only. AWAIT events carry only
 * `{ownerReply: string}`; guarding on free text would reintroduce
 * transition-by-text in violation of hard rule #3. Verifier rejects
 * `{kind: 'await', when: [...]}` (`await-no-multi-branch`).
 *
 * No `TPayload` generic — AWAIT events carry the framework-managed
 * `{ownerReply: string}` payload exclusively. The `actions` slot is
 * typed against that fixed shape so an inline `assign(({event}) => …)`
 * sees `event.payload.ownerReply` typed.
 */
export interface AwaitExitDef<TContext extends MachineContext = MachineContext> {
  readonly kind: 'await';
  readonly to: string;
  readonly actions?:
    | Action<TContext, { readonly ownerReply: string }>
    | ReadonlyArray<Action<TContext, { readonly ownerReply: string }>>;
  readonly description?: string;
  readonly __aharnessCanonical?: CanonicalAwaitMeta<TContext>;
}

export type ExitDef<TContext extends MachineContext = MachineContext, TPayload = unknown> =
  | SubmitExitSugar<TContext, TPayload>
  | SubmitExitMulti<TContext, TPayload>
  | AwaitExitDef<TContext>;

export type CanonicalSubmitEffect<TContext = unknown, TPayload = unknown> = (args: {
  readonly data: Readonly<TContext>;
  readonly payload: TPayload;
  readonly ops: AharnessOps;
}) => void | Promise<void>;

export type CanonicalSubmitReducer<TContext = unknown, TPayload = unknown> = (
  draft: TContext,
  payload: TPayload,
) => void | Partial<TContext>;

export type CanonicalAwaitEffect<TContext = unknown> = (args: {
  readonly data: Readonly<TContext>;
  readonly ownerReply: string;
  readonly ops: AharnessOps;
}) => void | Promise<void>;

export type CanonicalAwaitReducer<TContext = unknown> = (
  draft: TContext,
  ownerReply: string,
) => void | Partial<TContext>;

export interface CanonicalSubmitBranchMeta<TContext = unknown, TPayload = unknown> {
  readonly predicate?: (data: Readonly<TContext>, payload: TPayload) => boolean;
  readonly to?: string;
  readonly effect?: CanonicalSubmitEffect<TContext, TPayload>;
  readonly reduce?: CanonicalSubmitReducer<TContext, TPayload>;
  readonly hasActions?: boolean;
}

export interface CanonicalSubmitMeta<TContext = unknown, TPayload = unknown> {
  readonly kind: 'submit';
  readonly branches: ReadonlyArray<CanonicalSubmitBranchMeta<TContext, TPayload>>;
}

export interface CanonicalAwaitMeta<TContext = unknown> {
  readonly kind: 'await';
  readonly ask: string | ((ctx: TContext & RunCtx) => string);
  readonly effect?: CanonicalAwaitEffect<TContext>;
  readonly reduce?: CanonicalAwaitReducer<TContext>;
}

export type CanonicalEventKind =
  | 'custom'
  | 'permissionRequest'
  | 'preToolUse'
  | 'postToolUse'
  | 'userPromptSubmit';

export type CanonicalEventEffect<TContext = unknown, TPayload = unknown> = (args: {
  readonly data: Readonly<TContext>;
  readonly payload: TPayload;
  readonly ops: AharnessOps;
}) => void | Promise<void>;

export type CanonicalEventReducer<TContext = unknown, TPayload = unknown> = (
  draft: TContext,
  payload: TPayload,
) => void | Partial<TContext>;

export type CanonicalEventReturn<TContext = unknown, TPayload = unknown, TReturn = unknown> = (
  data: Readonly<TContext>,
  payload: TPayload,
) => TReturn;

export interface CanonicalEventBranchMeta<
  TContext = unknown,
  TPayload = unknown,
  TReturn = unknown,
> {
  readonly predicate?: (data: Readonly<TContext>, payload: TPayload) => boolean;
  readonly to?: string;
  readonly effect?: CanonicalEventEffect<TContext, TPayload>;
  readonly reduce?: CanonicalEventReducer<TContext, TPayload>;
  readonly return?: CanonicalEventReturn<TContext, TPayload, TReturn>;
  readonly actions?: Action | ReadonlyArray<Action>;
}

export interface CanonicalEventMeta<TContext = unknown, TPayload = unknown, TReturn = unknown> {
  readonly kind: 'event';
  readonly eventKind: CanonicalEventKind;
  readonly request: boolean;
  readonly defaultReturn?: TReturn;
  readonly match?: string;
  readonly branches: ReadonlyArray<CanonicalEventBranchMeta<TContext, TPayload, TReturn>>;
}

export type CanonicalTransitionMeta<TContext = unknown, TPayload = unknown> =
  | CanonicalSubmitMeta<TContext, TPayload>
  | CanonicalAwaitMeta<TContext>;

/**
 * Internal type representing an `ExitDef` after the `kind: 'submit'`
 * defaulting pass has run (inside `state(...)`). All `kind` discriminants
 * are present and exact. The synthesizer (Task 6) and validator operate on
 * this post-default shape — never on raw author input where `kind` may
 * still be `undefined` for sugar submits.
 */
export type DefaultedExitDef<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> =
  | (SubmitExitSugar<TContext, TPayload> & { kind: 'submit' })
  | (SubmitExitMulti<TContext, TPayload> & { kind: 'submit' })
  | AwaitExitDef<TContext>;

export interface ExitCatalogItem {
  readonly name: string;
  readonly kind: 'submit' | 'await';
  /** First-branch target for multi-branch submits; preserves shape for downstream introspection. */
  readonly to: string;
  readonly description?: string;
}

export type ExitCatalog = ReadonlyArray<ExitCatalogItem>;

/**
 * Free-text owner-yield declaration. Authors set this on a state when
 * the model should pause and ask the human for free-text input before
 * making any submit decision.
 *
 * Runtime effect: on state entry, the framework orientation preamble
 * instructs the model to call codex's built-in `request_user_input`
 * (with the resolved `messageToUser` as the question text) BEFORE
 * submitting. The user's reply is returned to the model directly as the
 * `request_user_input` tool-call result; the model uses it when
 * constructing the subsequent `submit` payload. The reply does NOT fire
 * an FSM transition — only the typed `submit` call does (hard rule #3).
 * The aharness daemon is not in the reply path; no UDS framing, no
 * `userMessage` observer, no separate MCP tool.
 *
 * Orthogonal to `exits` — a state with `awaitsOwnerText` still declares
 * `submit`-kind exits; no `await`-kind exit is needed or allowed
 * (the two mechanisms are alternatives; combining them is rejected at
 * construction time and by the verifier check
 * `awaits-owner-text-no-await-exit`).
 */
export interface AwaitsOwnerTextDecl<TContext extends MachineContext = MachineContext> {
  /** The prompt the user sees, verbatim. */
  readonly messageToUser: string | ((ctx: TContext & RunCtx) => string);
}

/**
 * Author-supplied entry hook invoked after the FSM advances to a state.
 * Receives the post-transition context and the typed reserved
 * `AharnessOps` facade. Clear is declarative state metadata
 * (`clearOnEntry`), not an imperative operation.
 *
 * Fires from two paths: submit-driven transitions (`dispatchSubmit`,
 * after commit and post-transition bookkeeping) and await-resolution /
 * first-state-boot (`onStateEntry`). Legacy snapshot inspection does NOT
 * re-fire `onEntry` — only fresh state entries trigger it.
 */
export type OnEntryFn<TContext = unknown> = (
  ctx: Readonly<TContext>,
  ops: AharnessOps,
) => Promise<void> | void;

type ClearOnEntryCwd = string | ((ctx: Readonly<RunCtx>) => string);

export type StateModelEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const stateModelEfforts = new Set<StateModelEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export interface StateModelMeta {
  readonly name?: string;
  readonly effort?: StateModelEffort;
}

type StateModelOption<_TContext extends MachineContext> = {
  readonly name?: string;
  readonly effort?: StateModelEffort;
};

export type ClearOnEntryReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ClearOnEntryMeta =
  | true
  | {
      readonly cwd?: ClearOnEntryCwd;
    };

type ClearOnEntryOption<TContext extends MachineContext> =
  | boolean
  | {
      readonly cwd?: string | ((ctx: Readonly<TContext & RunCtx>) => string);
    };

export interface AharnessStateMeta {
  readonly kind: 'stateful';
  readonly open: boolean;
  readonly entryPrompt: string | ((ctx: RunCtx) => string);
  readonly exits: Readonly<Record<string, ExitDef>>;
  /** Visualization-only hint: include this state in the primary graph spine. */
  readonly main?: true;
  readonly stopGuidance?: (ctx: RunCtx, exits: ExitCatalog) => string;
  readonly awaitsOwnerText?: AwaitsOwnerTextDecl;
  readonly onEntry?: OnEntryFn;
  readonly clearOnEntry?: ClearOnEntryMeta;
  readonly model?: StateModelMeta;
  readonly hooks?: StateHooks<unknown>;
  readonly canonicalEvents?: Readonly<Record<string, CanonicalEventMeta>>;
  /**
   * Skill bodies the framework injects into the per-state orientation
   * nudge on entry. Each entry is a `SkillRef` returned by the `skill()`
   * factory (`state/skills.ts`). Once-per-run dedupe — the same key only
   * injects on the first entry that references it; later entries (any
   * state) skip. Fresh `clearOnEntry` threads begin with empty model
   * context and receive the active state's orientation again.
   */
  readonly skills?: ReadonlyArray<SkillRef>;
}

/**
 * Author-side options for `state<TContext>(...)`.
 *
 * Per-state callback parameters (`entryPrompt`, `stopGuidance`,
 * `awaitsOwnerText.messageToUser`) are typed as `TContext & RunCtx` so
 * authors writing `state<Ctx>({ entryPrompt: (ctx) => ctx.foo })` see
 * `ctx` as `Ctx` (intersected with the framework-managed read-only fields)
 * without an explicit cast.
 *
 * The `exits` field stores defaulted `ExitDef`s with widened `TContext` /
 * `TPayload` (each exit independently carries its `TPayload` via the
 * `exit<TPayload>(...)` factory; the per-branch `event.payload` typing
 * lands inside the factory's own `ExitOptions<…, TPayload>` argument
 * shape). The slot type uses `any` for both `TContext` and `TPayload` —
 * `Action` and `Guard` are contravariant in their parameters, so narrower
 * `ExitDef<MyCtx, MyPayload>` returned by `exit<MyPayload>({...})` is
 * assignable to `ExitDef<any, any>`. Using `unknown` would reject those
 * narrower callers because `unknown` is not assignable from `MyPayload`
 * in the contravariant position.
 */
export interface StateOptions<TContext extends MachineContext = MachineContext> {
  readonly entryPrompt: string | ((ctx: TContext & RunCtx) => string);
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly exits: Readonly<Record<string, ExitDef<any, any>>>;
  readonly open?: boolean;
  readonly main?: boolean;
  readonly stopGuidance?: (ctx: TContext & RunCtx, exits: ExitCatalog) => string;
  readonly awaitsOwnerText?: AwaitsOwnerTextDecl<TContext>;
  readonly onEntry?: OnEntryFn<TContext>;
  readonly clearOnEntry?: ClearOnEntryOption<TContext>;
  readonly model?: StateModelOption<TContext>;
  readonly hooks?: StateHooks<TContext>;
  readonly canonicalEvents?: Readonly<Record<string, CanonicalEventMeta<TContext>>>;
  readonly skills?: ReadonlyArray<SkillRef>;
}

export interface StateConfig {
  readonly meta: { readonly aharness: AharnessStateMeta };
}

function normalizeClearOnEntry<TContext extends MachineContext>(
  value: ClearOnEntryOption<TContext> | undefined,
): AharnessStateMeta['clearOnEntry'] {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      'state(): clearOnEntry must be true, false, or an object with at least one supported key: cwd',
    );
  }
  const cwd = (value as { readonly cwd?: unknown }).cwd;
  if (
    Object.prototype.hasOwnProperty.call(value, 'model') ||
    Object.prototype.hasOwnProperty.call(value, 'reasoningEffort')
  ) {
    throw new TypeError(
      'state(): clearOnEntry no longer accepts model or reasoningEffort. Move these settings to state-level `model: { name, effort }`.',
    );
  }
  if (cwd === undefined) {
    throw new TypeError(
      'state(): clearOnEntry object must include at least one supported key: cwd',
    );
  }
  if (cwd !== undefined && typeof cwd !== 'string' && typeof cwd !== 'function') {
    throw new TypeError('state(): clearOnEntry.cwd must be a string or function');
  }
  return { cwd: cwd as ClearOnEntryCwd };
}

function normalizeStateModel<TContext extends MachineContext>(
  value: StateModelOption<TContext> | undefined,
): StateModelMeta | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      'state(): model must be an object with at least one supported key: name, effort',
    );
  }
  const name = (value as { readonly name?: unknown }).name;
  const effort = (value as { readonly effort?: unknown }).effort;
  if (name === undefined && effort === undefined) {
    throw new TypeError(
      'state(): model object must include at least one supported key: name, effort',
    );
  }
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('state(): model.name must be a non-empty string');
  }
  if (
    effort !== undefined &&
    (typeof effort !== 'string' || !stateModelEfforts.has(effort as StateModelEffort))
  ) {
    throw new TypeError(
      'state(): model.effort must be one of: none, minimal, low, medium, high, xhigh',
    );
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(effort !== undefined ? { effort: effort as StateModelEffort } : {}),
  };
}

export function state<TContext extends MachineContext = MachineContext>(
  opts: StateOptions<TContext>,
): StateConfig {
  // Defaulting passes happen BEFORE validation passes (decision #13).
  // Walk the exits map once and fill in `kind: 'submit'` on any exit that
  // omits it. Sugar form authors write no `kind:` field; this restores the
  // discriminant the rest of the codepath relies on.
  const defaultedExits: Record<string, ExitDef> = {};
  for (const [name, exit] of Object.entries(opts.exits ?? {})) {
    if (exit === undefined) continue;
    if ((exit as { kind?: unknown }).kind === undefined) {
      defaultedExits[name] = { ...(exit as object), kind: 'submit' } as ExitDef;
    } else {
      // Widen to default-parameterised `ExitDef` for storage on the
      // non-generic `AharnessStateMeta`; the author-facing generics only
      // type author-supplied inline `actions` / `guard` callbacks.
      defaultedExits[name] = exit as ExitDef;
    }
  }

  // Belt-and-suspenders runtime checks duplicate verifier checks. The
  // verifier only runs inside `aharness <file>`; `aharness.machine(config)`
  // is also callable from unit tests / scripts / examples without going
  // through the verifier. Throwing here gives an early failure with a
  // clear stack trace at machine-construction time, before any FSM event
  // is processed.
  if (
    opts.entryPrompt === undefined ||
    (typeof opts.entryPrompt === 'string' && opts.entryPrompt.length === 0)
  ) {
    throw new TypeError('state(): entryPrompt must be a non-empty string or function');
  }
  const exitNames = Object.keys(defaultedExits);
  if (exitNames.length === 0 && opts.canonicalEvents === undefined) {
    throw new TypeError('state(): at least one exit is required');
  }
  for (const name of exitNames) {
    const exit = defaultedExits[name];
    if (!exit) continue;
    validateExit(name, exit);
  }
  if (opts.awaitsOwnerText !== undefined) {
    const m = opts.awaitsOwnerText.messageToUser;
    if (m === undefined || (typeof m === 'string' && m.length === 0)) {
      throw new TypeError(
        'state(): awaitsOwnerText.messageToUser must be a non-empty string or function',
      );
    }
    if (typeof m !== 'string' && typeof m !== 'function') {
      throw new TypeError('state(): awaitsOwnerText.messageToUser must be a string or function');
    }
    // Reject `awaitsOwnerText` + any `await`-kind exit on the same state
    // (decisions #10, #14). Mental model is "use one or the other"; verifier
    // rule lives here in the same file as the rest of the meta validation.
    for (const [name, exit] of Object.entries(defaultedExits)) {
      if (exit?.kind === 'await') {
        throw new TypeError(
          `state(): cannot declare awaitsOwnerText together with await exit '${name}' (use one or the other)`,
        );
      }
    }
  }
  if (opts.onEntry !== undefined && typeof opts.onEntry !== 'function') {
    throw new TypeError('state(): onEntry must be a function');
  }
  const clearOnEntry = normalizeClearOnEntry(opts.clearOnEntry);
  const model = normalizeStateModel(opts.model);
  if (opts.main !== undefined && typeof opts.main !== 'boolean') {
    throw new TypeError('state(): main must be a boolean when provided');
  }
  if (opts.hooks !== undefined) {
    validateStateHooks(opts.hooks);
  }
  if (opts.skills !== undefined) {
    validateSkills(opts.skills);
  }
  // Coerce the typed-at-author-surface callback shapes (TContext & RunCtx)
  // back to the storage shape (RunCtx) on `AharnessStateMeta`. The runtime
  // is RunCtx-only — the daemon never knows author TContext — so the stash
  // is intentionally widened. Pattern matches the existing `onEntry` cast.
  // Build the meta in two steps so `exactOptionalPropertyTypes: true` doesn't
  // see `stopGuidance: ((…) => string) | undefined`.
  const meta = {
    kind: 'stateful' as const,
    open: opts.open === true,
    entryPrompt: opts.entryPrompt as AharnessStateMeta['entryPrompt'],
    exits: defaultedExits,
    ...(opts.main === true ? { main: true as const } : {}),
    ...(opts.stopGuidance !== undefined
      ? {
          stopGuidance: opts.stopGuidance as unknown as NonNullable<
            AharnessStateMeta['stopGuidance']
          >,
        }
      : {}),
    ...(opts.awaitsOwnerText !== undefined
      ? { awaitsOwnerText: opts.awaitsOwnerText as AwaitsOwnerTextDecl }
      : {}),
    ...(opts.onEntry !== undefined ? { onEntry: opts.onEntry as OnEntryFn } : {}),
    ...(clearOnEntry !== undefined ? { clearOnEntry } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks as StateHooks<unknown> } : {}),
    ...(opts.canonicalEvents !== undefined
      ? { canonicalEvents: opts.canonicalEvents as Readonly<Record<string, CanonicalEventMeta>> }
      : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
  } satisfies AharnessStateMeta;
  return { meta: { aharness: meta } };
}

/**
 * `exit<TPayload>(opts)` — author factory for submit exits.
 *
 * Wraps the body of a submit exit (single-branch or `when[]` multi-branch)
 * with the runtime payload-marker sentinel the rest of the framework uses
 * to validate that an exit declaration came from an author-supplied submit
 * (vs. an `await` exit, which is the only other shape allowed in `exits:`
 * maps). The TypeScript type argument `TPayload` flows into the factory's
 * options' `when[].guard` / `when[].actions` / sugar `actions` callback
 * shapes so author-written inline callbacks see `event.payload: TPayload`
 * verbatim. The loader's AST walker anchors on the `exit<T>(...)` call
 * expression and reads `T` from its `typeArguments[0]` to emit the JSON
 * Schema for the runtime ajv validator.
 *
 * `TContext` defaults to `MachineContext` because the parent `state<TContext>`
 * has no way to thread its own `TContext` into the factory's argument: by
 * the time the factory call is type-checked, the parent state's generic is
 * not yet bound. Authors who want narrower `context` typing inside an
 * inline `({context}) => …` branch callback must either pass `<TPayload, TContext>`
 * explicitly (`exit<P, MyCtx>({...})`) or write the parameter type at the
 * lambda site. `event.payload` is unaffected — it is typed as `TPayload`
 * regardless.
 */
export interface ExitOptionsSugar<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> {
  readonly to: string;
  readonly guard?: Guard<TContext, TPayload>;
  readonly actions?: Action<TContext, TPayload> | ReadonlyArray<Action<TContext, TPayload>>;
  readonly description?: string;
  readonly __aharnessCanonical?: CanonicalSubmitMeta<TContext, TPayload>;
}

export interface ExitOptionsMulti<
  TContext extends MachineContext = MachineContext,
  TPayload = unknown,
> {
  readonly when: ReadonlyArray<SubmitBranch<TContext, TPayload>>;
  readonly description?: string;
  readonly __aharnessCanonical?: CanonicalSubmitMeta<TContext, TPayload>;
}

export type ExitOptions<TContext extends MachineContext = MachineContext, TPayload = unknown> =
  | ExitOptionsSugar<TContext, TPayload>
  | ExitOptionsMulti<TContext, TPayload>;

export function exit<TPayload, TContext extends MachineContext = MachineContext>(
  opts: ExitOptions<TContext, TPayload>,
): ExitDef<TContext, TPayload> {
  return {
    ...(opts as object),
    __aharnessPayloadMarker: true,
  } as ExitDef<TContext, TPayload>;
}

function validateExit(name: string, exit: ExitDef): void {
  if (exit.kind === 'await') {
    if ((exit as { __aharnessPayloadMarker?: unknown }).__aharnessPayloadMarker === true) {
      throw new TypeError(
        `state(): exit '${name}' is await but is wrapped in exit<T>() (await exits use a plain object literal — no payload, no factory wrap)`,
      );
    }
    if ('when' in exit) {
      // Verifier check `await-no-multi-branch` — also runs at static
      // verifier time, but this throw catches it at machine-load time too.
      throw new TypeError(`state(): await exit '${name}' cannot use when[] (single-branch only)`);
    }
    if (typeof exit.to !== 'string' || exit.to.length === 0) {
      throw new TypeError(`state(): await exit '${name}' must declare 'to'`);
    }
    return;
  }
  // submit (sugar OR when[])
  if ((exit as { __aharnessPayloadMarker?: unknown }).__aharnessPayloadMarker !== true) {
    throw new TypeError(
      `state(): submit exit '${name}' must be wrapped in exit<T>({...}) (the wrapper stamps the runtime payload marker the loader's AST walker anchors on)`,
    );
  }
  const hasSugarTo = 'to' in exit && (exit as { to?: unknown }).to !== undefined;
  const hasWhen = 'when' in exit && (exit as { when?: unknown }).when !== undefined;
  if (hasSugarTo && hasWhen) {
    // Verifier check `exit-shape-exclusive` — also runtime-throws here.
    throw new TypeError(
      `state(): submit exit '${name}' cannot have both 'to' (sugar form) and 'when' (multi-branch)`,
    );
  }
  if (!hasSugarTo && !hasWhen) {
    throw new TypeError(
      `state(): submit exit '${name}' must declare either 'to' (sugar) or 'when' (multi-branch)`,
    );
  }
  if (hasSugarTo) {
    const to = exit.to;
    if (typeof to !== 'string' || to.length === 0) {
      throw new TypeError(`state(): submit exit '${name}' 'to' must be a non-empty string`);
    }
    return;
  }
  // when[]
  const whenRaw: unknown = (exit as SubmitExitMulti).when;
  if (!Array.isArray(whenRaw)) {
    throw new TypeError(`state(): submit exit '${name}' when must be an array`);
  }
  const when = whenRaw as ReadonlyArray<SubmitBranch>;
  if (when.length === 0) {
    // Verifier check `when-array-min-length-2` — runtime parity (empty case).
    throw new TypeError(
      `state(): submit exit '${name}' when[] is empty (declare at least two branches with the last unguarded)`,
    );
  }
  if (when.length === 1) {
    // Verifier check `when-array-min-length-2` — runtime parity (length-1 case).
    throw new TypeError(
      `state(): submit exit '${name}' when[] has length 1 (use sugar form for single branch)`,
    );
  }
  for (let i = 0; i < when.length; i++) {
    const branch: SubmitBranch | undefined = when[i];
    if (!branch || typeof branch.to !== 'string' || branch.to.length === 0) {
      throw new TypeError(
        `state(): submit exit '${name}' when[${i}] must declare 'to' as a non-empty string`,
      );
    }
    if (
      i === when.length - 1 &&
      branch.guard !== undefined &&
      (branch.__aharnessCanonical === undefined ||
        branch.__aharnessCanonical.predicate !== undefined)
    ) {
      // Verifier check `when-last-unguarded` — runtime parity.
      throw new TypeError(
        `state(): submit exit '${name}' when[] last entry must be unguarded (catch-all)`,
      );
    }
  }
}

export function exitCatalogFromMeta(meta: AharnessStateMeta): ExitCatalog {
  const out: ExitCatalogItem[] = [];
  for (const name of Object.keys(meta.exits)) {
    const exit = meta.exits[name];
    if (!exit) continue;
    const to =
      exit.kind === 'await' ? exit.to : 'when' in exit ? (exit.when[0]?.to ?? '') : exit.to;
    const item: ExitCatalogItem = {
      name,
      kind: exit.kind === 'await' ? 'await' : 'submit',
      to,
      ...(exit.description !== undefined ? { description: exit.description } : {}),
    };
    out.push(item);
  }
  return out;
}

const RESERVED_HOOK_KINDS = ['preCompact', 'postCompact', 'sessionStart'] as const;

function validateSkills(raw: unknown): void {
  if (!Array.isArray(raw)) {
    throw new TypeError('state(): skills must be an array');
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const ref: unknown = raw[i];
    if (!isSkillRef(ref)) {
      throw new TypeError(
        `state(): skills[${i}] must be a SkillRef returned by skill(...) (got ${typeof ref})`,
      );
    }
    // Duplicate name/path on the same state is an authoring error — the
    // dedupe is per-run, but declaring the same key twice on one state
    // is meaningless and almost always a copy-paste bug. Verifier check
    // `skill-no-duplicate-names-on-state` re-checks at static verify time.
    const key = ref.source === 'name' ? `name:${ref.name}` : `path:${ref.path}`;
    if (seen.has(key)) {
      throw new TypeError(`state(): skills[${i}] duplicate skill '${key}' on the same state`);
    }
    seen.add(key);
  }
}

function validateStateHooks(hooks: unknown): void {
  if (typeof hooks !== 'object' || hooks === null) {
    throw new TypeError('state(): hooks must be an object');
  }
  const h = hooks as Record<string, unknown>;
  for (const reserved of RESERVED_HOOK_KINDS) {
    if (h[reserved] !== undefined) {
      throw new TypeError(`state(): hooks.${reserved} is not yet supported`);
    }
  }
  validateMatchedHookArray(h['preToolUse'], 'preToolUse', /* requireMatcher */ true);
  validateMatchedHookArray(h['postToolUse'], 'postToolUse', /* requireMatcher */ true);
  validateMatchedHookArray(h['userPromptSubmit'], 'userPromptSubmit', /* requireMatcher */ false);
  validateMatchedHookArray(h['permissionRequest'], 'permissionRequest', /* requireMatcher */ true);
}

function validateMatchedHookArray(raw: unknown, kind: string, requireMatcher: boolean): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new TypeError(`state(): hooks.${kind} must be an array`);
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | undefined;
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      throw new TypeError(`state(): hooks.${kind}[${i}] must be an object`);
    }
    if (typeof entry['handler'] !== 'function') {
      throw new TypeError(`state(): hooks.${kind}[${i}] handler must be a function`);
    }
    if (requireMatcher) {
      if (typeof entry['matcher'] !== 'string' || entry['matcher'].length === 0) {
        throw new TypeError(`state(): hooks.${kind}[${i}] matcher must be a non-empty string`);
      }
      // Belt-and-suspenders: reject malformed regex at machine-load time
      // so unverified FSMs don't blow up downstream in Phase B's wrapper-
      // script generation. Mirrors the verifier's pre-flight regex compile.
      try {
        new RegExp(entry['matcher']);
      } catch (e) {
        throw new TypeError(
          `state(): hooks.${kind}[${i}] matcher '${entry['matcher']}' is not a valid regex: ${(e as Error).message}`,
          { cause: e },
        );
      }
    } else {
      if (entry['matcher'] !== undefined) {
        throw new TypeError(
          `state(): ${kind} entries must not declare a matcher (codex ignores it for this kind)`,
        );
      }
    }
  }
}

/**
 * Passive (always/entry-driven) state. No exits, no submits — the state
 * advances via XState `always` or `entry` transitions written by the
 * author. Returns a spreadable state config: authors write
 * `presentDraft: { ...passive(), entry: renderArtifacts, always: { target: 'next' } }`.
 *
 * Spread idiom warning: a non-aharness `meta:` literal AFTER the spread
 * silently overwrites `meta.aharness`. The verifier check
 * `state-config-missing-aharness-meta` (verify.ts) catches this case
 * by detecting the resulting symptom — a state with XState behavior
 * but no `meta.aharness`.
 */
export interface PassiveOptions {
  readonly main?: boolean;
}

export function passive(opts: PassiveOptions = {}): {
  meta: { aharness: { kind: 'passive'; main?: true } };
} {
  if (opts.main !== undefined && typeof opts.main !== 'boolean') {
    throw new TypeError('passive(): main must be a boolean when provided');
  }
  return { meta: { aharness: { kind: 'passive', ...(opts.main === true ? { main: true } : {}) } } };
}

/**
 * Terminal (final) state. `outcome` is a strict union — closed set so
 * downstream run-log consumers stay statically exhaustive.
 * Authors needing more nuance encode it in the leading-up state's exit
 * data, not the terminal kind.
 *
 * Returns a spreadable state config with `type: 'final'` already set.
 * Authors write `finalize: { ...terminal('success'), entry: renderArtifacts }`.
 */
export interface TerminalOptions {
  readonly main?: boolean;
}

export function terminal(
  outcome: 'success' | 'failure',
  opts: TerminalOptions = {},
): {
  readonly type: 'final';
  readonly meta: {
    readonly aharness: {
      readonly kind: 'terminal';
      readonly outcome: 'success' | 'failure';
      readonly main?: true;
    };
  };
} {
  if (opts.main !== undefined && typeof opts.main !== 'boolean') {
    throw new TypeError('terminal(): main must be a boolean when provided');
  }
  return {
    type: 'final',
    meta: {
      aharness: { kind: 'terminal', outcome, ...(opts.main === true ? { main: true } : {}) },
    },
  };
}

/**
 * `final({outcome, output?})` — canonical embed-friendly terminal state.
 *
 * Identical XState shape to `terminal()` (`{type: 'final', meta: {aharness: ...}}`)
 * with two additions:
 *   - `outcome` is taken as a named field (not a positional arg) for parity with
 *     `state()`'s options-object style and to make room for `output`.
 *   - `output: ({context, event}) => unknown` is an optional callback evaluated
 *     when this state is entered. When the FSM is embedded under another via
 *     `embed()`, the synthesizer (machine.ts) injects an `entry` action that
 *     `raise`s a bare `<finalId>` event carrying `{output: <evaluated>}` so
 *     the parent compound state's `on` map can route on it.
 *
 *   When the FSM is run standalone, `output` is unused — the daemon's terminal
 *   handler already short-circuits on `kind === 'terminal'`.
 *
 * `terminal('success'|'failure')` continues to work; new code prefers `final()`.
 */
export type FinalOutputFn<TContext = unknown, TEvent = unknown> = (args: {
  readonly context: Readonly<TContext>;
  readonly event: Readonly<TEvent>;
}) => unknown;

/**
 * `FinalOptions<TOutput>` — author surface for `final<TOutput>()`.
 *
 * The `output` callback's `args` parameter is typed loosely (`{context: any;
 * event: any}`) so authors can narrow the parameter inline:
 *
 *     final({
 *       outcome: 'success',
 *       output: ({context}: {context: ChildCtx}) => ({topic: context.topic}),
 *     })
 *
 * `TOutput` is inferred from the callback's return type, populating the
 * phantom `__outputType` slot on `FinalConfig<TOutput>` that `ExtractFinals<>`
 * walks at the embed-host level. When `output` is omitted, `TOutput` defaults
 * to `undefined`.
 */
export interface FinalOptions<TOutput = undefined> {
  readonly outcome: 'success' | 'failure';
  readonly main?: boolean;
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly output?: (args: { readonly context: any; readonly event: any }) => TOutput;
}

/**
 * Typed return shape of `final<TOutput>()`. Carries the resolved output
 * type as a phantom `__outputType` slot so the parent compound state's
 * synthesized `on['<finalId>']` action / guard can be statically typed
 * against the child final's `output()` return shape (Pain 5).
 *
 * `__outputType` is **never set at runtime** — it exists only as a TS-level
 * carrier consumed by `ExtractFinals<TStates>` in `state/machine.ts`. The
 * runtime value of every `final()` return is `{type: 'final', meta: {...}}`.
 */
export interface FinalConfig<TOutput = undefined> {
  readonly type: 'final';
  /** Phantom only — never set at runtime. */
  readonly __outputType?: TOutput;
  readonly meta: {
    readonly aharness: {
      readonly kind: 'terminal';
      readonly outcome: 'success' | 'failure';
      readonly main?: true;
      readonly output?: FinalOutputFn;
      readonly artifacts?: Readonly<
        Record<string, (data: Readonly<unknown>) => string | Uint8Array>
      >;
    };
  };
}

export function final<TOutput = undefined>(opts: FinalOptions<TOutput>): FinalConfig<TOutput> {
  if (!opts || (opts.outcome !== 'success' && opts.outcome !== 'failure')) {
    throw new TypeError("final(): outcome must be 'success' or 'failure'");
  }
  if (opts.output !== undefined && typeof opts.output !== 'function') {
    throw new TypeError('final(): output must be a function');
  }
  if (opts.main !== undefined && typeof opts.main !== 'boolean') {
    throw new TypeError('final(): main must be a boolean when provided');
  }
  return {
    type: 'final',
    meta: {
      aharness: {
        kind: 'terminal',
        outcome: opts.outcome,
        ...(opts.main === true ? { main: true } : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
      },
    },
  };
}
