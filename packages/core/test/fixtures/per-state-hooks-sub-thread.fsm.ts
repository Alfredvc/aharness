/**
 * Test fixture for `perStateHooks.e2e.test.ts` — spec §11 acceptance #5
 * (sub-thread tagging).
 *
 * Single stateful state with a `preToolUse` matcher. The handler encodes
 * the observed `isSubThread` / `subThreadId` event fields into the
 * `permissionDecisionReason` string so the test can read them back off
 * the wire reply without relying on a side-channel observation channel
 * (the FSM module is loaded once per daemon spin-up; closing over a
 * shared variable would race against parallel tests).
 *
 * Wire-reply shape:
 *   { hookSpecificOutput: {
 *       permissionDecision: 'deny',
 *       permissionDecisionReason: 'isSubThread=<bool>;subThreadId=<string|undefined>',
 *     }
 *   }
 */
import { exit, harness, state, terminal } from '@aharness/core';

interface OkPayload {
  readonly note: string;
}

export const machine = harness.machine({
  id: 'per-state-hooks-sub-thread-e2e',
  initial: 'observe',
  context: () => ({ __harness_visitCount: {} as Record<string, number> }),
  states: {
    observe: state({
      entryPrompt: 'Observe sub-thread tagging.',
      exits: {
        ok: exit<OkPayload>({ to: 'done' }),
      },
      hooks: {
        preToolUse: [
          {
            matcher: '^Bash$',
            handler: (_ctx, evt) => ({
              hookSpecificOutput: {
                permissionDecision: 'deny' as const,
                permissionDecisionReason:
                  `isSubThread=${String(evt.isSubThread)};` +
                  `subThreadId=${evt.subThreadId ?? 'undefined'}`,
              },
            }),
          },
        ],
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
