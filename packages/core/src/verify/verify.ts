/**
 * Static verifier — @aharness/core port of `@aharness/core`'s `verify.ts`.
 *
 * Closed-world checks; failure of any error-severity check blocks
 * `aharness <file.fsm.ts>` from starting. Warnings surface in
 * the `warnings` channel of `VerifyResult` and do not block (`ok` stays
 * true when there are only warnings).
 *
 * Differences from the CC verifier (per Codex migration plan §13 + R3/R4/R5):
 *   - REMOVED: `state-id-length` check. The Codex side does not synthesize
 *     per-state tool names; the sole dynamic tool is the frozen
 *     `aharness_submit` tool whose name length is fixed. The 41-char joint cap
 *     no longer applies.
 *   - RENAMED: `submit-schemas-resolved` → `per-state-data-schema-resolvable`
 *     (per R3; the existing CC literal is `submit-schemas-resolved`).
 *   - ADDED: `state-exit-tuple-unique` — guards against `(canonicalStateId,
 *     exitName)` collisions across distinct state-key paths. TS already
 *     prevents intra-state collisions; this catches author errors at
 *     compile-time-evaded boundaries (e.g. nested-state shadowing producing
 *     identical `stateKeyPath` results).
 *   - RETIRED: `mcp-submit-tool-name-collision`. The live submit surface is
 *     the single `aharness_submit` dynamic tool with `{state, exit, data}`;
 *     author identifiers live in JSON payload fields, never in MCP tool
 *     names. The old MCP-route collision check produced false positives on
 *     legitimate FSMs (the conventional exit name `submit` is intuitive
 *     and harmless) so it is removed entirely.
 *   - ADDED (scaffold): `request-user-input-name-collision`. Structurally
 *     present so the check id is reachable and tested empty-input today;
 *     functional walk activates when the FSM gains an
 *     future author tool-declaration surface.
 *   - ADDED: `no-submit-in-spawn-agent-reachable-states`. Conservative MVP: rejects an
 *     FSM declaring a submit exit alongside any author-fn referencing
 *     `spawn_agent` by name. Defence-in-depth alongside the runtime
 *     threadId guard.
 *
 * The check list (in aggregator order):
 *   1.  reachability                            — every state reachable from initial
 *   2.  terminal-reachability                   — every state can reach a final
 *   3.  no-black-hole-non-terminals             — every non-final state has an advance trigger
 *   4.  per-state-data-schema-resolvable        — every (stateId, exitName) submit exit has a sidecar entry
 *   5.  entryPrompt-paired                 — every stateful state has a non-empty entryPrompt
 *   6.  no-unresolved-references                — every guard/action/actor referenced is declared
 *   7.  final-classification                    — every final state declares terminal('...')
 *   8.  single-await-per-state                  — at most one await exit per stateful state
 *   9.  exit-kind-well-formedness               — submit exits have payload, await exits do not
 *   10. open-states-have-at-least-one-exit      — open: true requires ≥1 exit
 *   11. await-only-strict-state (warning)       — strict state with one await + no submit
 *   12. author-functions-sync                   — re-emit loader `author-fn-async` issues
 *   13. machine-uses-aharness-wrapper            — re-emit loader `direct-create-machine` issues
 *   14. state-exit-tuple-unique                 — distinct stateKeyPaths must not collide on (id, exitName)
 *   15. request-user-input-name-collision       — author-declared tool named "request_user_input" (scaffold)
 *   16. aharness-submit-name-collision           — state id equal to the reserved framework tool name
 *   17. no-submit-in-spawn-agent-reachable-states — submit exits + author-fn referencing `spawn_agent`
 *   18. no-handwritten-submit-await-handlers    — author-written SUBMIT__/AWAIT__ on: keys (reads side-channel)
 *   19. exit-target-in-state-set                — every exit `to:` names a valid sibling state
 *   20. when-last-unguarded                     — when[] last entry must be unguarded (catch-all)
 *   21. when-array-min-length-2                 — when[] requires length >= 2
 *   22. await-no-multi-branch                   — await exits cannot use when[]
 *   23. exit-shape-exclusive                    — exit cannot have both `to` and `when`
 *   24. state-config-missing-aharness-meta       — state with behavior+meta but no meta.aharness
 *   25. awaits-owner-text-no-await-exit         — awaitsOwnerText + await exit on same state
 *   26. state-onEntry-must-be-function          — meta.aharness.onEntry must be a function
 *   27. onEntry-only-on-stateful-states         — terminal/passive metas may not declare onEntry
 *   28. bare-branch-warning (warning)           — non-last bare when[] branch (no guard, no actions)
 *   29. embedded-state-exclusive                — embed-host states declare embed() and nothing else
 *   30. embedded-child-must-have-finals         — embed-host's child must declare >=1 final() node
 *   31. embedded-final-id-name-shape            — embedded child final ids must not begin with `xstate.` or contain `.`
 *   32. clearOnEntry-not-initial                — initially active states may not request fresh clear
 *
 * Verifier ordering invariant (load-bearing — see design doc §4.5):
 *
 *   Synthesis (in aharness.machine → injectFrameworkActions) writes the
 *   SUBMIT__*\/AWAIT__* on: keys. BEFORE overwriting them, the synthesizer
 *   snapshots any pre-existing SUBMIT__/AWAIT__ keys onto the side-channel
 *   field `meta.aharness.__aharness_authoredOnKeys` so the verifier check
 *   `no-handwritten-submit-await-handlers` can detect author-written keys
 *   on the resolved machine.
 *
 *   Therefore: ALL checks (including `no-handwritten-submit-await-handlers`)
 *   run against the post-`createMachine` resolved machine. The verifier
 *   never reads raw config; the side-channel snapshot is the single
 *   source of truth for "what authored SUBMIT__/AWAIT__ keys did this
 *   FSM declare".
 *
 *   Bypassing aharness.machine() in tests (calling raw `setup().createMachine()`
 *   directly) breaks this invariant — the side-channel snapshot won't be
 *   populated, the synthesized keys won't exist, and downstream checks
 *   will see incomplete `on:` maps. The test infrastructure must call
 *   aharness.machine() (or equivalent) before handing a machine to verify().
 */
import type { AnyStateMachine, StateNode } from 'xstate';

import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import type { AharnessStateMeta, SchemaSidecar } from '../types.js';
import type { SidecarIssue } from '../loader/index.js';
import { SUBMIT_TOOL_NAME } from '../protocol/submitTool.js';
import { isSkillRef } from '../state/skills.js';
import { resolveSkill, type SkillResolverEnv } from '../state/skillResolver.js';

import {
  asPlainObject,
  getMachineImplementations,
  getRootStateNode,
  getStateNodeTransitions,
} from './internal.js';

export type VerifyIssueCheck =
  | 'reachability'
  | 'clearOnEntry-not-initial'
  | 'terminal-reachability'
  | 'no-black-hole-non-terminals'
  | 'per-state-data-schema-resolvable'
  | 'entryPrompt-paired'
  | 'no-unresolved-references'
  | 'final-classification'
  | 'single-await-per-state'
  | 'exit-kind-well-formedness'
  | 'open-states-have-at-least-one-exit'
  | 'await-only-strict-state'
  | 'author-functions-sync'
  | 'machine-uses-aharness-wrapper'
  | 'state-exit-tuple-unique'
  | 'request-user-input-name-collision'
  | 'aharness-submit-name-collision'
  | 'no-submit-in-spawn-agent-reachable-states'
  | 'exit-target-in-state-set'
  | 'canonical-event-target-in-state-set'
  | 'canonical-event-well-formedness'
  | 'when-last-unguarded'
  | 'when-array-min-length-2'
  | 'exit-shape-exclusive'
  | 'await-no-multi-branch'
  | 'no-handwritten-submit-await-handlers'
  | 'state-config-missing-aharness-meta'
  | 'awaits-owner-text-no-await-exit'
  | 'state-onEntry-must-be-function'
  | 'onEntry-only-on-stateful-states'
  | 'bare-branch-warning'
  | 'embedded-final-must-be-wired'
  | 'embedding-acyclic'
  | 'embedded-input-must-be-satisfied'
  | 'embedded-child-must-have-finals'
  | 'embedded-final-id-name-shape'
  | 'final-output-must-be-function'
  | 'embedded-state-exclusive'
  | 'state-hooks-must-be-functions'
  | 'hook-kind-not-yet-supported'
  | 'hook-matcher-not-supported-on-kind'
  | 'hook-matcher-invalid-regex'
  | 'hooks-only-on-stateful-states'
  | 'skill-must-resolve'
  | 'skill-name-shape'
  | 'skills-only-on-stateful-states'
  | 'skill-no-duplicate-names-on-state';

export type VerifyIssueSeverity = 'error' | 'warning';

export interface VerifyIssue {
  /** Stable id of the failing check. */
  readonly check: VerifyIssueCheck;
  /** State the issue is about, if applicable. Empty string for global issues. */
  readonly stateId: string;
  /** Human-readable explanation. */
  readonly message: string;
  /**
   * `'error'` blocks `/aharness` from starting; `'warning'` surfaces but does
   * not block. Defaults to `'error'` everywhere except `await-only-strict-state`.
   */
  readonly severity: VerifyIssueSeverity;
}

export interface VerifyResult {
  /** True iff every issue's severity is 'warning' (i.e. zero errors). */
  readonly ok: boolean;
  readonly errors: ReadonlyArray<VerifyIssue>;
  readonly warnings: ReadonlyArray<VerifyIssue>;
  /** Backwards-compat: union of errors + warnings. */
  readonly issues: ReadonlyArray<VerifyIssue>;
}

/**
 * Run all checks and aggregate issues.
 *
 * `sidecarIssues` are the loader's per-state and global issues
 * (`exit-payload-any`, `await-with-payload`, `author-fn-async`,
 * `direct-create-machine`, …). The verifier re-emits them under the
 * appropriate check name rather than re-deriving the same signal from
 * the JSON Schema or compiled machine — the loader has the freshest TS
 * type info and is authoritative.
 */
export interface VerifyOpts {
  /**
   * Resolution env for static skill checks. When omitted, skill ref
   * resolution is not performed — the structural checks
   * (`skill-name-shape`, `skills-only-on-stateful-states`,
   * `skill-no-duplicate-names-on-state`) still run, but
   * `skill-must-resolve` is skipped because there is no filesystem
   * context to check against. Production callers (`runVerifyCli`,
   * the run-time pre-flight inside `runCli`) supply this; tests that
   * do not exercise skills omit it.
   */
  readonly skillEnv?: SkillResolverEnv;
}

