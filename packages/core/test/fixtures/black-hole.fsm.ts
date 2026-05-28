/**
 * Failing FSM fixture for the codex-side `aharness verify` CLI test.
 *
 * A passive state with no `always`/`after`/`invoke.onDone` and no
 * synthesized `on:` key — the actor would be stuck on entry with no way
 * to advance. This trips `no-black-hole-non-terminals` (error-severity),
 * so `verify` returns `ok: false` and the CLI exits 1.
 *
 * Passive states have no exits (the framework synthesises nothing for
 * them), so the only way to advance from a passive state is via
 * `always`/`after`/`invoke.onDone`. Without any of these the state is
 * a true black hole.
 */
import { aharness, passive, terminal } from '@aharness/core';

export const machine = aharness.machine({
  id: 'black-hole',
  initial: 'stuck',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    // Intentionally no `always` / `after` / `on` — passive black hole.
    stuck: passive(),
    done: terminal('success'),
  },
});

export default machine;
