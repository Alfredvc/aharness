/**
 * Tests for `daemon/onStateEntry.ts` — the entry-side nudge composer used
 * by non-dispatcher transition paths (await resolution and resume; see
 * design doc §5.7 / §5.10).
 *
 * The fixture is a three-state machine `a → b → fin` so we can exercise:
 *
 *   - state `a`: a single submit exit `go` with a sidecar entry whose
 *     `jsonSchema` should appear in the composed nudge text.
 *   - state `b`: a submit exit `stop` with a function-form entry prompt.
 *   - state `fin`: a terminal — `onStateEntry` must no-op (no exits, no
 *     entryPrompt) so the dispatcher's terminal-orientation path is
 *     not duplicated.
 *
 * The XState wrapper (`aharness.machine`) is the same one the rest of the
 * @aharness/core daemon tests use; it auto-stamps `meta.kind = 'stateful'` for
 * every `state(...)` annotation, which is the exact predicate
 * `onStateEntry` filters on.
 */
import { describe, expect, it, vi } from 'vitest';

import { aharness, state, terminal, exit } from '@aharness/core';
import type { SchemaSidecar } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import { onStateEntry } from '../src/runtime/onStateEntry.js';
import { createAharnessOps } from '../src/state/aharnessOps.js';

function buildMachine() {
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: () => ({ count: 0 }),
    states: {
      a: state({
        exits: { go: exit<{ inc: number }>({ to: 'b' }) },
        entryPrompt: 'in a',
      }),
      b: state({
        exits: {
          stop: exit<Record<string, never>>({ to: 'fin' }),
        },
        entryPrompt: ({ count }) => `in b, count=${String(count)}`,
      }),
      fin: terminal('success'),
    },
  });
}

const sidecar: SchemaSidecar = {
  a: {
    go: {
      jsonSchema: {
        type: 'object',
        required: ['inc'],
        properties: { inc: { type: 'number', description: 'increment' } },
      },
      validate: (input) => ({ ok: true, data: input }),
    },
  },
  b: {
    stop: {
      jsonSchema: { type: 'object' },
      validate: (input) => ({ ok: true, data: input }),
    },
  },
};

function makeHost() {
  const machine = buildMachine();
  const host = new ActorHost(machine, undefined);
  host.start();
  return host;
}