export function verify(
  machine: AnyStateMachine,
  sidecar: SchemaSidecar,
  sidecarIssues: ReadonlyArray<SidecarIssue> = [],
  opts?: VerifyOpts,
): VerifyResult {
  const issues: VerifyIssue[] = [];
  issues.push(...checkReachability(machine));
  issues.push(...checkClearOnEntryNotInitial(machine));
  issues.push(...checkTerminalReachability(machine));
  issues.push(...checkNoBlackHoleNonTerminals(machine));
  issues.push(...checkPerStateDataSchemaResolvable(machine, sidecar, sidecarIssues));
  issues.push(...checkEntryPromptPaired(machine));
  issues.push(...checkNoUnresolvedReferences(machine));
  issues.push(...checkFinalClassification(machine));
  issues.push(...checkSingleAwaitPerState(machine));
  issues.push(...checkExitKindWellFormed(machine));
  issues.push(...checkOpenStatesHaveExits(machine));
  issues.push(...checkAwaitOnlyStrictState(machine));
  issues.push(...checkAuthorFunctionsSync(sidecarIssues));
  issues.push(...checkMachineUsesAharnessWrapper(sidecarIssues));
  issues.push(...checkStateExitTupleUnique(machine));
  issues.push(...checkRequestUserInputNameCollision());
  issues.push(...checkAharnessSubmitNameCollision(machine));
  issues.push(...checkNoSubmitInSpawnAgentReachableStates(machine));
  issues.push(...checkNoHandwrittenSubmitAwaitHandlers(machine));
  issues.push(...checkExitTargetInStateSet(machine));
  issues.push(...checkCanonicalEventTargetInStateSet(machine));
  issues.push(...checkCanonicalEventWellFormed(machine));
  issues.push(...checkWhenLastUnguarded(machine));
  issues.push(...checkWhenArrayMinLength2(machine));
  issues.push(...checkAwaitNoMultiBranch(machine));
  issues.push(...checkExitShapeExclusive(machine));
  issues.push(...checkStateConfigMissingAharnessMeta(machine));
  issues.push(...checkAwaitsOwnerTextNoAwaitExit(machine));
  issues.push(...checkStateOnEntryMustBeFunction(machine));
  issues.push(...checkOnEntryOnlyOnStatefulStates(machine));
  issues.push(...checkBareBranchWarning(machine));
  issues.push(...checkEmbeddedFinalMustBeWired(machine));
  issues.push(...checkEmbeddingAcyclic(machine));
  issues.push(...checkEmbeddedInputMustBeSatisfied(machine));
  issues.push(...checkFinalOutputMustBeFunction(machine));
  issues.push(...checkEmbeddedStateExclusive(machine));
  issues.push(...checkEmbeddedChildMustHaveFinals(machine));
  issues.push(...checkEmbeddedFinalIdNameShape(machine));
  issues.push(...checkStateHooksMustBeFunctions(machine));
  issues.push(...checkHookKindNotYetSupported(machine));
  issues.push(...checkHookMatcherNotSupportedOnKind(machine));
  issues.push(...checkHookMatcherInvalidRegex(machine));
  issues.push(...checkHooksOnlyOnStatefulStates(machine));
  issues.push(...checkSkillsOnlyOnStatefulStates(machine));
  issues.push(...checkSkillNameShapeAndDuplicates(machine));
  if (opts?.skillEnv !== undefined) {
    issues.push(...checkSkillsResolve(machine, opts.skillEnv));
  }
  // Split into errors and warnings; compute ok from errors only.
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const ok = errors.length === 0;
  return { ok, errors, warnings, issues };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build an error-severity issue. */
function err(check: VerifyIssueCheck, stateId: string, message: string): VerifyIssue {
  return { check, stateId, message, severity: 'error' };
}

/** Build a warning-severity issue. */
function warn(check: VerifyIssueCheck, stateId: string, message: string): VerifyIssue {
  return { check, stateId, message, severity: 'warning' };
}

/** Narrow a `AharnessMeta` to its stateful variant; returns `undefined` otherwise. */
function asStatefulMeta(node: StateNode): AharnessStateMeta | undefined {
  const meta = getAharnessMeta(node);
  if (!meta || meta.kind !== 'stateful') return undefined;
  return meta;
}

/**
 * Walk transitions out of a state and return the set of target state ids.
 *
 * XState v5 splits the resolved transitions across two fields:
 *   - `node.transitions` — `Map<eventType, TransitionDef[]>` containing
 *     entries for `on` keys, the synthesized `xstate.after.<delay>.<id>`
 *     events for `after`, the `xstate.done.state.<id>` events from
 *     compound `onDone` / parallel `onDone`, and `xstate.done.actor.<src>`
 *     for `invoke.onDone`.
 *   - `node.always` — array of `TransitionDef` for eventless
 *     transitions. NOT included in the `transitions` Map.
 *
 * Each `TransitionDef.target` is a resolved `StateNode[]` (or undefined
 * for self-targeting/no-target transitions).
 */
function outgoingTargets(node: StateNode): Set<string> {
  const out = new Set<string>();
  for (const t of getStateNodeTransitions(node)) {
    const targets = t.target;
    if (targets) {
      for (const tgt of targets) out.add(tgt.id);
    }
  }
  return out;
}

/** True if the state has at least one advancing trigger (`on`, `always`, `after`, `invoke.onDone`). */
function hasAdvanceTrigger(node: StateNode): boolean {
  const cfg = node.config;
  if (cfg.on && Object.keys(cfg.on).length > 0) return true;
  if (cfg.always !== undefined) return true;
  if (cfg.after !== undefined) return true;
  if (cfg.invoke !== undefined) {
    const invokes = Array.isArray(cfg.invoke) ? cfg.invoke : [cfg.invoke];
    for (const raw of invokes) {
      const inv = asPlainObject(raw);
      if (inv === null) continue; // silent skip — malformed config caught by another check
      if (inv['onDone'] !== undefined) return true;
    }
  }
  return false;
}

// ─── Check: reachability ───────────────────────────────────────────────────

function checkReachability(machine: AnyStateMachine): VerifyIssue[] {
  const all: StateNode[] = [];
  const byId = new Map<string, StateNode>();
  for (const node of iterStates(machine)) {
    all.push(node);
    byId.set(node.id, node);
  }

  const reached = new Set<string>([machine.root.id]);
  // BFS along transitions plus parent->initialChild edges. A child is
  // implicitly entered when its parent is entered, so reachability of
  // a parent implies reachability of its `initial` chain.
  const queue: StateNode[] = [getRootStateNode(machine)];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    // Enter the initial chain.
    let cursor: StateNode | undefined = node.initial?.target?.[0];
    while (cursor) {
      if (!reached.has(cursor.id)) {
        reached.add(cursor.id);
        queue.push(cursor);
      }
      cursor = cursor.initial?.target?.[0];
    }
    // Enter every child of a parallel state.
    if (node.type === 'parallel') {
      for (const childKey of Object.keys(node.states)) {
        const child = node.states[childKey];
        if (child && !reached.has(child.id)) {
          reached.add(child.id);
          queue.push(child);
        }
      }
    }
    // Walk transitions.
    for (const targetId of outgoingTargets(node)) {
      if (!reached.has(targetId)) {
        const candidate = byId.get(targetId);
        if (candidate) {
          reached.add(targetId);
          queue.push(candidate);
        }
      }
    }
  }

  const issues: VerifyIssue[] = [];
  for (const node of all) {
    if (node === machine.root) continue;
    if (!reached.has(node.id)) {
      const sid = stateKeyPath(node);
      issues.push(err('reachability', sid, `state '${sid}' is unreachable from the initial state`));
    }
  }
  return issues;
}

// ─── Check: clearOnEntry-not-initial ───────────────────────────────────────

function checkClearOnEntryNotInitial(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const visited = new Set<string>();
  const byId = new Map<string, StateNode>();
  for (const node of iterStates(machine)) byId.set(node.id, node);

  function visit(node: StateNode): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    if (node !== machine.root && asStatefulMeta(node)?.clearOnEntry === true) {
      const sid = stateKeyPath(node);
      issues.push(
        err(
          'clearOnEntry-not-initial',
          sid,
          `state '${sid}' declares clearOnEntry but is active during initial startup`,
        ),
      );
    }

    if (node.type === 'parallel') {
      for (const key of Object.keys(node.states)) {
        const child = node.states[key];
        if (child) visit(child);
      }
      return;
    }

    const initial = node.initial?.target?.[0];
    if (initial) visit(initial);

    for (const targetId of eventlessTargets(node)) {
      const target = byId.get(targetId);
      if (target) visit(target);
    }
  }

  visit(getRootStateNode(machine));
  return issues;
}

