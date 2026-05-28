/**
 * Core types — `@aharness/core` §3 (post-state-posture-and-exits spec).
 */
import type { JSONSchema7 } from 'json-schema';
import type { HarnessStateMeta } from './state/exits.js';
export type { HarnessStateMeta } from './state/exits.js';

/**
 * Marker the user FSM attaches to each state via `meta.harness`.
 * Constructed via `state()`, `terminal()`, or `passive()`.
 */
export type HarnessMeta = HarnessStateMeta | TerminalMeta | PassiveMeta;

export interface TerminalMeta {
  readonly kind: 'terminal';
  readonly outcome: 'success' | 'failure';
  /** Visualization-only hint: include this state in the primary graph spine. */
  readonly main?: true;
  readonly artifacts?: Readonly<Record<string, (data: Readonly<unknown>) => string | Uint8Array>>;
}

export interface PassiveMeta {
  readonly kind: 'passive';
  /** Visualization-only hint: include this state in the primary graph spine. */
  readonly main?: true;
}

/**
 * Run-state context view passed to `entryPrompt` (function form),
 * `stopGuidance`, and any author code that reads run state.
 *
 * Alias for the XState actor's `context`. Two framework-managed fields
 * the SDK adds at machine load — see spec §7. Other fields are author-defined.
 */
/**
 * Read-only view of the actor's context that authors receive in
 * `entryPrompt`/`stopGuidance`. Author-defined fields remain
 * accessible via the index signature; the framework-managed fields are
 * readonly so a `entryPrompt(ctx)` that accidentally writes them
 * fails to compile rather than corrupting visit counts mid-run.
 */
export interface RunCtx {
  readonly __harness_lastOwnerReply: string | undefined;
  readonly __harness_visitCount: Readonly<Record<string, number>>;
  readonly [k: string]: unknown;
}

export interface RunDir {
  readonly runId: string;
  readonly root: string;
  readonly snapshotPath: string;
  readonly eventsPath: string;
  readonly artifactsDir: string;
}

export interface HarnessInput {
  readonly runDir: RunDir;
  readonly runId: string;
}

/** Loader output: per-(stateId, exitName) JSON Schema + ajv validator. */
export interface SchemaSidecar {
  readonly [stateId: string]:
    | {
        readonly [exitName: string]:
          | {
              readonly jsonSchema: JSONSchema7;
              readonly validate: (input: unknown) => SidecarValidateResult;
            }
          | undefined;
      }
    | undefined;
}

export type SidecarValidateResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly errors: ReadonlyArray<ValidationError> };

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface SubmitToolDef {
  /** `submit_<stateId>__<exitName>` (no run-id suffix; one run per gateway). */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
  readonly stateId: string;
  readonly exitName: string;
}

export interface AwaitToolDef {
  /** `await_user_message` (single tool per run; surfaces only when the active state has an await exit). */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
}
