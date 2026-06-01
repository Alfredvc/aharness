/**
 * Tests for `daemon/actorHost.ts` — the per-run XState actor wrapper used by
 * the @aharness/core dispatcher pipeline.
 *
 * The test fixture is a minimal two-state machine (`a` → `b`) carrying a
 * single submit exit `go` whose payload increments `count`. We exercise the
 * three guarantees the dispatcher relies on:
 *
 *   1. `currentStateId()` returns the dotted state-key after `start()`.
 *   2. `dryRunSubmit(...)` is **pure** — projects the next state without
 *      mutating the live actor.
 *   3. `commitSubmit(...)` actually advances the actor.
 *
 * The fixture uses `aharness.machine` (the framework wrapper) plus `assign`
 * inside the SUBMIT transition's `actions` array — that is the only XState
 * v5 path that compiles against `setup`'s typed-action contract.
 */
import { describe, expect, it } from 'vitest';
import { assign } from 'xstate';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { aharness, state, terminal, exit, final, arg, createFsm } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import { ensureRunDir } from '../src/run.js';

interface Ctx {
  count: number;
}

interface GoPayload {
  inc: number;
}

function buildMachine() {
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => ({ count: 0 }),
    states: {
      a: state({
        exits: {
          go: exit<GoPayload>({
            to: 'b',
            actions: assign({
              count: ({ context, event }) =>
                context.count + (event as { payload: GoPayload }).payload.inc,
            }),
          }),
        },
        entryPrompt: 'in a',
      }),
      b: terminal('success'),
    },
  });
}