function eventlessTargets(node: StateNode): Set<string> {
  const out = new Set<string>();
  const always: unknown = node.always;
  if (!Array.isArray(always)) return out;
  for (const transition of always) {
    if (!isRecord(transition)) continue;
    const targets = transition['target'];
    if (Array.isArray(targets)) {
      for (const target of targets) {
        if (isStateNodeRef(target)) out.add(target.id);
      }
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStateNodeRef(value: unknown): value is StateNode {
  return isRecord(value) && typeof value['id'] === 'string';
}

// ─── Check: terminal-reachability ──────────────────────────────────────────

function checkTerminalReachability(machine: AnyStateMachine): VerifyIssue[] {
  const all: StateNode[] = [];
  const finals = new Set<string>();
  for (const node of iterStates(machine)) {
    all.push(node);
    if (node.type === 'final') finals.add(node.id);
  }
  if (finals.size === 0) {
    return [
      err(
        'terminal-reachability',
        '',
        'machine declares no final state; no path to termination exists',
      ),
    ];
  }

  // A state X can reach a final when:
  //   (a) X is itself a final, or
  //   (b) X has an outgoing transition (incl. via `on`/`always`/`after`/
  //       `invoke.onDone`) whose target can reach a final, or
  //   (c) X is compound and at least one of its substates can reach a
  //       final (the substate's `done` bubbles up as `xstate.done.state.<X>`
  //       which fires its parent's `onDone`/exits the parent), or
  //   (d) X is parallel and *every* region (direct child) can reach a
  //       final — XState parallel states emit `done` only when every
  //       region is in a final substate. The "every region" rule is the
  //       conservative correct interpretation.
  //
  // History-states are treated as transparent passthroughs (see SPEC §5
  // gap note in the walker below).
  const canReachFinal = new Set<string>(finals);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of all) {
      if (canReachFinal.has(node.id)) continue;

      // SPEC gap: SPEC_SDK.md §5 does not yet specify history-state
      // semantics. Treat history nodes as transparent passthroughs
      // for reachability — a history state resolves to the parent's
      // last active configuration, so its "reachability of a final"
      // is governed by the parent's substates.
      if (node.type === 'history') {
        canReachFinal.add(node.id);
        changed = true;
        continue;
      }

      // (b) outgoing transitions to a state that can reach a final.
      let advances = false;
      for (const targetId of outgoingTargets(node)) {
        if (canReachFinal.has(targetId)) {
          advances = true;
          break;
        }
      }
      if (advances) {
        canReachFinal.add(node.id);
        changed = true;
        continue;
      }

      // (c)/(d) compound + parallel: walk children up.
      if (node.type === 'compound') {
        // some substate suffices.
        for (const key of Object.keys(node.states)) {
          const child = node.states[key];
          if (child && canReachFinal.has(child.id)) {
            canReachFinal.add(node.id);
            changed = true;
            break;
          }
        }
        continue;
      }
      if (node.type === 'parallel') {
        const childKeys = Object.keys(node.states);
        if (childKeys.length === 0) continue;
        let everyRegion = true;
        for (const key of childKeys) {
          const child = node.states[key];
          if (!child || !canReachFinal.has(child.id)) {
            everyRegion = false;
            break;
          }
        }
        if (everyRegion) {
          canReachFinal.add(node.id);
          changed = true;
        }
        continue;
      }
    }
  }

  const issues: VerifyIssue[] = [];
  for (const node of all) {
    if (node === machine.root) continue;
    if (node.type === 'final') continue;
    if (!canReachFinal.has(node.id)) {
      const sid = stateKeyPath(node);
      issues.push(
        err('terminal-reachability', sid, `state '${sid}' has no path to any final state`),
      );
    }
  }
  return issues;
}

// ─── Check: no-black-hole-non-terminals ────────────────────────────────────

function checkNoBlackHoleNonTerminals(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    if (node === machine.root) continue;
    if (node.type === 'final') continue;
    // Compound and parallel states are not black holes by themselves —
    // they advance via their children's transitions or their own `on`.
    // We still require *some* advancing trigger on every non-final node,
    // matching SPEC §5.
    if (node.type === 'compound' || node.type === 'parallel') {
      // A compound/parallel node is fine if it has any advance trigger
      // OR at least one child (so the actor can transition by entering
      // a child's transitions).
      if (hasAdvanceTrigger(node)) continue;
      const childKeys = Object.keys(node.states);
      if (childKeys.length > 0) continue;
    }
    const meta = asStatefulMeta(node);
    const hasCanonicalEvents =
      meta !== undefined && Object.keys(meta.canonicalEvents ?? {}).length > 0;
    if (!hasAdvanceTrigger(node) && !hasCanonicalEvents) {
      const sid = stateKeyPath(node);
      issues.push(
        err(
          'no-black-hole-non-terminals',
          sid,
          `non-final state '${sid}' has no 'on', 'always', 'after', or 'invoke.onDone' — actor would be stuck on entry`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: per-state-data-schema-resolvable ───────────────────────────────

/**
 * Every submit exit `(stateId, exitName)` must have a sidecar entry with
 * a callable `validate`. Loader issues (`exit-payload-any`,
 * `exit-payload-missing`, `await-with-payload`, `schema-emit-failed`,
 * `validator-compile-failed`, `state-call-misplaced`) are re-emitted under
 * this check; the loader has the freshest TS type info and is authoritative.
 *
 * Loader issues unrelated to schemas (`author-fn-async`,
 * `direct-create-machine`) are routed to their own checks; this function
 * skips them so they don't double-report.
 *
 * The check id was renamed from CC's `submit-schemas-resolved` to
 * `per-state-data-schema-resolvable` per migration plan R3 — the codex side
 * exposes a single dynamic `submit` tool, so the per-state object is a data
 * schema rather than a per-tool schema.
 */
function checkPerStateDataSchemaResolvable(
  machine: AnyStateMachine,
  sidecar: SchemaSidecar,
  sidecarIssues: ReadonlyArray<SidecarIssue>,
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  // Track "(stateId, exitName)" pairs already covered by a loader issue so we
  // don't re-emit duplicate "no entry" findings on the same exit.
  const loaderFlaggedPairs = new Set<string>();
  for (const si of sidecarIssues) {
    if (si.code === 'author-fn-async' || si.code === 'direct-create-machine') continue;
    issues.push(err('per-state-data-schema-resolvable', si.stateId ?? '', si.message));
    if (si.stateId !== null && si.exitName !== null) {
      loaderFlaggedPairs.add(`${si.stateId}::${si.exitName}`);
    }
  }
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const exitName of Object.keys(meta.exits)) {
      const exit = meta.exits[exitName];
      if (!exit) continue;
      if (exit.kind === 'await') continue; // No schema for await.
      const pairKey = `${sid}::${exitName}`;
      if (loaderFlaggedPairs.has(pairKey)) continue;
      const entry = sidecar[sid]?.[exitName];
      if (!entry) {
        issues.push(
          err(
            'per-state-data-schema-resolvable',
            sid,
            `submit exit '${sid}::${exitName}' has no schema sidecar entry — loader could not resolve the type`,
          ),
        );
        continue;
      }
      if (typeof entry.validate !== 'function') {
        issues.push(
          err(
            'per-state-data-schema-resolvable',
            sid,
            `submit exit '${sid}::${exitName}' has no compiled validator`,
          ),
        );
      }
    }
  }
  return issues;
}

// ─── Check: entryPrompt-paired ────────────────────────────────────────

function checkEntryPromptPaired(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const prompt = meta.entryPrompt;
    const isValid =
      typeof prompt === 'function' || (typeof prompt === 'string' && prompt.length > 0);
    if (!isValid) {
      const sid = stateKeyPath(node);
      issues.push(
        err(
          'entryPrompt-paired',
          sid,
          `stateful state '${sid}' has no entryPrompt; on-entry orientation has no copy`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: no-unresolved-references ───────────────────────────────────────

function checkNoUnresolvedReferences(machine: AnyStateMachine): VerifyIssue[] {
  // XState 5's `setup({...})` declares guards/actions/actors as a closed
  // map; references to a name not in that map are caught by `tsc --strict`
  // for top-level cases. The verifier still walks the implementations map
  // exposed on `machine.implementations` and complains if any `on` /
  // `entry` / `exit` action object refers to a name that isn't there.
  const impls = getMachineImplementations(machine);
  const guards = new Set(Object.keys(impls.guards));
  const actions = new Set(Object.keys(impls.actions));
  const actors = new Set(Object.keys(impls.actors));

  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const cfg = node.config;
    const sid = stateKeyPath(node);
    // entry / exit
    issues.push(...checkActionRefs(sid, cfg.entry, actions, 'entry'));
    issues.push(...checkActionRefs(sid, cfg.exit, actions, 'exit'));
    // on / always / after — check guard + actions on each transition descriptor
    const on = asPlainObject(cfg.on);
    if (on !== null) {
      for (const evt of Object.keys(on)) {
        const handlers = on[evt];
        issues.push(...checkTransitionRefs(sid, handlers, guards, actions, `on['${evt}']`));
      }
    }
    if (cfg.always !== undefined) {
      issues.push(...checkTransitionRefs(sid, cfg.always, guards, actions, 'always'));
    }
    if (cfg.after !== undefined) {
      // `after` is a map keyed by delay; values are transitions.
      const after = asPlainObject(cfg.after);
      if (after !== null) {
        for (const delay of Object.keys(after)) {
          issues.push(
            ...checkTransitionRefs(sid, after[delay], guards, actions, `after['${delay}']`),
          );
        }
      }
    }
    // invoke.src — must reference a declared actor when given as a string.
    if (cfg.invoke !== undefined) {
      const invokes = Array.isArray(cfg.invoke) ? cfg.invoke : [cfg.invoke];
      for (const raw of invokes) {
        const inv = asPlainObject(raw);
        if (inv === null) continue; // silent skip — malformed config caught by another check
        const src = inv['src'];
        if (typeof src === 'string' && !actors.has(src)) {
          issues.push(
            err(
              'no-unresolved-references',
              sid,
              `invoke.src '${src}' is not declared in setup.actors`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function checkActionRefs(
  stateId: string,
  spec: unknown,
  actions: Set<string>,
  where: string,
): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  const list = Array.isArray(spec) ? spec : spec === undefined ? [] : [spec];
  for (const a of list) {
    if (typeof a === 'string' && !actions.has(a)) {
      out.push(
        err('no-unresolved-references', stateId, `${where} references undeclared action '${a}'`),
      );
    } else {
      const obj = asPlainObject(a);
      if (obj !== null && 'type' in obj) {
        const t = obj['type'];
        if (typeof t === 'string' && !actions.has(t)) {
          out.push(
            err(
              'no-unresolved-references',
              stateId,
              `${where} references undeclared action '${t}'`,
            ),
          );
        }
      }
    }
    // Inline functions are fine — `setup()` accepts them as values, not
    // as named references; nothing to resolve.
  }
  return out;
}

function checkTransitionRefs(
  stateId: string,
  spec: unknown,
  guards: Set<string>,
  actions: Set<string>,
  where: string,
): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  const list = Array.isArray(spec) ? spec : spec === undefined ? [] : [spec];
  for (const t of list) {
    const obj = asPlainObject(t);
    if (obj === null) continue;
    if (typeof obj['guard'] === 'string' && !guards.has(obj['guard'])) {
      out.push(
        err(
          'no-unresolved-references',
          stateId,
          `${where} references undeclared guard '${obj['guard']}'`,
        ),
      );
    } else {
      const guardObj = asPlainObject(obj['guard']);
      if (guardObj !== null && 'type' in guardObj) {
        const gt = guardObj['type'];
        if (typeof gt === 'string' && !guards.has(gt)) {
          out.push(
            err(
              'no-unresolved-references',
              stateId,
              `${where} references undeclared guard '${gt}'`,
            ),
          );
        }
      }
    }
    out.push(...checkActionRefs(stateId, obj['actions'], actions, `${where}.actions`));
  }
  return out;
}

// ─── Check: final-classification ───────────────────────────────────────────

function checkFinalClassification(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    if (node.type !== 'final') continue;
    const sid = stateKeyPath(node);
    const meta = getAharnessMeta(node);
    if (!meta || meta.kind !== 'terminal') {
      issues.push(
        err(
          'final-classification',
          sid,
          `final state '${sid}' must declare meta.aharness = terminal('...')`,
        ),
      );
      continue;
    }
    if (meta.outcome !== 'success' && meta.outcome !== 'failure') {
      issues.push(
        err(
          'final-classification',
          sid,
          `final state '${sid}' terminal outcome must be 'success' or 'failure'`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: single-await-per-state ─────────────────────────────────────────

/** A stateful state may declare at most one await exit. Per spec §4.2. */
function checkSingleAwaitPerState(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    let awaitCount = 0;
    for (const exitName of Object.keys(meta.exits)) {
      if (meta.exits[exitName]?.kind === 'await') awaitCount += 1;
    }
    if (awaitCount > 1) {
      const sid = stateKeyPath(node);
      issues.push(
        err(
          'single-await-per-state',
          sid,
          `state '${sid}' has ${awaitCount} await exits; at most one allowed`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: exit-kind-well-formedness ──────────────────────────────────────

/**
 * Submit exits must declare a `payload`; await exits must not. The `state()`
 * helper enforces this at construction; the verifier defends against
 * hand-built `meta.aharness` objects that bypass the helper.
 */
function checkExitKindWellFormed(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const exitName of Object.keys(meta.exits)) {
      const exit = meta.exits[exitName];
      if (!exit) continue;
      // Submit exits are stamped with `__aharnessPayloadMarker: true` by the
      // `exit<T>({...})` factory; await exits are plain object literals
      // (no factory wrap). The marker is the runtime tell that the exit
      // came from the typed-payload factory; the loader's AST walker reads
      // the type argument from the wrapping `exit<T>(...)` call.
      const hasMarker =
        (exit as { __aharnessPayloadMarker?: unknown }).__aharnessPayloadMarker === true;
      if (exit.kind === 'await') {
        if (hasMarker) {
          issues.push(
            err(
              'exit-kind-well-formedness',
              sid,
              `await exit '${sid}::${exitName}' must be a plain object literal, not wrapped in exit<T>(...)`,
            ),
          );
        }
        continue;
      }
      // submit (kind === 'submit' or undefined)
      if (!hasMarker) {
        issues.push(
          err(
            'exit-kind-well-formedness',
            sid,
            `submit exit '${sid}::${exitName}' must be wrapped in exit<T>({...})`,
          ),
        );
      }
    }
  }
  return issues;
}

// ─── Check: open-states-have-at-least-one-exit ─────────────────────────────

function checkOpenStatesHaveExits(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || !meta.open) continue;
    if (
      Object.keys(meta.exits).length === 0 &&
      Object.keys(meta.canonicalEvents ?? {}).length === 0
    ) {
      const sid = stateKeyPath(node);
      issues.push(
        err(
          'open-states-have-at-least-one-exit',
          sid,
          `open state '${sid}' declares no exits; the agent has no way to advance`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: await-only-strict-state (warning) ──────────────────────────────

/**
 * Strict (`open: false`) state with exactly one await exit and no submit
 * exit: legal but easy to author by mistake. Spec §10 entry 6.
 */
function checkAwaitOnlyStrictState(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    if (meta.open) continue;
    let awaitCount = 0;
    let submitCount = 0;
    for (const exitName of Object.keys(meta.exits)) {
      const exit = meta.exits[exitName];
      if (!exit) continue;
      if (exit.kind === 'await') awaitCount += 1;
      else submitCount += 1;
    }
    if (awaitCount === 1 && submitCount === 0) {
      const sid = stateKeyPath(node);
      issues.push(
        warn(
          'await-only-strict-state',
          sid,
          `strict state '${sid}' declares only an await exit; agent must yield to owner before any advance — confirm this is intentional`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: author-functions-sync ──────────────────────────────────────────

/** Re-emit loader `author-fn-async` issues. The loader is the AST authority. */
function checkAuthorFunctionsSync(sidecarIssues: ReadonlyArray<SidecarIssue>): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const si of sidecarIssues) {
    if (si.code !== 'author-fn-async') continue;
    issues.push(err('author-functions-sync', si.stateId ?? '', si.message));
  }
  return issues;
}

// ─── Check: machine-uses-aharness-wrapper ───────────────────────────────────

/** Re-emit loader `direct-create-machine` issues. */
function checkMachineUsesAharnessWrapper(
  sidecarIssues: ReadonlyArray<SidecarIssue>,
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const si of sidecarIssues) {
    if (si.code !== 'direct-create-machine') continue;
    issues.push(err('machine-uses-aharness-wrapper', si.stateId ?? '', si.message));
  }
  return issues;
}

// ─── Check: state-exit-tuple-unique ────────────────────────────────────────

/**
 * No two distinct state-key paths may produce the same `(stateId, exitName)`
 * tuple. TypeScript already prevents intra-state collisions (object keys are
 * unique), and `stateKeyPath` is deterministic, so collisions imply two
 * structurally distinct nodes that resolve to the same path string — typically
 * the result of nested-state shadowing or hand-crafted ids that bypass the
 * usual key derivation.
 *
 * The dispatcher routes `submit` calls by `(state, exit)`; a collision here
 * would silently route to whichever node `iterStates` yields second, which is
 * never what the author intended. This check makes the conflict explicit at
 * verify time rather than letting it surface as an "exit not found" mid-run.
 */
function checkStateExitTupleUnique(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  // `tupleKey` -> set of `node.id`s that produced it. We compare the unique-id
  // of the XState StateNode (always distinct) to detect the collision case
  // where two different nodes share a `stateKeyPath`.
  const seen = new Map<string, { sid: string; exit: string; nodeIds: Set<string> }>();
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const exitName of Object.keys(meta.exits)) {
      const exit = meta.exits[exitName];
      if (!exit) continue;
      const tupleKey = `${sid}\x00${exitName}`;
      const slot = seen.get(tupleKey);
      if (!slot) {
        seen.set(tupleKey, { sid, exit: exitName, nodeIds: new Set([node.id]) });
        continue;
      }
      slot.nodeIds.add(node.id);
    }
  }
  for (const slot of seen.values()) {
    if (slot.nodeIds.size <= 1) continue;
    issues.push(
      err(
        'state-exit-tuple-unique',
        slot.sid,
        `(stateId, exitName) tuple '${slot.sid}::${slot.exit}' is declared by ${String(slot.nodeIds.size)} distinct state nodes — submit dispatch would be ambiguous`,
      ),
    );
  }
  return issues;
}

// ─── Check: no-submit-in-spawn-agent-reachable-states ─────────────────────

/**
 * MVP scope: reject any FSM whose root
 * machine declares a submit exit AND whose author functions reference
 * `spawn_agent` by name. The detection is deliberately conservative —
 * codex-side sub-thread submits cost real money, and the runtime-side
 * runtime threadId guard already provides defence in depth, so a small
 * false-positive rate at verify time is acceptable.
 *
 * Signal: search every author-supplied function string body for
 * `spawn_agent`. The function bodies reachable from the verifier are
 * `entryPrompt` (when fn-form) and `stopGuidance` (when set).
 * Tighter analysis (e.g. AST walk of imported tool calls) is deferred.
 */
const SPAWN_AGENT_TOKEN = /\bspawn_agent\b/;

function checkNoSubmitInSpawnAgentReachableStates(machine: AnyStateMachine): VerifyIssue[] {
  let hasSubmitExit = false;
  let referencesSpawnAgent = false;
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    for (const exitName of Object.keys(meta.exits)) {
      if (meta.exits[exitName]?.kind === 'submit') hasSubmitExit = true;
    }
    const nap = meta.entryPrompt;
    if (typeof nap === 'function' && SPAWN_AGENT_TOKEN.test(nap.toString())) {
      referencesSpawnAgent = true;
    }
    if (
      typeof meta.stopGuidance === 'function' &&
      SPAWN_AGENT_TOKEN.test(meta.stopGuidance.toString())
    ) {
      referencesSpawnAgent = true;
    }
  }
  if (hasSubmitExit && referencesSpawnAgent) {
    return [
      err(
        'no-submit-in-spawn-agent-reachable-states',
        '',
        'FSM declares submit exits AND author code references spawn_agent — sub-thread submits ' +
          'are not supported (spec §7.1). The check is conservative (substring match on ' +
          '`spawn_agent` in author-fn bodies) and may produce false positives on comments or ' +
          'unrelated identifiers. If the match is incorrect, rename the offending identifier ' +
          'or restructure to avoid the combination. The runtime threadId guard ' +
          'rejects sub-thread submits regardless.',
      ),
    ];
  }
  return [];
}

// ─── Check: request-user-input-name-collision ──────────────────────────────

/**
 * The aharness runtime receives `tool/requestUserInput` ServerRequests from codex when
 * the model asks to yield to the user. If an FSM-declared author tool is named
 * `request_user_input`, the names would collide on the model's tool catalog.
 *
 * scaffold; activated by a future author tool-declaration surface.
 */
function checkRequestUserInputNameCollision(): VerifyIssue[] {
  const declaredToolNames: ReadonlyArray<{
    readonly serverName: string;
    readonly toolName: string;
  }> = [];
  const issues: VerifyIssue[] = [];
  for (const t of declaredToolNames) {
    if (t.toolName === 'request_user_input') {
      issues.push(
        err(
          'request-user-input-name-collision',
          '',
          `MCP server '${t.serverName}' declares a tool named 'request_user_input'; that name is reserved for codex's owner-yield surface`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: aharness-submit-name-collision ──────────────────────────────────

/**
 * Reject FSMs that declare a state id equal to the reserved framework tool
 * name (`SUBMIT_TOOL_NAME` from `protocol/submitTool.ts`, i.e.
 * `'aharness_submit'`). The dynamic-tool dispatcher resolves model tool
 * calls against that name; allowing a state to shadow it would create
 * ambiguous routing.
 *
 * User MCP registrations in `~/.codex/config.toml` are outside this static
 * FSM property; see the file header for the broader
 * `mcp-submit-tool-name-collision` retirement rationale.
 */
function checkAharnessSubmitNameCollision(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    if (node === machine.root) continue;
    const sid = stateKeyPath(node);
    if (sid === SUBMIT_TOOL_NAME) {
      out.push(
        err(
          'aharness-submit-name-collision',
          sid,
          `state id '${sid}' collides with the reserved framework tool name '${SUBMIT_TOOL_NAME}' — rename the state`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: no-handwritten-submit-await-handlers ──────────────────────────

/**
 * Reads the side-channel field `meta.aharness.__aharness_authoredOnKeys`
 * populated by the synthesizer in `injectFrameworkActions` BEFORE it
 * overwrites `node.on[SUBMIT__/AWAIT__]`. If the snapshot is non-empty,
 * the author hand-wrote keys that are framework-owned.
 */
function checkNoHandwrittenSubmitAwaitHandlers(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = node.meta as { aharness?: { __aharness_authoredOnKeys?: string[] } } | undefined;
    const keys = meta?.aharness?.__aharness_authoredOnKeys ?? [];
    for (const k of keys) {
      out.push(
        err(
          'no-handwritten-submit-await-handlers',
          stateKeyPath(node),
          `state has hand-written on['${k}'] handler; SUBMIT__/AWAIT__ event keys are framework-synthesized — declare the transition via meta.aharness.exits[*] instead`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: exit-target-in-state-set ─────────────────────────────────────

/**
 * Every `to:` in an exit (sugar form or each `when[].to`) names a valid
 * sibling state. Authors write sibling-key targets (`to: 'foo'`), not
 * dotted paths; the check resolves via the node's parent (or root)
 * `states` map — mirroring how `setup().createMachine` resolves at
 * construction time.
 */
function checkExitTargetInStateSet(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      const targets = exitTargets(exit as { to?: string; when?: Array<{ to?: string }> });
      for (const t of targets) {
        try {
          const resolved = resolveSiblingTarget(node, t);
          if (!resolved) {
            out.push(
              err(
                'exit-target-in-state-set',
                sid,
                `exit '${exitName}' targets unknown sibling state '${t}'`,
              ),
            );
          }
        } catch (e) {
          out.push(
            err(
              'exit-target-in-state-set',
              sid,
              `exit '${exitName}' targets unknown sibling state '${t}' (resolver error: ${(e as Error).message})`,
            ),
          );
        }
      }
    }
  }
  return out;
}

function resolveSiblingTarget(node: StateNode, targetKey: string): StateNode | undefined {
  // Strip leading '.' (XState's relative-target convention).
  const key = targetKey.startsWith('.') ? targetKey.slice(1) : targetKey;
  // Hash-id targets (`#foo`) — defer to machine.getStateNodeById.
  if (key.startsWith('#')) {
    try {
      return node.machine.getStateNodeById(key.slice(1));
    } catch {
      return undefined;
    }
  }
  // Sibling lookup — search the parent's `states` map.
  const parent = node.parent ?? node.machine.root;
  return parent.states[key];
}

function exitTargets(exit: { to?: string; when?: Array<{ to?: string }> }): string[] {
  if (typeof exit.to === 'string') return [exit.to];
  if (Array.isArray(exit.when)) {
    return exit.when.map((b) => (typeof b.to === 'string' ? b.to : '')).filter((s) => s.length > 0);
  }
  return [];
}

// ─── Check: canonical-event-target-in-state-set ──────────────────────────

function checkCanonicalEventTargetInStateSet(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [eventName, eventMeta] of Object.entries(meta.canonicalEvents ?? {})) {
      for (const target of canonicalEventTargets(eventMeta)) {
        try {
          const resolved = resolveSiblingTarget(node, target);
          if (!resolved) {
            out.push(
              err(
                'canonical-event-target-in-state-set',
                sid,
                `canonical event '${eventName}' targets unknown sibling state '${target}'`,
              ),
            );
          }
        } catch (e) {
          out.push(
            err(
              'canonical-event-target-in-state-set',
              sid,
              `canonical event '${eventName}' targets unknown sibling state '${target}' (resolver error: ${(e as Error).message})`,
            ),
          );
        }
      }
    }
  }
  return out;
}

function canonicalEventTargets(eventMeta: {
  branches?: ReadonlyArray<{ readonly to?: string }>;
}): string[] {
  return (eventMeta.branches ?? [])
    .map((branch) => (typeof branch.to === 'string' ? branch.to : ''))
    .filter((target) => target.length > 0);
}

// ─── Check: canonical-event-well-formedness ──────────────────────────────

function checkCanonicalEventWellFormed(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    const rawOn = asPlainObject(node.config.on);
    const events = meta.canonicalEvents ?? {};
    for (const [eventName, eventMeta] of Object.entries(events)) {
      if (eventName.startsWith('SUBMIT__') || eventName.startsWith('AWAIT__')) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `canonical event '${eventName}' uses a reserved generated event prefix`,
          ),
        );
      }
      if (meta.exits[eventName] !== undefined) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `canonical event '${eventName}' collides with an exit of the same name`,
          ),
        );
      }
      if (rawOn === null || rawOn[eventName] === undefined) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `canonical event '${eventName}' has no lowered xstate.on handler`,
          ),
        );
      }
      const eventKind = eventMeta.eventKind;
      const knownEventKind =
        eventKind === 'custom' ||
        eventKind === 'permissionRequest' ||
        eventKind === 'preToolUse' ||
        eventKind === 'postToolUse' ||
        eventKind === 'userPromptSubmit';
      if (!knownEventKind) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `canonical event '${eventName}' declares unsupported eventKind '${String(eventKind)}'`,
          ),
        );
      }
      if (eventKind !== 'custom' && eventKind !== eventName) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `built-in canonical event '${eventName}' must declare matching eventKind '${eventName}'`,
          ),
        );
      }
      if (eventKind === 'custom' && isReservedBuiltinEventName(eventName)) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `custom canonical event '${eventName}' uses a reserved built-in hook event name`,
          ),
        );
      }
      if (
        eventKind === 'custom' &&
        eventMeta.request === true &&
        eventMeta.defaultReturn === undefined
      ) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `request event '${eventName}' must declare defaultReturn`,
          ),
        );
      }
      if (eventMeta.match !== undefined) {
        if (eventKind === 'custom' || eventKind === 'userPromptSubmit') {
          out.push(
            err(
              'canonical-event-well-formedness',
              sid,
              `canonical event '${eventName}' does not support match`,
            ),
          );
        }
        if (typeof eventMeta.match !== 'string' || eventMeta.match.length === 0) {
          out.push(
            err(
              'canonical-event-well-formedness',
              sid,
              `canonical event '${eventName}' match must be a non-empty string`,
            ),
          );
        } else {
          try {
            new RegExp(eventMeta.match);
          } catch (e) {
            out.push(
              err(
                'canonical-event-well-formedness',
                sid,
                `canonical event '${eventName}' match is not a valid regex: ${(e as Error).message}`,
              ),
            );
          }
        }
      }
      const branches: ReadonlyArray<unknown> = eventMeta.branches;
      if (!Array.isArray(branches) || branches.length === 0) {
        out.push(
          err(
            'canonical-event-well-formedness',
            sid,
            `canonical event '${eventName}' must declare at least one branch`,
          ),
        );
        continue;
      }
      if (branches.length === 1) {
        const branch = canonicalEventBranchShape(branches[0]);
        if (eventMeta.request !== true && branch?.returnValue !== undefined) {
          out.push(
            err(
              'canonical-event-well-formedness',
              sid,
              `signal event '${eventName}' cannot declare return`,
            ),
          );
        }
        continue;
      }
      for (let i = 0; i < branches.length; i++) {
        const branch = canonicalEventBranchShape(branches[i]);
        if (!branch) continue;
        if (eventMeta.request !== true && branch.returnValue !== undefined) {
          out.push(
            err(
              'canonical-event-well-formedness',
              sid,
              `signal event '${eventName}' route[${i}] cannot declare return`,
            ),
          );
        }
        if (i === branches.length - 1) {
          if (branch.predicate !== undefined) {
            out.push(
              err(
                'canonical-event-well-formedness',
                sid,
                `canonical event '${eventName}' final route branch must omit predicate`,
              ),
            );
          }
        } else if (typeof branch.predicate !== 'function') {
          out.push(
            err(
              'canonical-event-well-formedness',
              sid,
              `canonical event '${eventName}' route[${i}] must declare predicate`,
            ),
          );
        }
      }
    }
  }
  return out;
}

function canonicalEventBranchShape(value: unknown):
  | {
      readonly predicate?: unknown;
      readonly returnValue?: unknown;
    }
  | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  return {
    ...(obj['predicate'] !== undefined ? { predicate: obj['predicate'] } : {}),
    ...(obj['return'] !== undefined ? { returnValue: obj['return'] } : {}),
  };
}

function isReservedBuiltinEventName(name: string): boolean {
  return (
    name === 'permissionRequest' ||
    name === 'preToolUse' ||
    name === 'postToolUse' ||
    name === 'userPromptSubmit'
  );
}

// ─── Check: when-last-unguarded ───────────────────────────────────────────

/**
 * When `exit.when` is present, the final entry must omit `guard:`.
 * Without a catch-all, the synthesized transition table could leave the
 * machine stuck when no guard passes.
 */
function checkWhenLastUnguarded(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      const when = (exit as { when?: Array<{ guard?: unknown }> }).when;
      if (!Array.isArray(when) || when.length === 0) continue;
      const last = when[when.length - 1];
      if (last?.guard !== undefined && !isCanonicalCatchAllBranch(last)) {
        out.push(
          err(
            'when-last-unguarded',
            sid,
            `exit '${exitName}' when[] last entry must be unguarded (catch-all)`,
          ),
        );
      }
    }
  }
  return out;
}

function isCanonicalCatchAllBranch(branch: unknown): boolean {
  if (branch === null || typeof branch !== 'object') return false;
  const canonical = (branch as { __aharnessCanonical?: unknown }).__aharnessCanonical;
  if (canonical === null || typeof canonical !== 'object') return false;
  return (canonical as { predicate?: unknown }).predicate === undefined;
}

// ─── Check: when-array-min-length-2 ──────────────────────────────────────

/**
 * `when:` requires `length >= 2`. An empty array has no branches; a
 * single-element array should use the sugar form `{to, actions}` instead.
 */
function checkWhenArrayMinLength2(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      const when = (exit as { when?: unknown[] }).when;
      if (Array.isArray(when)) {
        if (when.length === 0) {
          out.push(
            err(
              'when-array-min-length-2',
              sid,
              `exit '${exitName}' when[] is empty (declare at least two branches with the last unguarded)`,
            ),
          );
        } else if (when.length === 1) {
          out.push(
            err(
              'when-array-min-length-2',
              sid,
              `exit '${exitName}' when[] has length 1 (use sugar form '{to, actions}' for single branch)`,
            ),
          );
        }
      }
    }
  }
  return out;
}

