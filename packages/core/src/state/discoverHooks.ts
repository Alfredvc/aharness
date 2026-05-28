/**
 * Walk an XState machine and return the union of codex hook kinds the FSM
 * declares on `meta.aharness.hooks` or canonical built-in hook events. Returned
 * in PascalCase (codex's wire form) so the result is suitable as a
 * `-c hooks.<Kind>=...` key.
 *
 * Spec: docs/specs/2026-05-08-per-state-hooks-design.md §5.7.
 */
import type { AnyStateMachine } from 'xstate';

import { getAharnessMeta, iterStates } from '../state.js';
import type { HookKind } from './hooks.js';

/**
 * Order matches codex's `HOOK_EVENT_NAMES` declaration in
 * `codex-rs/hooks/src/lib.rs`. The result is iterated by Phase C's CLI to
 * emit `-c hooks.<Kind>=...` overrides; declaration order keeps the override
 * sequence stable and easy to read against codex's source.
 */
const KIND_FIELD_TO_PASCAL: ReadonlyArray<readonly [string, HookKind]> = [
  ['preToolUse', 'PreToolUse'],
  ['postToolUse', 'PostToolUse'],
  ['userPromptSubmit', 'UserPromptSubmit'],
];

export function discoverDeclaredHookKinds(machine: AnyStateMachine): ReadonlyArray<HookKind> {
  const found = new Set<HookKind>();
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta || meta.kind !== 'stateful') continue;
    const hooks = meta.hooks as Record<string, ReadonlyArray<unknown> | undefined> | undefined;
    for (const [field, pascal] of KIND_FIELD_TO_PASCAL) {
      const arr = hooks?.[field];
      if (Array.isArray(arr) && arr.length > 0) {
        found.add(pascal);
      }
      const event = meta.canonicalEvents?.[field];
      if (event?.kind === 'event' && event.eventKind === field) {
        found.add(pascal);
      }
    }
  }
  // Emit in KIND_FIELD_TO_PASCAL declaration order (codex `HOOK_EVENT_NAMES`
  // order), not insertion order, for deterministic output regardless of which
  // state declared which kind first.
  const ordered: HookKind[] = [];
  for (const [, pascal] of KIND_FIELD_TO_PASCAL) {
    if (found.has(pascal)) ordered.push(pascal);
  }
  return Object.freeze(ordered);
}
