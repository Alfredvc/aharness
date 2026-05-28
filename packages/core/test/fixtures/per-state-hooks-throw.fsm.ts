/**
 * Test fixture for `perStateHooks.e2e.test.ts` — spec §11 acceptance #8
 * (daemon crashes on author handler throw + events.jsonl entry).
 *
 * Single stateful state whose `preToolUse` handler throws synchronously.
 * The dispatcher wraps the throw, fires the `onAuthorHandlerError`
 * callback (which writes a structured `authorHookHandlerError` line to
 * `events.jsonl`), and re-throws — the framing layer then converts the
 * rejection into an `ERROR` reply on the wire.
 *
 * The actual daemon-exit-1 path (spec §8) is exercised by the running
 * `aharness` CLI, not by `runDaemonForTest`; the wire-path assertion here
 * verifies the load-bearing pre-conditions: ERROR reply on the wire and
 * a structured event line in `events.jsonl`. Confirming the §5.6
 * shutdown ordering after the exit is out of scope for this rig.
 */
import { exit, aharness, state, terminal } from '@aharness/core';

interface OkPayload {
  readonly note: string;
}

export const machine = aharness.machine({
  id: 'per-state-hooks-throw-e2e',
  initial: 'risky',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    risky: state({
      entryPrompt: 'Risky.',
      exits: {
        ok: exit<OkPayload>({ to: 'done' }),
      },
      hooks: {
        preToolUse: [
          {
            matcher: '^Bash$',
            handler: () => {
              throw new Error('author bug');
            },
          },
        ],
      },
    }),
    done: terminal('success'),
  },
});

export default machine;