// ─── Check: await-no-multi-branch ─────────────────────────────────────────

/**
 * `await` exits must use the single-branch shape; `when[]` on an await
 * exit is rejected. AWAIT events carry only `{ownerReply: string}`;
 * guarding on free text would reintroduce transition-by-text in violation
 * of hard rule #3 spirit.
 */
function checkAwaitNoMultiBranch(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      if (
        exit.kind === 'await' &&
        'when' in exit &&
        (exit as { when?: unknown }).when !== undefined
      ) {
        out.push(
          err(
            'await-no-multi-branch',
            sid,
            `await exit '${exitName}' cannot use when[] (single-branch only)`,
          ),
        );
      }
    }
  }
  return out;
}

// ─── Check: exit-shape-exclusive ─────────────────────────────────────────

/**
 * An exit has either `to`/`actions` (sugar) or `when:` (multi-branch),
 * never both. Mixing the forms is ambiguous.
 */
function checkExitShapeExclusive(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      const hasTo = 'to' in exit && (exit as { to?: unknown }).to !== undefined;
      const hasWhen = 'when' in exit && (exit as { when?: unknown }).when !== undefined;
      if (hasTo && hasWhen) {
        out.push(
          err(
            'exit-shape-exclusive',
            sid,
            `exit '${exitName}' cannot have both 'to' (sugar) and 'when' (multi-branch)`,
          ),
        );
      }
    }
  }
  return out;
}

