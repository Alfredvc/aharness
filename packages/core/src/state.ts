/**
 * State-machine inspection helpers — `@aharness/core` §4.3.
 *
 * Pure walkers over an XState machine + schema sidecar. Used by:
 *   - the runtime/verifier to build legacy exit-tool definitions used by
 *     compatibility tests and sidecar checks;
 *   - the verifier to enumerate every state once for its checks.
 *
 * Pure: no I/O, no globals.
 */
import type { AnyStateMachine, StateNode } from 'xstate';
import { BuildExitToolsError } from './state/buildExitToolsError.js';
import { validateAharnessMeta } from './state/validateAharnessMeta.js';
import type { AwaitToolDef, AharnessMeta, SchemaSidecar, SubmitToolDef } from './types.js';

/**
 * Walk every `StateNode` in the machine — root, child, deep-nested,
 * parallel branches — and yield each exactly once. Iteration order is the
 * machine's `setup` declaration order at each level (XState exposes
 * children as a plain object); the order is stable but not specified to
 * be alphabetical.
 */
export function* iterStates(machine: AnyStateMachine): Iterable<StateNode> {
  // `machine.root` is typed as `StateNode<any, any>`; we widen to the
  // bare `StateNode` for our walker — we never read context-typed fields
  // off it, only structural ones (id, type, config, states, parent).
  const queue: StateNode[] = [machine.root as StateNode];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    yield node;
    for (const childKey of Object.keys(node.states)) {
      const child = node.states[childKey];
      if (child) queue.push(child);
    }
  }
}

/**
 * Read the `meta.aharness` marker off a `StateNode`. Returns `undefined`
 * when the user did not annotate the state. The verifier and the
 * tool-builder both go through this helper so future shape changes have
 * exactly one update site.
 */
export function getAharnessMeta(node: StateNode): AharnessMeta | undefined {
  const raw: unknown = node.config.meta;
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  const aharnessField = (raw as { aharness?: unknown }).aharness;
  return validateAharnessMeta(aharnessField);
}

/**
 * The state's user-facing dotted-key path from the machine root. Excludes
 * the machine id prefix that XState bakes into `node.id`. Examples for a
 * machine with `id: 'spec'`:
 *
 *   - top-level state `iterateItems`     -> `'iterateItems'`
 *   - nested `workflow.iterateItems`     -> `'workflow.iterateItems'`
 *
 * This is what the spec calls a "state id" in §3.3 (sidecar key) and
 * §3.2 (`SUBMIT__<stateId>__<exitName>` event names) — distinct from
 * XState's machine-prefixed `node.id`.
 *
 * The root node's path is empty string; callers filter it out.
 */
export function stateKeyPath(node: StateNode): string {
  if (!node.parent) return '';
  // `node.path` is an array like `['workflow', 'iterateItems']`.
  return node.path.join('.');
}

/**
 * Legacy tool defs derived from the machine's exit catalogue.
 *
 * - `submit` — one entry per declared submit exit, across every stateful
 *   state. Names follow `submit_<stateId>__<exitName>`.
 * - `await_` — present iff at least one stateful state declares an await
 *   exit. The single tool is shared across the run; the runtime gates its
 *   surfacing per the active state's posture. Name is
 *   `await_user_message`.
 */
export interface ExitToolSet {
  readonly submit: ReadonlyArray<SubmitToolDef>;
  readonly await_?: AwaitToolDef;
}

/**
 * Build legacy exit-tool defs for every exit declared by `machine`.
 *
 * - Walks every state via `iterStates`.
 * - Filters to those declaring `meta.aharness.kind === 'stateful'`.
 * - For each submit exit, looks up the JSON Schema in
 *   `sidecar[stateId][exitName]` and emits a `SubmitToolDef`.
 * - Emits at most one `AwaitToolDef` (`await_user_message`) when any
 *   stateful state declares at least one await exit.
 *
 * Throws if a submit exit has no sidecar entry — the verifier catches
 * this earlier; reaching this function with the gap means the runtime
 * skipped verification and we want a hard error rather than accepting an
 * exit with no schema.
 *
 * Known v1 limitation: a `stateId` or `exitName` containing `__`
 * (double underscore) collides with the tool-name separator. Acceptable
 * for the example FSMs we ship; revisit if a real user hits it.
 */
export function buildExitTools(machine: AnyStateMachine, sidecar: SchemaSidecar): ExitToolSet {
  const submitTools: SubmitToolDef[] = [];
  let anyAwait = false;
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta || meta.kind !== 'stateful') continue;
    const stateId = stateKeyPath(node);
    for (const exitName of Object.keys(meta.exits)) {
      const exit = meta.exits[exitName];
      if (!exit) continue;
      if (exit.kind === 'await') {
        anyAwait = true;
        continue;
      }
      const sidecarEntry = sidecar[stateId]?.[exitName];
      if (!sidecarEntry) {
        throw new BuildExitToolsError(
          'no-sidecar-entry',
          stateId,
          exitName,
          `buildExitTools: no schema sidecar entry for '${stateId}::${exitName}'. ` +
            `Did the verifier run?`,
        );
      }
      const description = exit.description ?? `Submit exit '${exitName}' on state '${stateId}'.`;
      submitTools.push({
        name: `submit_${stateId}__${exitName}`,
        description,
        inputSchema: sidecarEntry.jsonSchema,
        stateId,
        exitName,
      });
    }
  }
  if (anyAwait) {
    const awaitTool: AwaitToolDef = {
      name: 'await_user_message',
      description:
        'Yield to the owner and end the turn.\n\n' +
        'CONTRACT — read carefully. You MUST say `messageToUser` to the user as plain ' +
        'assistant text in this same turn BEFORE calling this tool. The framework ' +
        'verifies that the assistant text in this turn contains messageToUser; small ' +
        'paraphrasing (punctuation, casing, minor wording) is tolerated, but ' +
        'significant deviation or omission rejects the call (PreToolUse deny). On ' +
        'reject, restate the question verbatim as plain assistant text and retry.\n\n' +
        'The framework does NOT render messageToUser on its own — your assistant text ' +
        'is the user-facing surface. messageToUser is duplicated in the tool input ' +
        'for verification only.',
      inputSchema: {
        type: 'object',
        properties: {
          messageToUser: {
            type: 'string',
            minLength: 1,
            description:
              'Exact question or prompt you said to the user as plain assistant text in ' +
              'this turn. Required. The framework matches this against your assistant ' +
              'text; significant deviation rejects the call.',
          },
        },
        required: ['messageToUser'],
        additionalProperties: false,
      },
    };
    return { submit: submitTools, await_: awaitTool };
  }
  return { submit: submitTools };
}