describe('onStateEntry', () => {
  it('composes a nudge for the current state with submit exit + schema', async () => {
    const host = makeHost();
    const inject = vi.fn(async () => undefined);
    await onStateEntry({ host, sidecar, injectNudge: inject });

    expect(inject).toHaveBeenCalledTimes(1);
    const text = inject.mock.calls[0]?.[0];
    expect(text).toContain('Now in state "a"');
    expect(text).toContain('"go"');
    // The composer pretty-prints the schema; the description string from
    // the sidecar entry should round-trip through the nudge text.
    expect(text).toContain('increment');
    // The string-form `entryPrompt` ("in a") must appear verbatim.
    expect(text).toContain('in a');
  });

  it('renders submit exits on the next state', async () => {
    const host = makeHost();
    // Drive a → b so b becomes the active leaf.
    host.commitSubmit('a', 'go', { inc: 1 });

    const inject = vi.fn(async () => undefined);
    await onStateEntry({ host, sidecar, injectNudge: inject });

    const text = inject.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('Now in state "b"');
    expect(text).toContain('"stop"');
    // The function-form `entryPrompt` was called against the live
    // context (no `assign` is wired on the transition, so count stays
    // at 0 — the assertion proves the function form ran rather than
    // testing the assign path, which lives in actorHost tests).
    expect(text).toContain('in b, count=0');
  });

  it('no-ops on a terminal leaf (no exits, no inject call)', async () => {
    const host = makeHost();
    host.commitSubmit('a', 'go', { inc: 0 });
    host.commitSubmit('b', 'stop', {});

    const inject = vi.fn(async () => undefined);
    await onStateEntry({ host, sidecar, injectNudge: inject });

    expect(inject).not.toHaveBeenCalled();
  });

  it('falls back to a minimal schema stub when the sidecar entry is missing', async () => {
    const host = makeHost();
    const inject = vi.fn(async () => undefined);
    // Empty sidecar: the verifier would normally catch this, but the
    // daemon must not crash if the sidecar is incomplete at runtime.
    await onStateEntry({ host, sidecar: {}, injectNudge: inject });

    const text = inject.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('Now in state "a"');
    expect(text).toContain('"go"');
    // Compact one-line schema rendering: no space between key/value.
    expect(text).toContain('"type":"object"');
  });

  it('surfaces entryPrompt evaluation errors in-band rather than throwing', async () => {
    const machine = aharness.machine({
      id: 'broken',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          exits: { go: exit<Record<string, never>>({ to: 'b' }) },
          entryPrompt: () => {
            throw new Error('author bug');
          },
        }),
        b: terminal('success'),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();

    const inject = vi.fn(async () => undefined);
    await onStateEntry({
      host,
      sidecar: {
        a: { go: { jsonSchema: { type: 'object' }, validate: (i) => ({ ok: true, data: i }) } },
      },
      injectNudge: inject,
    });

    const text = inject.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('error computing entryPrompt');
    expect(text).toContain('author bug');
  });

  // ─── FSM meta-ops: onEntry hook + firedFromResume gate ─────────────────

  function buildMachineWithOnEntryOnA(onEntry: () => void) {
    return aharness.machine({
      id: 'm-onentry',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          exits: { go: exit<Record<string, never>>({ to: 'b' }) },
          entryPrompt: 'in a',
          onEntry,
        }),
        b: terminal('success'),
      },
    });
  }

  it('invokes meta.onEntry when ops is supplied AND firedFromResume is false', async () => {
    const onEntry = vi.fn();
    const machine = buildMachineWithOnEntryOnA(onEntry);
    const host = new ActorHost(machine, undefined);
    host.start();
    const opsHandle = createAharnessOps();
    await onStateEntry({
      host,
      sidecar: {},
      injectNudge: vi.fn(async () => undefined),
      ops: opsHandle.ops,
      firedFromResume: false,
    });
    expect(onEntry).toHaveBeenCalledTimes(1);
  });

  it('skips meta.onEntry when firedFromResume is true', async () => {
    const onEntry = vi.fn();
    const machine = buildMachineWithOnEntryOnA(onEntry);
    const host = new ActorHost(machine, undefined);
    host.start();
    const opsHandle = createAharnessOps();
    await onStateEntry({
      host,
      sidecar: {},
      injectNudge: vi.fn(async () => undefined),
      ops: opsHandle.ops,
      firedFromResume: true,
    });
    expect(onEntry).not.toHaveBeenCalled();
  });

  it('skips meta.onEntry when ops is not supplied (legacy callers)', async () => {
    const onEntry = vi.fn();
    const machine = buildMachineWithOnEntryOnA(onEntry);
    const host = new ActorHost(machine, undefined);
    host.start();
    await onStateEntry({
      host,
      sidecar: {},
      injectNudge: vi.fn(async () => undefined),
    });
    expect(onEntry).not.toHaveBeenCalled();
  });

  it('errors thrown from meta.onEntry are surfaced via injectNudge but do not propagate', async () => {
    const calls: string[] = [];
    const inject = vi.fn(async (text: string) => {
      calls.push(text);
    });
    const machine = aharness.machine({
      id: 'm-throw',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          exits: { go: exit<Record<string, never>>({ to: 'b' }) },
          entryPrompt: 'in a',
          onEntry: () => {
            throw new Error('hook-bad');
          },
        }),
        b: terminal('success'),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const opsHandle = createAharnessOps();
    // Must not throw.
    await onStateEntry({
      host,
      sidecar: {},
      injectNudge: inject,
      ops: opsHandle.ops,
      firedFromResume: false,
    });
    // Two inject calls: the orientation nudge AND the error nudge.
    expect(calls.some((t) => t.includes("onEntry hook for state 'a' threw"))).toBe(true);
    expect(calls.some((t) => t.includes('hook-bad'))).toBe(true);
  });
});