// ─── Check: state-config-missing-aharness-meta ────────────────────────────

/**
 * Fires if a state node has XState behavior (`entry`/`exit`/`always`/`on`/
 * `type: 'final'`) AND has `meta:` set BUT lacks `meta.aharness`.
 *
 * The smoking gun is the spread idiom `{...passive(), entry: 'x', meta: {custom: 'oops'}}`
 * — the literal `meta:` REPLACES the spread's `meta`, so `meta.aharness` is
 * gone entirely. The check forces authors to drop the conflicting `meta:`
 * literal or merge it explicitly without overwriting the helper's aharness payload.
 */
function checkStateConfigMissingAharnessMeta(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    // Skip the root node (the machine itself).
    if (node === node.machine.root) continue;
    // Skip nodes that have no XState entry/exit/transition behavior — they
    // are bare grouping nodes that legitimately have no meta.
    const hasBehavior =
      node.config.entry !== undefined ||
      node.config.exit !== undefined ||
      node.config.always !== undefined ||
      node.config.on !== undefined ||
      node.config.type === 'final';
    if (!hasBehavior) continue;
    // Has behavior. Check meta.
    const meta = node.meta as Record<string, unknown> | undefined;
    if (meta === undefined) {
      // No meta at all — this is fine; the author didn't try to use a helper.
      continue;
    }
    const aharness = meta['aharness'];
    if (aharness === undefined) {
      // The smoking gun: state config has behavior + meta but no aharness.
      // Most likely the author wrote `{...passive(), meta: {custom: 'oops'}}`
      // and the literal meta overwrote the helper's meta.aharness.
      out.push(
        err(
          'state-config-missing-aharness-meta',
          stateKeyPath(node),
          `state has 'meta:' but no 'meta.aharness' — did you spread passive()/terminal() then write a literal 'meta:' that overwrote it? Use { ...passive(), entry: … } without a separate meta key.`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: awaits-owner-text-no-await-exit ───────────────────────────────

/**
 * A state declaring `awaitsOwnerText` must not also declare an `await`-kind
 * exit. The two mechanisms are alternatives; combining them is ambiguous and
 * rejected by the verifier for a simpler mental model.
 */
function checkAwaitsOwnerTextNoAwaitExit(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    if (meta.awaitsOwnerText === undefined) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      if (exit.kind === 'await') {
        out.push(
          err(
            'awaits-owner-text-no-await-exit',
            sid,
            `state declares awaitsOwnerText together with await exit '${exitName}'; use one or the other`,
          ),
        );
      }
    }
  }
  return out;
}

// ─── Check: state-onEntry-must-be-function ────────────────────────────────

/**
 * `meta.aharness.onEntry` must be a function (FSM meta-ops design v2 §6).
 * The runtime check in `state(...)` already throws on non-function
 * values supplied through the helper, but a hand-built `meta.aharness`
 * that bypasses the helper would slip through. The verifier defends
 * the boundary so an unverified machine cannot reach the daemon's
 * dispatcher with a non-callable `onEntry`.
 */
function checkStateOnEntryMustBeFunction(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    if (meta.onEntry === undefined) continue;
    if (typeof meta.onEntry !== 'function') {
      out.push(
        err(
          'state-onEntry-must-be-function',
          stateKeyPath(node),
          `state declares meta.aharness.onEntry but it is ${typeof meta.onEntry} (must be a function)`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: onEntry-only-on-stateful-states ──────────────────────────────

/**
 * `onEntry` is meaningful only on stateful states — terminal and
 * passive metas have no exits to advance through and the daemon's
 * `onStateEntry` short-circuits on non-stateful kinds, so an
 * `onEntry` declared on a `terminal()` / `passive()` meta would
 * silently never run. Reject the combination at verify time so the
 * author hears about the dead code.
 */
function checkOnEntryOnlyOnStatefulStates(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta) continue;
    if (meta.kind === 'stateful') continue;
    // terminal / passive — `onEntry` is not part of the helper-built
    // shape, but a hand-built meta could attach the field. Detect via
    // duck-type read on the unknown side.
    const offending = (meta as { onEntry?: unknown }).onEntry;
    if (offending !== undefined) {
      out.push(
        err(
          'onEntry-only-on-stateful-states',
          stateKeyPath(node),
          `state has kind '${meta.kind}' but declares meta.aharness.onEntry — onEntry is only valid on stateful states`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: state-hooks-must-be-functions ────────────────────────────────

const HOOK_KIND_FIELDS = [
  'preToolUse',
  'postToolUse',
  'userPromptSubmit',
  'permissionRequest',
] as const;

function checkStateHooksMustBeFunctions(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || meta.hooks === undefined) continue;
    const sid = stateKeyPath(node);
    const hooks = meta.hooks as Record<string, unknown>;
    for (const kind of HOOK_KIND_FIELDS) {
      const arr = hooks[kind];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) {
        out.push(err('state-hooks-must-be-functions', sid, `hooks.${kind} must be an array`));
        continue;
      }
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i] as { handler?: unknown } | undefined;
        if (!entry || typeof entry.handler !== 'function') {
          out.push(
            err(
              'state-hooks-must-be-functions',
              sid,
              `hooks.${kind}[${String(i)}].handler must be a function`,
            ),
          );
        }
      }
    }
  }
  return out;
}

// ─── Check: hook-kind-not-yet-supported ──────────────────────────────────

const RESERVED_HOOK_KIND_FIELDS = ['preCompact', 'postCompact', 'sessionStart'] as const;

function checkHookKindNotYetSupported(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || meta.hooks === undefined) continue;
    const sid = stateKeyPath(node);
    const hooks = meta.hooks as Record<string, unknown>;
    for (const kind of RESERVED_HOOK_KIND_FIELDS) {
      if (hooks[kind] !== undefined) {
        out.push(
          err(
            'hook-kind-not-yet-supported',
            sid,
            `hooks.${kind} is not yet supported (reserved for a future SDK release)`,
          ),
        );
      }
    }
  }
  return out;
}

// Type-predicate variant of `Array.isArray` that preserves the input's
// element type. The stock `Array.isArray` narrows `T | undefined` to
// `any[]`, which forces ESLint's no-unsafe-* rules to flag every member
// access on the result. The predicate below preserves the `{ matcher?: unknown }`
// element shape we cast to upstream so the matcher walks below stay strict.
function isHookEntryArray(
  v: ReadonlyArray<{ matcher?: unknown }> | undefined,
): v is ReadonlyArray<{ matcher?: unknown }> {
  return Array.isArray(v);
}

// ─── Check: hook-matcher-not-supported-on-kind ───────────────────────────
// v1 only walks userPromptSubmit. When a future SDK release lifts a
// reserved kind into the supported set (permissionRequest is the most
// likely candidate per spec §9), check whether codex ignores its matcher
// and extend this walk if so. The reserved-kind list is the central
// closed-world checkpoint — see RESERVED_HOOK_KIND_FIELDS above.

function checkHookMatcherNotSupportedOnKind(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || meta.hooks === undefined) continue;
    const sid = stateKeyPath(node);
    const ups: ReadonlyArray<{ matcher?: unknown }> | undefined = (
      meta.hooks as { userPromptSubmit?: ReadonlyArray<{ matcher?: unknown }> }
    ).userPromptSubmit;
    if (ups === undefined) continue;
    if (!isHookEntryArray(ups)) continue;
    for (let i = 0; i < ups.length; i++) {
      const entry = ups[i];
      if (entry && typeof entry.matcher === 'string') {
        out.push(
          err(
            'hook-matcher-not-supported-on-kind',
            sid,
            `hooks.userPromptSubmit[${String(i)}] declares a matcher; codex ignores the matcher for this kind`,
          ),
        );
      }
    }
  }
  return out;
}