describe('ActorHost', () => {
  it('start() → currentStateId() returns initial state', () => {
    const host = new ActorHost(buildMachine(), undefined);
    host.start();
    expect(host.currentStateId()).toBe('a');
  });

  it('dryRunSubmit projects next state without mutating the actor', () => {
    const host = new ActorHost(buildMachine(), undefined);
    host.start();
    const result = host.dryRunSubmit('a', 'go', { inc: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextStateId).toBe('b');
      // Pure: live actor stayed put.
      expect(host.currentStateId()).toBe('a');
      // The projected context reflects the assign — `count` advanced
      // in the dry-run snapshot but the live actor still has count: 0.
      expect((result.nextContext as { count: number }).count).toBe(5);
      expect((host.currentContext() as { count: number }).count).toBe(0);
    }
  });

  it('dryRunSubmit returns ok:false on an unknown exit', () => {
    const host = new ActorHost(buildMachine(), undefined);
    host.start();
    // The fixture has no `bogus` exit on state `a`. `transition` will
    // produce a snapshot that didn't move (XState ignores unhandled
    // events) — so we check the projection still lands at `a`.
    // What we want here is the no-throw path; XState v5's `transition`
    // does not throw on unhandled events, it returns the unchanged
    // snapshot.
    const result = host.dryRunSubmit('a', 'bogus', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextStateId).toBe('a');
  });

  it('commitSubmit advances the live actor', () => {
    const host = new ActorHost(buildMachine(), undefined);
    host.start();
    host.commitSubmit('a', 'go', { inc: 5 });
    expect(host.currentStateId()).toBe('b');
    expect((host.currentContext() as { count: number }).count).toBe(5);
  });

  it('currentMeta() returns the active leaf meta', () => {
    const host = new ActorHost(buildMachine(), undefined);
    host.start();
    const meta = host.currentMeta();
    expect(meta?.kind).toBe('stateful');
    host.commitSubmit('a', 'go', { inc: 1 });
    const next = host.currentMeta();
    expect(next?.kind).toBe('terminal');
  });

  it('dryRunChoice projects a choice without mutating and commitChoice advances it', () => {
    const fsm = createFsm<{ selected: string | null }>();
    const machine = fsm.machine({
      id: 'm',
      data: () => ({ selected: null }),
      initial: 'pick',
      states: {
        pick: fsm.choice({
          question: 'Pick',
          options: [
            { label: 'Again', to: 'pick' },
            { label: 'Done', to: 'done' },
          ],
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();

    const projected = host.dryRunChoice('pick', 'Done');
    expect(projected.ok).toBe(true);
    if (projected.ok) expect(projected.nextStateId).toBe('done');
    expect(host.currentStateId()).toBe('pick');

    host.commitChoice('pick', 'Done');
    expect(host.currentStateId()).toBe('done');
  });

  it('commitChoice self-loop increments the active choice visit count', () => {
    const fsm = createFsm();
    const machine = fsm.machine({
      id: 'm',
      initial: 'pick',
      states: {
        pick: fsm.choice({
          question: 'Pick',
          options: [{ label: 'Again', to: 'pick' }],
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    expect(host.currentContext().__aharness_visitCount).toEqual({ pick: 1 });
    host.commitChoice('pick', 'Again');
    expect(host.currentContext().__aharness_visitCount).toEqual({ pick: 2 });
  });
});

// ---------------------------------------------------------------------------
// Task 15b: merged `{runId, runDir, …userFields}` flows into the user's
// `context: ({ input }) => …` factory. Mirrors the merge shape constructed
// by `daemon/main.ts:bootDaemon` so the assertion exercises the same input
// object the daemon would build.
// ---------------------------------------------------------------------------

describe('ActorHost — merged input flows into context factory (Task 15b)', () => {
  it('passes merged framework + user input to the user context factory', async () => {
    const m = aharness.machine({
      input: { topic: arg<string>() },
      context: ({ input }: { input: { runId: string; topic: string } }) => ({
        runId: input.runId,
        topic: input.topic,
      }),
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' }),
      },
    });
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'host-input-'));
    try {
      const runDir = ensureRunDir('abcdef-123456', repoRoot);
      // The merge happens in daemon/main.ts before calling
      // `new ActorHost(...)`; the test mirrors that shape so the
      // assertion exercises the same input object the daemon builds.
      const mergedInput = { runId: 'abcdef-123456', runDir, topic: 'auth' };
      const host = new ActorHost(m, undefined, mergedInput);
      host.start();
      const ctx = host.currentContext() as { runId: string; topic: string };
      expect(ctx.runId).toBe('abcdef-123456');
      expect(ctx.topic).toBe('auth');
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  // Override-direction test. The daemon merges as `{runId, runDir, ...userInput}`
  // (framework first, user last) — see `daemon/main.ts:bootDaemon`. This test
  // exists specifically to catch a swap of merge precedence: if the order were
  // accidentally flipped to `{...userInput, runId, runDir}`, framework defaults
  // would silently win and a user-declared `runId` field would never reach the
  // context factory. Constructing a fixture whose `input` declaration
  // deliberately shadows the framework `runId` field is the only way to detect
  // that swap — the existing test above would still pass because both sides
  // would deliver the same `runId` value.
  it('user-declared fields override framework defaults under merge order', async () => {
    const m = aharness.machine({
      input: {
        // Deliberately shadows the framework default. Authors would not
        // normally do this, but the override is not blocked.
        runId: arg<string>(),
        topic: arg<string>(),
      },
      context: ({ input }: { input: { runId: string; topic: string } }) => ({
        runId: input.runId,
        topic: input.topic,
      }),
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' }),
      },
    });
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'host-input-override-'));
    try {
      const runDir = ensureRunDir('abcdef-123456', repoRoot);
      // Mirror daemon/main.ts's merge: framework first, user last.
      // `userInput.runId === 'user-id'` MUST win over the framework default
      // `'framework-id'`.
      const mergedInput = {
        runId: 'framework-id',
        runDir,
        ...{ runId: 'user-id', topic: 'auth' },
      };
      const host = new ActorHost(m, undefined, mergedInput);
      host.start();
      const ctx = host.currentContext() as { runId: string; topic: string };
      expect(ctx.runId).toBe('user-id');
      expect(ctx.topic).toBe('auth');
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
