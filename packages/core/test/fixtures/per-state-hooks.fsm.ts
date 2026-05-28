/**
 * Test fixture for `perStateHooks.e2e.test.ts` — spec §11 acceptance #1.
 *
 * Topology:
 *
 *   gather (stateful, preToolUse deny ^Bash$) ──submit→ implement (stateful, no hooks)
 *                                                            │
 *                                                            └──submit→ done (terminal, success)
 *
 * The PreToolUse handler in `gather` denies any tool name matching `^Bash$`
 * with a stable reason string. The same shape of tool call in `implement`
 * (which declares no hooks) returns the empty `{}` reply (allow).
 *
 * The PreToolUse handler is deliberately synchronous and pure so the
 * dispatcher's behaviour does not depend on Promise scheduling. The deny
 * shape mirrors codex's wire format (camelCase per spec §4.3) so the
 * aggregated reply lands on the wire byte-identical to what codex's
 * stdout parser expects.
 */
import { exit, aharness, state, terminal } from '@aharness/core';

interface GatherPayload {
  readonly note: string;
}

interface ImplementPayload {
  readonly result: string;
}

export const machine = aharness.machine({
  id: 'per-state-hooks-e2e',
  initial: 'gather',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    gather: state({
      entryPrompt: 'Gather requirements.',
      exits: {
        ok: exit<GatherPayload>({ to: 'implement' }),
      },
      hooks: {
        preToolUse: [
          {
            matcher: '^Bash$',
            handler: () => ({
              hookSpecificOutput: {
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'No bash during requirements gathering.',
              },
            }),
          },
        ],
      },
    }),
    implement: state({
      entryPrompt: 'Implement.',
      exits: {
        ok: exit<ImplementPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
