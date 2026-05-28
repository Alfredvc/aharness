/**
 * Author-facing types for codex per-state hooks.
 *
 * Closed-world surface — every shape mirrors codex's hook stdin/stdout JSON
 * verbatim, with PascalCase field names converted to camelCase per harness
 * convention. New shapes require an SDK release.
 *
 * Spec: docs/specs/2026-05-08-per-state-hooks-design.md §4.
 */

/**
 * v1 ships authors three hook kinds. Codex's exact PascalCase event names
 * (from `codex-rs/hooks/src/lib.rs::HOOK_EVENT_NAMES`) are honoured verbatim
 * so they can be used as `-c hooks.<Kind>=...` keys without translation.
 */
export type HookKind = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit';

// ─── PreToolUse ────────────────────────────────────────────────────────────

export interface PreToolUseEvent {
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string | null;
  readonly model: string;
  readonly permissionMode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
  readonly turnId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: unknown;
  readonly isSubThread: boolean;
  readonly subThreadId?: string;
  readonly triggeredAt: string;
}

export type PreToolUseDecision =
  | {
      readonly hookSpecificOutput: {
        readonly permissionDecision: 'allow' | 'deny' | 'ask';
        readonly permissionDecisionReason?: string;
      };
      readonly suppressOutput?: boolean;
      readonly systemMessage?: string;
    }
  | undefined;

// ─── PostToolUse ───────────────────────────────────────────────────────────

export interface PostToolUseEvent extends PreToolUseEvent {
  readonly toolResponse: unknown;
}

export type PostToolUseDecision =
  | {
      readonly decision: 'block';
      readonly reason: string;
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
      readonly suppressOutput?: boolean;
      readonly systemMessage?: string;
    }
  | {
      readonly decision?: never;
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
      readonly suppressOutput?: boolean;
      readonly systemMessage?: string;
    }
  | undefined;

// ─── UserPromptSubmit ──────────────────────────────────────────────────────

export interface UserPromptSubmitEvent {
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string | null;
  readonly model: string;
  readonly permissionMode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
  readonly turnId: string;
  readonly prompt: string;
  readonly isSubThread: boolean;
  readonly subThreadId?: string;
  readonly triggeredAt: string;
}

export type UserPromptSubmitDecision =
  | {
      readonly hookSpecificOutput?: {
        readonly additionalContext?: string;
      };
      readonly suppressOutput?: boolean;
      readonly systemMessage?: string;
    }
  | undefined;

// ─── PermissionRequest ────────────────────────────────────────────────────

export interface PermissionRequestEvent {
  readonly kind: 'command' | 'file';
  readonly toolName: string;
  readonly matcherAliases: ReadonlyArray<string>;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly requestId?: string;
  readonly approvalId?: string;
  readonly reason?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly commandActions?: ReadonlyArray<unknown>;
  readonly networkApprovalContext?: unknown;
  readonly grantRoot?: string;
}

export type PermissionRequestDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | 'delegate'
  | undefined;

// ─── Author entry shapes ───────────────────────────────────────────────────

/**
 * Hook entry for kinds that match on `tool_name` (PreToolUse / PostToolUse).
 *
 * `matcher` is a regex string (Rust `regex` syntax on the codex side; JS
 * `RegExp` is used for pre-flight validation, a strict superset for the
 * matcher constructs codex itself accepts). Required — authors who want
 * exact match write `'^Bash$'`. Codex does not deliver `dynamic_tools`
 * or selected built-in tool calls, including `harness_submit` and
 * `request_user_input`, to `PreToolUse` / `PostToolUse`; matchers that
 * target those names are inert rather than verifier errors.
 */
export interface ToolHookMatcher<TContext, TEvent, TDecision> {
  readonly matcher: string;
  readonly handler: (
    ctx: Readonly<TContext>,
    evt: Readonly<TEvent>,
  ) => TDecision | Promise<TDecision>;
}

/** Hook entry for kinds where codex ignores the matcher (UserPromptSubmit). */
export interface UnmatchedHookHandler<TContext, TEvent, TDecision> {
  readonly handler: (
    ctx: Readonly<TContext>,
    evt: Readonly<TEvent>,
  ) => TDecision | Promise<TDecision>;
}

export type PermissionRequestHook<TContext> = ToolHookMatcher<
  TContext,
  PermissionRequestEvent,
  PermissionRequestDecision
>;

/**
 * Author surface attached to `meta.harness.hooks` of a `state(...)` block.
 * Optional — states without `hooks` keep current behavior verbatim.
 *
 * The four `never`-typed fields reserve future hook kinds. They reject
 * literal assignment under strict TS; a runtime guard in `state(...)` rejects
 * non-undefined values supplied via programmatic construction; the verifier
 * check `hook-kind-not-yet-supported` rejects them with a clearer diagnostic
 * at FSM-load time. Three layers, one source of truth (the spec §4.5).
 */
export interface StateHooks<TContext> {
  readonly preToolUse?: ReadonlyArray<
    ToolHookMatcher<TContext, PreToolUseEvent, PreToolUseDecision>
  >;
  readonly postToolUse?: ReadonlyArray<
    ToolHookMatcher<TContext, PostToolUseEvent, PostToolUseDecision>
  >;
  readonly userPromptSubmit?: ReadonlyArray<
    UnmatchedHookHandler<TContext, UserPromptSubmitEvent, UserPromptSubmitDecision>
  >;
  readonly permissionRequest?: ReadonlyArray<PermissionRequestHook<TContext>>;

  /** TODO: not yet supported. */
  readonly preCompact?: never;
  /** TODO: not yet supported. */
  readonly postCompact?: never;
  /** TODO: not yet supported. */
  readonly sessionStart?: never;
}