// ─── Check: hook-matcher-invalid-regex ────────────────────────────────────

function checkHookMatcherInvalidRegex(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  const matchedKinds: ReadonlyArray<'preToolUse' | 'postToolUse' | 'permissionRequest'> = [
    'preToolUse',
    'postToolUse',
    'permissionRequest',
  ];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || meta.hooks === undefined) continue;
    const sid = stateKeyPath(node);
    const hooks = meta.hooks as Record<string, ReadonlyArray<{ matcher?: unknown }> | undefined>;
    for (const kind of matchedKinds) {
      const arr: ReadonlyArray<{ matcher?: unknown }> | undefined = hooks[kind];
      if (!isHookEntryArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i];
        if (!entry) continue;
        const m: unknown = entry.matcher;
        if (typeof m !== 'string' || m.length === 0) continue;
        try {
          new RegExp(m);
        } catch (e) {
          out.push(
            err(
              'hook-matcher-invalid-regex',
              sid,
              `hooks.${kind}[${String(i)}].matcher '${m}' is not a valid regex: ${(e as Error).message}. Note: the SDK validates matchers with JS RegExp; if your matcher uses Rust-only syntax (e.g. '(?P<name>...)'), rewrite using JS-compatible form (e.g. '(?<name>...)').`,
            ),
          );
          continue;
        }
      }
    }
  }
  return out;
}

// ─── Check: hooks-only-on-stateful-states ────────────────────────────────

