/**
 * Internal helpers for the @aharness/core verifier.
 *
 * Duplicated from `@aharness/core`'s `src/internal/` per migration plan R1
 * (the `internal/` folder is deliberately not on the public barrel; rather
 * than expose it, @aharness/core vendors the small helpers here). Keep the
 * implementations byte-equivalent with the CC sdk so the verifier can ship
 * byte-for-byte modulo the documented renames (R4).
 */
import type {
  AnyStateMachine,
  EventObject,
  MachineContext,
  StateNode,
  TransitionDefinition,
} from 'xstate';

/**
 * Narrow an unknown value to a plain (non-array) object, or `null` if not.
 * Use at structural-walk sites where a `Record<string, unknown>` shape is
 * expected and the alternative is silent skip on shape mismatch.
 */
export function asPlainObject(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Outgoing transitions on a node, flattened from the `Map<eventType, defs[]>`
 * exposed by XState plus the eventless `always` array.
 */
export function getStateNodeTransitions(
  node: StateNode,
): readonly TransitionDefinition<MachineContext, EventObject>[] {
  const out: TransitionDefinition<MachineContext, EventObject>[] = [];
  const transitions = node.transitions;
  if (transitions instanceof Map) {
    for (const list of transitions.values()) {
      for (const t of list) out.push(t);
    }
  }
  if (Array.isArray(node.always)) {
    for (const t of node.always) out.push(t);
  }
  return out;
}

/** Root state node of a machine. */
export function getRootStateNode(machine: AnyStateMachine): StateNode {
  return machine.root as StateNode;
}

/**
 * Implementations bag (`guards` / `actions` / `actors`) attached to a machine.
 */
export function getMachineImplementations(machine: AnyStateMachine): {
  readonly guards: Readonly<Record<string, unknown>>;
  readonly actions: Readonly<Record<string, unknown>>;
  readonly actors: Readonly<Record<string, unknown>>;
} {
  const impls = machine.implementations as unknown as
    | {
        guards?: Record<string, unknown>;
        actions?: Record<string, unknown>;
        actors?: Record<string, unknown>;
      }
    | undefined;
  return {
    guards: impls?.guards ?? {},
    actions: impls?.actions ?? {},
    actors: impls?.actors ?? {},
  };
}
