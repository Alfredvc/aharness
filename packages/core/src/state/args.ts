/**
 * `arg<T>(meta?)` — phantom sentinel for typed FSM input fields.
 *
 * The TypeScript type parameter `T` is read by the loader's TS-compiler-API
 * pass (`loader/sidecar.ts`) to emit a JSON Schema 7 fragment per field.
 * The runtime value is opaque: a sentinel object carrying the optional CLI
 * meta (description, completion, default).
 *
 * Mirrors the phantom-type-argument pattern used by `exit<T>(...)` in
 * `state/exits.ts`. The `_phantom` field anchors `T` so TS does not erase
 * it before the AST walk.
 */

export type CompletionKind =
  | 'file'
  | 'directory'
  | { readonly values: ReadonlyArray<string> }
  | { readonly dynamic: DynamicCompletion };

export interface CompletionCtx {
  readonly fsmFile: string;
  readonly cwd: string;
}

export type DynamicCompletion = (partial: string, ctx: CompletionCtx) => ReadonlyArray<string>;

export interface ArgMeta<T = unknown> {
  readonly description?: string;
  readonly completion?: CompletionKind;
  readonly default?: T;
}

export interface ArgSentinel<T = unknown> {
  readonly __harnessArgMarker: true;
  readonly meta: ArgMeta<T>;
  readonly _phantom?: T;
}

export function arg<T>(meta?: ArgMeta<T>): ArgSentinel<T> {
  return { __harnessArgMarker: true, meta: meta ?? {} };
}

export function isArgSentinel(v: unknown): v is ArgSentinel {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __harnessArgMarker?: unknown }).__harnessArgMarker === true
  );
}

/**
 * Type-level resolution of an `input: { field: arg<T>(...) }` declaration into
 * the resolved object shape `{ field: T }`. Used by `harness.machine`'s public
 * signature (see `state/machine.ts`) to thread the resolved input shape into
 * the `context:` callback's `input` parameter so authors get a typed `input`
 * without manual annotations, and re-exposed as the third generic of
 * `HarnessMachine<…>` for `InputOf<>` consumers.
 *
 * The `-readonly` mapping strips the readonly modifier picked up from the
 * `const TInput` generic on `harness.machine` — `const` preserves the input
 * declaration's literal shape (so `arg<string>(...)` keeps its type
 * argument) but as a side effect marks every property `readonly`. Authors
 * compare the resolved input against plain (non-readonly) object types, so
 * we strip the modifier here.
 */
export type ResolveInput<TInput extends Record<string, ArgSentinel>> = {
  -readonly [K in keyof TInput]: TInput[K] extends ArgSentinel<infer V> ? V : never;
};

/**
 * Given a compiled harness machine OR its raw config, produce the typed
 * object shape an FSM expects as `input`. Reads two paths:
 *
 *   1. `TFsm['__inputType']` — the phantom slot on `HarnessMachine<…>`
 *      (Task 12a). Surfaces the resolved input shape when the consumer
 *      types `TFsm` as the typed return.
 *   2. `TFsm['config']['input']` — the runtime-preserved declaration on
 *      `machine.config` (Task 12 leaves it in place). Used when TS
 *      preserves the literal config type through `setup().createMachine()`
 *      and the phantom slot is missing.
 *
 * Path 1 covers cached / dynamically imported machines where the literal
 * is lost — authors annotate the import as `HarnessMachine<…, TInput>` to
 * surface the input shape. Path 2 works for direct `typeof harness.machine({...})`.
 *
 * Required vs optional in the static side: every declared field is treated
 * as required at the type level. The runtime CLI parser (Task 14) applies
 * `meta.default` for omitted optional fields; authors who need the looser
 * shape use `Partial<InputOf<typeof child>>`.
 */
export type InputOf<TFsm> = TFsm extends {
  __inputType?: infer TInput;
}
  ? TInput
  : TFsm extends { config: { input?: infer Decl } }
    ? Decl extends Record<string, ArgSentinel>
      ? ResolveInput<Decl>
      : never
    : never;