function checkHooksOnlyOnStatefulStates(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta) continue;
    if (meta.kind === 'stateful') continue;
    const offending = (meta as { hooks?: unknown }).hooks;
    if (offending !== undefined) {
      out.push(
        err(
          'hooks-only-on-stateful-states',
          stateKeyPath(node),
          `state has kind '${meta.kind}' but declares meta.aharness.hooks — hooks are only valid on stateful states`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: bare-branch-warning (warning) ─────────────────────────────────

/**
 * WARNING (not error). Fires when a non-last branch inside a `when[]` has
 * neither `guard` NOR `actions`. Such an entry is unreachable in practice —
 * a prior catch-all swallows execution — or if no prior catch-all exists,
 * the bare branch becomes one with nothing to do.
 *
 * Carve-out: the LAST entry of `when[]` is the intentional unguarded
 * fallback — it is exempt even if it also has no actions.
 */
function checkBareBranchWarning(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta) continue;
    const sid = stateKeyPath(node);
    for (const [exitName, exit] of Object.entries(meta.exits)) {
      const when = (exit as { when?: Array<{ guard?: unknown; actions?: unknown }> }).when;
      if (!Array.isArray(when)) continue;
      // Carve-out: last entry is the unguarded fallback, exempt.
      for (let i = 0; i < when.length - 1; i++) {
        const b = when[i];
        if (b && b.guard === undefined && b.actions === undefined) {
          out.push(
            warn(
              'bare-branch-warning',
              sid,
              `exit '${exitName}' when[${String(i)}] has no guard and no actions (likely unreachable; the prior catch-all swallows execution)`,
            ),
          );
        }
      }
    }
  }
  return out;
}

// ─── Check: embedded-final-must-be-wired ──────────────────────────────────

/**
 * Every `final()` state declared inside an embedded child must have a
 * corresponding entry in the parent's `on:` map (the second arg to `embed()`).
 * The `embed()` combinator already enforces this at construction time —
 * this verifier check exists for parity with the rest of the closed-world
 * set: the post-machine resolved tree is independently re-checked against
 * the `meta.aharness.embedded` provenance so an FSM-builder bug that
 * bypasses `embed()` (e.g. a hand-built `meta.aharness.embedded`) cannot
 * smuggle through.
 */
function checkEmbeddedFinalMustBeWired(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    // `iterStates` yields live `StateNode` instances. XState 5 sets
    // `StateNode.meta = config.meta` at construction; we read off `.meta`
    // directly so test mutations to `node.meta.aharness.embedded.onMap`
    // (the live object — see verify.embed.test.ts) are visible here.
    const meta = (node.meta as { aharness?: { embedded?: unknown } } | undefined)?.aharness
      ?.embedded as
      | { exits: ReadonlyArray<string>; onMap: Readonly<Record<string, unknown>>; source: string }
      | undefined;
    if (!meta) continue;
    const onSet = new Set(Object.keys(meta.onMap));
    const finalSet = new Set(meta.exits);
    const missing = meta.exits.filter((f) => !onSet.has(f));
    const extra = Object.keys(meta.onMap).filter((k) => !finalSet.has(k));
    const stateId = stateKeyPath(node);
    if (missing.length > 0) {
      out.push(
        err(
          'embedded-final-must-be-wired',
          stateId,
          `embedded(${meta.source}) at '${stateId}': on-map missing entries for final(s): ${missing.join(', ')}`,
        ),
      );
    }
    if (extra.length > 0) {
      out.push(
        err(
          'embedded-final-must-be-wired',
          stateId,
          `embedded(${meta.source}) at '${stateId}': on-map references unknown final(s): ${extra.join(', ')}`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: embedding-acyclic ─────────────────────────────────────────────

/**
 * Walk the `meta.aharness.embedded` chain and reject any cycle.
 *
 * `embed()` lifts the child's already-resolved config into `states`, so a
 * transitive cycle (A embeds B embeds A) constructed via `embed()` alone
 * would manifest as an infinite tree at `aharness.machine()` time and Node
 * would stack-overflow before the verifier ran. The check exists for the
 * remaining attack vector: a hand-built `meta.aharness.embedded.childConfig`
 * that bypasses `embed()` and points back at an ancestor's source. We walk
 * `machine.config` (not `iterStates`) because the cycle lives in raw config
 * pointers, not the resolved StateNode tree.
 */
function checkEmbeddingAcyclic(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  function walk(
    node:
      | {
          meta?: { aharness?: { embedded?: { source: string; childConfig: unknown } } };
          states?: Record<string, unknown>;
        }
      | undefined,
    seen: ReadonlyArray<string>,
    pathLabel: string,
  ): void {
    if (!node) return;
    const embedded = node.meta?.aharness?.embedded;
    if (embedded) {
      if (seen.includes(embedded.source)) {
        out.push(
          err(
            'embedding-acyclic',
            pathLabel,
            `embedding cycle detected: ${[...seen, embedded.source].join(' -> ')}`,
          ),
        );
        return;
      }
      const child = embedded.childConfig as { states?: Record<string, unknown> } | undefined;
      if (child) {
        walk(child, [...seen, embedded.source], `${pathLabel}.<embedded:${embedded.source}>`);
      }
    }
    if (node.states) {
      for (const [k, v] of Object.entries(node.states)) {
        walk(v as Parameters<typeof walk>[0], seen, pathLabel === '' ? k : `${pathLabel}.${k}`);
      }
    }
  }
  walk(machine.config as Parameters<typeof walk>[0], [], '');
  return out;
}

// ─── Check: embedded-input-must-be-satisfied ──────────────────────────────

/**
 * Walk every embedded compound state. Read the child FSM's
 * `meta.aharness.embedded.childConfig.input` declaration. The parent must
 * satisfy every required (no-default) field via `embed()`'s `input`
 * projection function.
 *
 * Two layers cover this rule:
 *   1. Static type check at TS-compile time (Task 17): `embed<TParent, TChild>`
 *      rejects projection mismatch at user `tsc` time.
 *   2. Runtime probe at verify time (this check): invoke the projection with a
 *      synthesized parent context (`{}`) and read the keys of the returned
 *      object; subtract from the child's required fields; flag any that remain.
 *
 * The runtime probe is conservative — a projection that derives keys from
 * runtime context state will produce different keys than static analysis,
 * and may even throw on the synthesized empty context. When the probe
 * throws, the check emits a `embedded-input-must-be-satisfied` WARNING
 * noting the static type-check is authoritative, and CONTINUES recursing
 * into nested `node.states` so deeper embeds still get checked.
 */
function checkEmbeddedInputMustBeSatisfied(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  type ChildInputDecl = Record<string, { meta?: { default?: unknown } } | undefined>;
  type EmbeddedNode = {
    meta?: {
      aharness?: {
        embedded?: {
          source: string;
          childConfig: { input?: ChildInputDecl };
          input?: (a: { context: Record<string, unknown> }) => Record<string, unknown>;
        };
      };
    };
    states?: Record<string, unknown>;
  };
  function walk(node: EmbeddedNode | undefined, pathLabel: string): void {
    if (!node) return;
    const embedded = node.meta?.aharness?.embedded;
    if (embedded) {
      const childInput = embedded.childConfig?.input;
      if (childInput) {
        const requiredFields = Object.keys(childInput).filter(
          (k) => childInput[k]?.meta?.default === undefined,
        );
        let providedKeys = new Set<string>();
        let probeFailed = false;
        if (typeof embedded.input === 'function') {
          try {
            const projected = embedded.input({ context: {} });
            if (projected && typeof projected === 'object') {
              providedKeys = new Set(Object.keys(projected));
            }
          } catch {
            probeFailed = true;
          }
        }
        if (probeFailed) {
          // Author projection requires real ctx state; the runtime probe
          // cannot statically determine the keys. Emit a WARNING noting
          // the static type-check is authoritative, and CONTINUE walking
          // so deeper embeds still get checked.
          out.push(
            warn(
              'embedded-input-must-be-satisfied',
              pathLabel,
              `embedded(${embedded.source}) at '${pathLabel}': could not statically probe input projection (it threw on synthesized empty context). Relying on TS type-check (InputOf<typeof child>) — see Task 17.`,
            ),
          );
        } else {
          const missing = requiredFields.filter((f) => !providedKeys.has(f));
          if (missing.length > 0) {
            out.push(
              err(
                'embedded-input-must-be-satisfied',
                pathLabel,
                `embedded(${embedded.source}) at '${pathLabel}': required input field(s) not satisfied by parent projection: ${missing.join(', ')}. Remedies: (a) add the field to the parent's own input declaration so it becomes a CLI flag, then thread it through; (b) wire it internally (router state, default value, etc).`,
              ),
            );
          }
        }
      }
    }
    if (node.states) {
      for (const [k, v] of Object.entries(node.states)) {
        walk(v as EmbeddedNode, pathLabel === '' ? k : `${pathLabel}.${k}`);
      }
    }
  }
  walk(machine.config as EmbeddedNode, '');
  return out;
}

// ─── Check: embedded-state-exclusive ──────────────────────────────────────

/**
 * Embed-host states are exclusive: they declare `embed()` and nothing else
 * (spec §4.6 + §6.2 entry 5). Authors who try to bolt on `entryPrompt`,
 * author-`exits`, `awaitsOwnerText`, `onEntry`, or hand-written `on:` keys
 * must be rejected at verify time. This is what makes bare final-id event
 * names safe — there is no co-tenant to collide with.
 *
 * Four rejection paths:
 *   1. `meta.aharness.<field>` for the per-state-shape fields (`kind`, `open`,
 *      `exits`, `entryPrompt`, `awaitsOwnerText`, `onEntry`, `stopGuidance`)
 *      — these mark a state as `stateful`/`terminal`/`passive`, mutually
 *      exclusive with `embedded`.
 *   2. Node-level XState behavior fields (`exit`, `always`, `after`, `invoke`)
 *      — embed-hosts have only the framework-synthesized `on:` plus child-
 *      forwarded `entry`. NB: `entry` is intentionally NOT in this list because
 *      `embed()` forwards `child.entry` to the host compound (embed.ts:175).
 *   3. Author-written node-level aharness fields (`entryPrompt`, `exits`,
 *      `awaitsOwnerText`, `onEntry`, `stopGuidance`, `open`) — authors who
 *      spread-bypass the helpers may bolt these on at the node level rather
 *      than inside `meta.aharness`. The fields are aharness-aware, never legal
 *      at node level, and a strong signal of author confusion about where
 *      they belong.
 *   4. Author-written `on:` keys outside the synth on['<finalId>'] set — the
 *      synthesizer (machine.ts) writes one entry per `embed.onMap` final id;
 *      any other key is author-written and rejected.
 *
 * Read locations for (2) and (3): we walk `node.config` (the user's original
 * config object preserved by XState) — that is where authored fields live
 * after construction. For `always`, we additionally read `node.always` so
 * runtime-style mutations on the resolved StateNode (used in tests to
 * simulate spread-bypass) are caught. The other XState behavior fields
 * (`entry`, `exit`, `after`, `invoke`) all default to `[]` on the StateNode
 * instance, so reading them off the node directly would false-positive on
 * every node — those are checked via `node.config` only.
 */
const HOST_RESERVED_AHARNESS_FIELDS = [
  'kind',
  'open',
  'exits',
  'entryPrompt',
  'awaitsOwnerText',
  'onEntry',
  'stopGuidance',
] as const;

// Node-level XState behavior fields the host must not declare. `entry` is
// excluded because `embed()` forwards `child.entry` to the host compound
// (embed.ts:175) — a legitimate forward, not an author bolt-on.
const NODE_RESERVED_FIELDS = ['exit', 'always', 'after', 'invoke'] as const;

// Author-aware aharness field names that, if found at the node level (rather
// than inside `meta.aharness`), indicate a spread-bypass bolt-on. None of
// these are legal XState top-level fields either.
const HOST_FORBIDDEN_NODE_AHARNESS_FIELDS = [
  'entryPrompt',
  'exits',
  'awaitsOwnerText',
  'onEntry',
  'stopGuidance',
  'open',
] as const;

function checkEmbeddedStateExclusive(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = (node.meta as { aharness?: Record<string, unknown> } | undefined)?.aharness;
    if (!meta || meta['embedded'] === undefined) continue;
    const stateId = stateKeyPath(node);
    const cfg = node.config as Record<string, unknown>;

    // (1) Reject mutually-exclusive aharness fields on the host meta.
    for (const field of HOST_RESERVED_AHARNESS_FIELDS) {
      if (meta[field] !== undefined) {
        out.push(
          err(
            'embedded-state-exclusive',
            stateId,
            `embed-host state '${stateId}' must not declare meta.aharness.${field} — embed-host states declare embed() and nothing else (spec §4.6)`,
          ),
        );
      }
    }

    // (2) Reject node-level XState behavior fields the host must not bolt on.
    // `entry` is intentionally excluded — `embed()` forwards `child.entry` to
    // the host compound, which is legitimate. We read from `node.config` (the
    // user's original config) so XState defaults on the resolved StateNode
    // (`exit: []`, `after: []`, `invoke: []`) do not false-positive. For
    // `always` specifically we also check the resolved StateNode property
    // because `node.always` defaults to `undefined` and runtime mutations
    // there are a legitimate signal.
    for (const field of NODE_RESERVED_FIELDS) {
      const inConfig = cfg[field] !== undefined;
      const onNode =
        field === 'always' && (node as unknown as Record<string, unknown>)[field] !== undefined;
      if (inConfig || onNode) {
        out.push(
          err(
            'embedded-state-exclusive',
            stateId,
            `embed-host state '${stateId}' has node-level '${field}' — embed-host states declare embed() and nothing else (spec §4.6)`,
          ),
        );
      }
    }

    // (3) Reject author-aware aharness field names appearing at the node level
    //     (the spread-bypass-bolt-on case). These are never legal XState
    //     top-level fields; their presence at node level signals author
    //     confusion about where the field belongs.
    for (const field of HOST_FORBIDDEN_NODE_AHARNESS_FIELDS) {
      if (cfg[field] !== undefined) {
        out.push(
          err(
            'embedded-state-exclusive',
            stateId,
            `embed-host state '${stateId}' has node-level '${field}' — host state may not declare '${field}' at the node level; embed-host states declare embed() and nothing else (spec §4.6)`,
          ),
        );
      }
    }

    // (4) Reject author-written on: keys outside the synth on['<finalId>'] set.
    const embedded = meta['embedded'] as { onMap?: Record<string, unknown> } | undefined;
    const allowedFinalIds = new Set(Object.keys(embedded?.onMap ?? {}));
    const nodeOn = (node as { on?: Record<string, unknown> }).on ?? {};
    for (const key of Object.keys(nodeOn)) {
      if (!allowedFinalIds.has(key)) {
        out.push(
          err(
            'embedded-state-exclusive',
            stateId,
            `embed-host state '${stateId}' has author-written on-key '${key}' — embed-host states declare embed() and nothing else; only on-keys synthesized from embed.on are allowed (spec §4.6)`,
          ),
        );
      }
    }
  }
  return out;
}

// ─── Check: final-output-must-be-function ─────────────────────────────────

/**
 * `meta.aharness.output` on a `terminal` meta must be a function when present
 * (final() output callback design). The runtime guard inside `final()`
 * already throws on non-function values supplied through the helper; the
 * verifier defends the boundary against hand-built `meta.aharness` literals
 * that bypass the helper (e.g. authors who construct
 * `{ kind: 'terminal', outcome: 'success', output: 'not-a-fn' }` directly,
 * or third-party tooling that synthesizes config from a non-TypeScript
 * source). Mirrors `state-onEntry-must-be-function`.
 */
function checkFinalOutputMustBeFunction(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    // Read raw meta — getAharnessMeta would have thrown upstream for non-conforming
    // shapes. Reading node.meta.aharness directly preserves the bypass case.
    const meta = (node.meta as { aharness?: { kind?: string; output?: unknown } } | undefined)
      ?.aharness;
    if (!meta || meta.kind !== 'terminal') continue;
    if (meta.output === undefined) continue; // optional field
    if (typeof meta.output !== 'function') {
      const stateId = stateKeyPath(node);
      out.push(
        err(
          'final-output-must-be-function',
          stateId,
          `final() at '${stateId}': output must be a function (got ${typeof meta.output})`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: embedded-child-must-have-finals ───────────────────────────────

/**
 * Every embed-host state's child FSM must declare at least one `final()` node
 * (spec §6.2 entry 6). A child with no finals can never advance the parent —
 * the host compound has no synthesized on-keys, so the parent silently
 * deadlocks once it enters the host. `embed()`'s constructor-time guard
 * (`embed.ts`) already throws on this shape; this verifier check is the
 * closed-world rule for an FSM-builder bypass that hand-builds the embedded
 * shape directly via `meta.aharness.embedded`.
 */
function checkEmbeddedChildMustHaveFinals(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = (node.meta as { aharness?: { embedded?: unknown } } | undefined)?.aharness
      ?.embedded as { exits?: ReadonlyArray<string>; source?: string } | undefined;
    if (!meta) continue;
    const exits = meta.exits ?? [];
    if (exits.length === 0) {
      const stateId = stateKeyPath(node);
      out.push(
        err(
          'embedded-child-must-have-finals',
          stateId,
          `embed-host state '${stateId}': embedded child '${meta.source ?? '<unknown>'}' declares no final() nodes — children with no finals can never advance the parent (silent deadlock). Spec §6.2.`,
        ),
      );
    }
  }
  return out;
}

// ─── Check: embedded-final-id-name-shape ──────────────────────────────────

/**
 * Bare child final ids are used as event-types in the embed-host compound's
 * synthesized `on:` map (§5.2). Two name-shape constraints (Spec §6.2 entry 7):
 *
 * 1. Must not begin with `xstate.` — XState reserves that prefix for its own
 *    framework events (`xstate.done.state.*`, `xstate.after.*`, etc.). A child
 *    final id like `xstate.shipped` would be indistinguishable from a framework
 *    event and could collide unpredictably with future XState additions.
 *
 * 2. Must not contain `.` (the qualified-state-id separator). Three independent
 *    rationales:
 *    a. XState 5 does not support `.` in state-key names. Final ids ARE state
 *       keys (see `child.states[finalId]` in `state/embed.ts:109-117`).
 *    b. `stateKeyPath` (`state.ts:67`) and the embedded output-registry key
 *       (`state/machine.ts:287` — `path.join('.') + '::output'`) produce
 *       ambiguous, non-round-trippable strings if `.` appears in any segment.
 *       E.g., `outer.shipped` as a leaf-segment would collide on join with the
 *       qualified path of any sibling state hierarchy `outer/shipped`.
 *    c. XState 5 supports prefix wildcard event descriptors
 *       (`on: { 'release.*': ... }`). The embed-host state itself is exclusive,
 *       but its **ancestors are not** — an ancestor's wildcard could silently
 *       catch a `release.candidate` final raise. Bare ids (`shipped`, `failed`)
 *       cannot match a `<segment>.*` pattern.
 *
 * One issue is emitted per offending final id with the most specific message:
 * `xstate.` is checked first (it implies a `.` too); otherwise the bare-`.`
 * rule fires.
 */
function checkEmbeddedFinalIdNameShape(machine: AnyStateMachine): VerifyIssue[] {
  const out: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const embedded = (
      node.meta as
        | { aharness?: { embedded?: { exits?: ReadonlyArray<string>; source?: string } } }
        | undefined
    )?.aharness?.embedded;
    if (!embedded) continue;
    const stateId = stateKeyPath(node);
    for (const finalId of embedded.exits ?? []) {
      if (finalId.startsWith('xstate.')) {
        out.push(
          err(
            'embedded-final-id-name-shape',
            stateId,
            `embed-host state '${stateId}': child '${embedded.source ?? '<unknown>'}' declares final id '${finalId}' beginning with 'xstate.' (reserved XState event namespace).`,
          ),
        );
      } else if (finalId.includes('.')) {
        out.push(
          err(
            'embedded-final-id-name-shape',
            stateId,
            `embed-host state '${stateId}': child '${embedded.source ?? '<unknown>'}' declares final id '${finalId}' containing '.' (qualified-state-id separator). The embedded output-registry key (path.join('.') + '::output') becomes ambiguous and non-round-trippable when any segment contains '.'.`,
          ),
        );
      }
    }
  }
  return out;
}

// ─── Check: skills-only-on-stateful-states ─────────────────────────────────

/**
 * `skills:` is meaningful only on stateful states — passive and terminal
 * states have no `entryPrompt` lowering path, so a skill body declared on
 * one would never be injected. Mirrors `onEntry-only-on-stateful-states`.
 */
function checkSkillsOnlyOnStatefulStates(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta) continue;
    if (meta.kind === 'stateful') continue;
    const raw = (node.config as { meta?: { aharness?: { skills?: unknown } } }).meta?.aharness
      ?.skills;
    if (raw !== undefined) {
      const sid = stateKeyPath(node);
      issues.push(
        err(
          'skills-only-on-stateful-states',
          sid,
          `state '${sid}' declares 'skills' on a non-stateful (${meta.kind}) state — skills are meaningful only on stateful states (the per-state orientation nudge fires only on stateful entries)`,
        ),
      );
    }
  }
  return issues;
}

// ─── Check: skill-name-shape + skill-no-duplicate-names-on-state ───────────

const SKILL_NAME_SHAPE = /^[a-z][a-z0-9-]*$/;

function checkSkillNameShapeAndDuplicates(machine: AnyStateMachine): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || !meta.skills) continue;
    const sid = stateKeyPath(node);
    const seen = new Set<string>();
    for (let i = 0; i < meta.skills.length; i++) {
      const ref = meta.skills[i];
      if (!isSkillRef(ref)) continue;
      if (ref.source === 'name' && !SKILL_NAME_SHAPE.test(ref.name)) {
        issues.push(
          err(
            'skill-name-shape',
            sid,
            `state '${sid}' skills[${String(i)}]: name '${ref.name}' must match ${SKILL_NAME_SHAPE.source} (lowercase, digits, hyphens; starting with a letter)`,
          ),
        );
      }
      const key = ref.source === 'name' ? `name:${ref.name}` : `path:${ref.path}`;
      if (seen.has(key)) {
        issues.push(
          err(
            'skill-no-duplicate-names-on-state',
            sid,
            `state '${sid}' skills[${String(i)}]: duplicate skill '${key}' on the same state`,
          ),
        );
      }
      seen.add(key);
    }
  }
  return issues;
}

// ─── Check: skill-must-resolve ─────────────────────────────────────────────

/**
 * Walk every stateful state's `skills:` array and resolve each ref against
 * the supplied `SkillResolverEnv`. Non-optional misses produce an error;
 * optional misses produce a warning.
 */
function checkSkillsResolve(machine: AnyStateMachine, env: SkillResolverEnv): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const node of iterStates(machine)) {
    const meta = asStatefulMeta(node);
    if (!meta || !meta.skills) continue;
    const sid = stateKeyPath(node);
    for (let i = 0; i < meta.skills.length; i++) {
      const ref = meta.skills[i];
      if (!isSkillRef(ref)) continue;
      const res = resolveSkill(ref, env);
      if (res.kind === 'resolved') continue;
      const ctx = `state '${sid}' skills[${String(i)}] (${res.displayName}): not found in any of:\n  - ${res.searched.join('\n  - ')}`;
      issues.push(
        res.optional ? warn('skill-must-resolve', sid, ctx) : err('skill-must-resolve', sid, ctx),
      );
    }
  }
  return issues;
}
