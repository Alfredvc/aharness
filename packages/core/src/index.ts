/**
 * `@aharness/core` — Codex (codex-rs) substrate authoring surface.
 *
 * This barrel is **bundle-safe**: user `*.fsm.ts` source files import
 * from here, the FSM loader bundles them via esbuild, and nothing on
 * this surface drags in node runtime deps (`ws`, `child_process`,
 * `node:net`, `esbuild`).
 *
 * Substrate-runtime symbols (transports, JSON-RPC client, app-server
 * spawn helpers, ephemeral `CODEX_HOME` materializer, FSM loader,
 * protocol types) live in `@aharness/core/runtime` and MUST NOT
 * be imported from FSM source files. Daemon, CLI, and test code
 * import the runtime surface from `@aharness/core/runtime`.
 *
 * The author-surface symbol set is fixed by §R1 of the Codex migration
 * plan (`docs/plans/2026-05-02-codex-migration.md`); see also
 * `PREFLIGHT.md` §1.
 */

export const PACKAGE_NAME = '@aharness/core' as const;

// ---------------------------------------------------------------------------
// Re-exports from `@aharness/core` (§R1 author + helper surface).
// ---------------------------------------------------------------------------

// Author primitives.
export { aharness } from './state/machine.js';
export type { AharnessMachine } from './state/machine.js';
export { createFsm } from './state/createFsm.js';
export { state, exit, terminal, final, passive, exitCatalogFromMeta } from './state/exits.js';
export type {
  ExitOptions,
  ExitOptionsSugar,
  ExitOptionsMulti,
  FinalOptions,
  FinalOutputFn,
} from './state/exits.js';
export type { OnEntryFn } from './state/exits.js';
export { skill, isSkillRef, skillKey } from './state/skills.js';
export type {
  SkillRef,
  SkillRefName,
  SkillRefPath,
  SkillOptions,
  SkillByPath,
  SkillKey,
} from './state/skills.js';
export type {
  HookKind,
  StateHooks,
  ToolHookMatcher,
  UnmatchedHookHandler,
  PreToolUseEvent,
  PreToolUseDecision,
  PostToolUseEvent,
  PostToolUseDecision,
  UserPromptSubmitEvent,
  UserPromptSubmitDecision,
  PermissionRequestEvent,
  PermissionRequestDecision,
  PermissionRequestHook,
} from './state/hooks.js';
export { discoverDeclaredHookKinds } from './state/discoverHooks.js';
export type { AharnessOps } from './state/aharnessOps.js';
export { arg, isArgSentinel } from './state/args.js';
export type {
  ArgSentinel,
  ArgMeta,
  CompletionKind,
  CompletionCtx,
  DynamicCompletion,
  InputOf,
  ResolveInput,
} from './state/args.js';
export { embed, isEmbeddedNode } from './state/embed.js';
export type {
  EmbeddedMeta,
  EmbeddedCompoundConfig,
  EmbeddedInputProjection,
  EmbeddedTransitionConfig,
  EmbedOptions,
} from './state/embed.js';

// Artifact + event-log writers (callable from FSM render functions).
export { writeArtifact } from './artifact.js';
export { appendEventEntry } from './events.js';

// Run-identity + snapshot helpers.
export { deriveRunId, ensureRunDir, fsmHash6 } from './run.js';
export { loadSnapshot, type Snapshot } from './snapshot.js';

// State-introspection / schema-meta helpers.
export { iterStates, getAharnessMeta, stateKeyPath } from './state.js';

// Types.
export type {
  AharnessInput,
  AharnessMeta,
  AharnessStateMeta,
  RunCtx,
  RunDir,
  SchemaSidecar,
  SidecarValidateResult,
  ValidationError,
} from './types.js';
export type { SidecarIssue } from './loader/index.js';

// Owner-yield ServerRequest provider (Phase 2b). The interface is
// shared with `@aharness/test-support`'s `MockOwnerInputProvider`
// via this barrel; the stdin-backed factory and the in-tree mock-queue
// factory are the two implementations that ship in this package.
export {
  DECLINED_ANSWER_TEXT,
  createStdinOwnerInputProvider,
  createMockOwnerInputProviderQueue,
} from './cli/ownerInputProvider.js';
export type {
  OwnerInputProvider,
  CreateStdinOwnerInputProviderOpts,
  MockOwnerInputProviderQueue,
  MockOwnerInputQueueEntry,
} from './cli/ownerInputProvider.js';
