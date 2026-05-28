/**
 * Tests for `@aharness/core`'s verifier — Codex migration plan §13.
 *
 * Coverage strategy:
 *   - Carry over the CC verifier's check fixtures (one positive/negative per
 *     check) to confirm byte-for-byte parity (R4) for the unchanged checks.
 *   - Cover the deltas: removed `state-id-length`; renamed
 *     `submit-schemas-resolved` → `per-state-data-schema-resolvable`; added
 *     `state-exit-tuple-unique`; added scaffold checks
 *     `submit-tool-name-collision` and `request-user-input-name-collision`
 *     (R5 — empty-input passes today).
 *   - New verifier checks from Task 8: one test per check.
 *
 * Event names follow `SUBMIT__<stateId>__<exitName>` /
 * `AWAIT__<stateId>__<exitName>` per §10 of the design spec.
 *
 * Migration note: all state configs use the new helper shape directly.
 * `state({...})` returns `StateConfig` (i.e. `{ meta: { aharness: ... } }`),
 * so it is placed directly as the state node value — not inside a wrapper
 * `meta: { aharness: state({...}) }`. Similarly `terminal()` and `passive()`
 * are spread or placed directly. Tests that need to bypass `state()` runtime
 * validation to construct malformed shapes still use raw `meta: { aharness: {...} }`
 * literals.
 */
import type { JSONSchema7 } from 'json-schema';
import { describe, expect, it } from 'vitest';

import {
  createFsm as createFsmVerify,
  aharness,
  passive,
  state,
  terminal,
  exit,
  type SchemaSidecar,
} from '@aharness/core';

import { verify } from '../src/verify/index.js';

const stubValidate = (): { ok: true; data: undefined } => ({ ok: true as const, data: undefined });

/**
 * Build a sidecar entry under `[stateId][exitName]` for every (stateId, exitName)
 * tuple. Mirrors the helper in `packages/sdk/src/verify.test.ts` so fixtures port
 * verbatim.
 */
function sidecarWith(entries: ReadonlyArray<readonly [string, string]>): SchemaSidecar {
  const out: Record<
    string,
    Record<string, { jsonSchema: JSONSchema7; validate: typeof stubValidate }>
  > = {};
  for (const [stateId, exitName] of entries) {
    const slot = out[stateId] ?? {};
    slot[exitName] = { jsonSchema: { type: 'object' }, validate: stubValidate };
    out[stateId] = slot;
  }
  return out;
}

// ─── Happy path ─────────────────────────────────────────────────────────────

describe('@aharness/core verify (happy path)', () => {
  it('reports ok=true on a well-formed minimal machine', () => {
    const m = aharness.machine({
      id: 'h',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'do',
          exits: { ok: exit<{ v: number }>({ to: 'final' }) },
        }),
        final: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([['a', 'ok']]), []);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('@aharness/core verify: clearOnEntry initial-state rule', () => {
  it('rejects a root initial state that declares clearOnEntry', () => {
    const m = aharness.machine({
      id: 'clear-root',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'do',
          clearOnEntry: true,
          exits: { ok: exit<{ v: number }>({ to: 'final' }) },
        }),
        final: terminal('success'),
      },
    });

    const result = verify(m, sidecarWith([['a', 'ok']]), []);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'clearOnEntry-not-initial',
          stateId: 'a',
        }),
      ]),
    );
  });

  it('rejects nested and parallel initially active clearOnEntry states', () => {
    const m = aharness.machine({
      id: 'clear-nested',
      type: 'parallel',
      context: () => ({}),
      states: {
        left: {
          initial: 'a',
          states: {
            a: state({
              entryPrompt: 'left',
              clearOnEntry: true,
              exits: { ok: exit<{ v: number }>({ to: 'done' }) },
            }),
            done: terminal('success'),
          },
        },
        right: {
          initial: 'b',
          states: {
            b: state({
              entryPrompt: 'right',
              clearOnEntry: true,
              exits: { ok: exit<{ v: number }>({ to: 'done' }) },
            }),
            done: terminal('success'),
          },
        },
      },
    });

    const result = verify(
      m,
      sidecarWith([
        ['left.a', 'ok'],
        ['right.b', 'ok'],
      ]),
      [],
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'clearOnEntry-not-initial',
          stateId: 'left.a',
        }),
        expect.objectContaining({
          check: 'clearOnEntry-not-initial',
          stateId: 'right.b',
        }),
      ]),
    );
  });

  it('rejects a clearOnEntry state reached by initial eventless settling', () => {
    const m = aharness.machine({
      id: 'clear-always-start',
      initial: 'a',
      context: () => ({}),
      states: {
        a: { ...passive(), always: 'b' },
        b: state({
          entryPrompt: 'b',
          clearOnEntry: true,
          exits: { done: exit<{ ok: boolean }>({ to: 'final' }) },
        }),
        final: terminal('success'),
      },
    });

    const result = verify(m, sidecarWith([['b', 'done']]), []);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'clearOnEntry-not-initial',
          stateId: 'b',
        }),
      ]),
    );
  });

  it('allows a non-initial clearOnEntry state', () => {
    const m = aharness.machine({
      id: 'clear-later',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'a',
          exits: { next: exit<{ v: number }>({ to: 'b' }) },
        }),
        b: state({
          entryPrompt: 'b',
          clearOnEntry: true,
          exits: { done: exit<{ ok: boolean }>({ to: 'final' }) },
        }),
        final: terminal('success'),
      },
    });

    const result = verify(
      m,
      sidecarWith([
        ['a', 'next'],
        ['b', 'done'],
      ]),
      [],
    );

    expect(result.errors.map((issue) => issue.check)).not.toContain('clearOnEntry-not-initial');
  });
});

describe('@aharness/core verify: canonical events', () => {
  it('accepts a createFsm keyed event transition with no submit sidecar', () => {
    const base = createFsmVerify<{ count: number }>();
    const fsm = base.withEvents({
      ping: base.event<{ inc: number }>(),
    });
    const m = fsm.machine({
      data: () => ({ count: 0 }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            ping: {
              to: 'done',
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
            },
          },
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const result = verify(m, {});
    expect(result.errors).toEqual([]);
  });

  it('rejects malformed canonical event metadata constructed by bypassing createFsm()', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          meta: {
            aharness: {
              kind: 'stateful' as const,
              open: false,
              entryPrompt: 'a',
              exits: {},
              canonicalEvents: {
                SUBMIT__a__bad: {
                  kind: 'event' as const,
                  eventKind: 'custom' as const,
                  request: false,
                  branches: [{ return: () => 'bad', to: 'missing' }],
                },
              },
            },
          },
        },
        done: terminal('success'),
      },
    });
    const result = verify(m, {});
    expect(result.errors.map((e) => e.check)).toContain('canonical-event-well-formedness');
    expect(result.errors.map((e) => e.check)).toContain('canonical-event-target-in-state-set');
  });

  it('rejects canonical event metadata with missing lowering and invalid request/match/kind shape', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          meta: {
            aharness: {
              kind: 'stateful' as const,
              open: false,
              entryPrompt: 'a',
              exits: {},
              canonicalEvents: {
                approval: {
                  kind: 'event' as const,
                  eventKind: 'custom' as const,
                  request: true,
                  match: '[',
                  branches: [{}],
                },
                permissionRequest: {
                  kind: 'event' as const,
                  eventKind: 'custom' as const,
                  request: false,
                  branches: [{}],
                },
                weird: {
                  kind: 'event' as const,
                  eventKind: 'unsupported',
                  request: false,
                  branches: [{}],
                },
              },
            },
          },
        },
        done: terminal('success'),
      },
    });
    const result = verify(m, {});
    const messages = result.errors
      .filter((issue) => issue.check === 'canonical-event-well-formedness')
      .map((issue) => issue.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("canonical event 'approval' has no lowered xstate.on handler"),
        expect.stringContaining("request event 'approval' must declare defaultReturn"),
        expect.stringContaining("canonical event 'approval' does not support match"),
        expect.stringContaining("canonical event 'approval' match is not a valid regex"),
        expect.stringContaining(
          "custom canonical event 'permissionRequest' uses a reserved built-in hook event name",
        ),
        expect.stringContaining("canonical event 'weird' declares unsupported eventKind"),
      ]),
    );
  });

  it('rejects reserved custom event names at construction even when TypeScript is bypassed', () => {
    const base = createFsmVerify<{ count: number }>();
    expect(() =>
      base.withEvents({
        permissionRequest: base.event<{ ok: boolean }>(),
      } as never),
    ).toThrow(/reserved built-in hook event name/);
  });
});

// ─── Carried over: reachability ────────────────────────────────────────────

describe('@aharness/core verify: reachability', () => {
  it('flags an unreachable state', () => {
    const m = aharness.machine({
      id: 'r',
      initial: 'a',
      context: () => ({}),
      states: {
        a: { ...passive(), always: 'final' },
        orphan: { ...passive(), always: 'final' },
        final: terminal('success'),
      },
    });
    const result = verify(m, {});
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.check === 'reachability' && i.stateId === 'orphan')).toBe(
      true,
    );
  });
});

// ─── Carried over: terminal-reachability ───────────────────────────────────

describe('@aharness/core verify: terminal-reachability', () => {
  it('flags every state when machine declares no final', () => {
    const m = aharness.machine({
      id: 't2',
      initial: 'a',
      context: () => ({}),
      states: {
        a: { ...passive(), on: { GO: 'b' } },
        b: { ...passive(), on: { GO: 'a' } },
      },
    });
    const result = verify(m, {});
    expect(result.issues.some((i) => i.check === 'terminal-reachability')).toBe(true);
  });
});

// ─── Carried over: no-black-hole-non-terminals ─────────────────────────────

describe('@aharness/core verify: no-black-hole-non-terminals', () => {
  it('flags a non-final state with no outgoing trigger', () => {
    const m = aharness.machine({
      id: 'b',
      initial: 'stuck',
      context: () => ({}),
      states: {
        stuck: passive(),
      },
    });
    const result = verify(m, {});
    expect(result.issues.some((i) => i.check === 'no-black-hole-non-terminals')).toBe(true);
  });
});

// ─── Carried over: entryPrompt-paired ─────────────────────────────────

describe('@aharness/core verify: entryPrompt-paired', () => {
  it('flags a stateful state with empty entryPrompt', () => {
    const m = aharness.machine({
      id: 'p',
      initial: 'gated',
      context: () => ({}),
      states: {
        gated: {
          meta: {
            // Bypass `state()` runtime validation to construct the malformed case.
            aharness: {
              kind: 'stateful' as const,
              open: false,
              entryPrompt: '',
              exits: {
                ok: {
                  kind: 'submit' as const,
                  __aharnessPayloadMarker: true as const,
                  to: 'final',
                },
              },
            },
          },
          on: { SUBMIT__gated__ok: 'final' },
        },
        final: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([['gated', 'ok']]));
    expect(result.issues.some((i) => i.check === 'entryPrompt-paired')).toBe(true);
  });
});

// ─── Carried over: no-unresolved-references ────────────────────────────────

describe('@aharness/core verify: no-unresolved-references', () => {
  it('flags an action reference not declared in setup', () => {
    const m = aharness.machine({
      id: 'u',
      initial: 'a',
      context: () => ({}),
      states: {
        a: {
          ...passive(),
          entry: ['missingAction'],
          always: 'final',
        },
        final: terminal('success'),
      },
    });
    const result = verify(m, {});
    expect(
      result.issues.some(
        (i) => i.check === 'no-unresolved-references' && i.message.includes("'missingAction'"),
      ),
    ).toBe(true);
  });
});

// ─── Carried over: final-classification ────────────────────────────────────

describe('@aharness/core verify: final-classification', () => {
  it('flags a final state with no terminal classification', () => {
    const m = aharness.machine({
      id: 'f',
      initial: 'a',
      context: () => ({}),
      states: {
        a: { ...passive(), always: 'finalNoMeta' },
        finalNoMeta: { type: 'final' },
      },
    });
    const result = verify(m, {});
    expect(
      result.issues.some((i) => i.check === 'final-classification' && i.stateId === 'finalNoMeta'),
    ).toBe(true);
  });
});

// ─── Carried over: single-await-per-state ──────────────────────────────────

describe('@aharness/core verify: single-await-per-state', () => {
  it('flags multiple await exits on one state', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'x',
          exits: {
            w1: { kind: 'await', to: 'b' },
            w2: { kind: 'await', to: 'b' },
          },
        }),
        b: terminal('success'),
      },
    });
    const result = verify(m, {}, []);
    expect(result.issues.some((i) => i.check === 'single-await-per-state')).toBe(true);
  });
});

// ─── Carried over: exit-kind-well-formedness ───────────────────────────────

describe('@aharness/core verify: exit-kind-well-formedness', () => {
  it('flags a submit exit missing the exit<T>(...) wrapper', () => {
    const m = aharness.machine({
      id: 'k',
      initial: 'a',
      context: () => ({}),
      states: {
        a: {
          meta: {
            aharness: {
              kind: 'stateful' as const,
              open: false,
              entryPrompt: 'x',
              exits: {
                bad: { kind: 'submit' as const, to: 'b' } as never,
              },
            },
          },
          on: { SUBMIT__a__bad: { target: 'b' } },
        },
        b: terminal('success'),
      },
    });
    const result = verify(m, {}, []);
    expect(
      result.issues.some(
        (i) => i.check === 'exit-kind-well-formedness' && i.message.includes('exit<T>'),
      ),
    ).toBe(true);
  });
});

// ─── Carried over: open-states-have-at-least-one-exit ──────────────────────

describe('@aharness/core verify: open-states-have-at-least-one-exit', () => {
  it('flags an open state with no exits', () => {
    const m = aharness.machine({
      id: 'o',
      initial: 'discuss',
      context: () => ({}),
      states: {
        discuss: {
          meta: {
            aharness: {
              kind: 'stateful' as const,
              open: true,
              entryPrompt: 'chat',
              exits: {},
            },
          },
          // `always` here just so this state doesn't trip
          // no-black-hole-non-terminals; the focus is the empty exits map.
          always: 'final',
        },
        final: terminal('success'),
      },
    });
    const result = verify(m, {}, []);
    expect(
      result.issues.some(
        (i) => i.check === 'open-states-have-at-least-one-exit' && i.stateId === 'discuss',
      ),
    ).toBe(true);
  });
});

// ─── Carried over: await-only-strict-state (warning) ───────────────────────

describe('@aharness/core verify: await-only-strict-state', () => {
  it('warns (does not block) on a strict state with one await and no submit', () => {
    const m = aharness.machine({
      id: 'w',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'x',
          exits: { wait: { kind: 'await', to: 'b' } },
        }),
        b: terminal('success'),
      },
    });
    const result = verify(m, {}, []);
    const warning = result.issues.find((i) => i.check === 'await-only-strict-state');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
    expect(result.ok).toBe(true);
  });
});

// ─── Carried over: author-functions-sync ───────────────────────────────────

describe('@aharness/core verify: author-functions-sync', () => {
  it('re-emits loader `author-fn-async` issues', () => {
    const m = aharness.machine({
      id: 'af',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'x',
          exits: { ok: exit<Record<string, never>>({ to: 'b' }) },
        }),
        b: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([['a', 'ok']]), [
      {
        code: 'author-fn-async',
        stateId: 'a',
        exitName: null,
        line: 12,
        message: "entryPrompt on 'a' is async; must be sync",
      },
    ]);
    expect(
      result.issues.some((i) => i.check === 'author-functions-sync' && i.message.includes('async')),
    ).toBe(true);
  });
});

// ─── Carried over: machine-uses-aharness-wrapper ────────────────────────────

describe('@aharness/core verify: machine-uses-aharness-wrapper', () => {
  it('re-emits loader `direct-create-machine` issues', () => {
    const m = aharness.machine({
      id: 'mw',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'x',
          exits: { ok: exit<Record<string, never>>({ to: 'b' }) },
        }),
        b: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([['a', 'ok']]), [
      {
        code: 'direct-create-machine',
        stateId: null,
        exitName: null,
        line: 1,
        message:
          'createMachine() called directly on a config containing stateful states; use aharness.machine(...) instead',
      },
    ]);
    expect(
      result.issues.some(
        (i) =>
          i.check === 'machine-uses-aharness-wrapper' && i.message.includes('aharness.machine'),
      ),
    ).toBe(true);
  });
});

// ─── Delta: state-id-length is REMOVED on the codex side ───────────────────

describe('@aharness/core verify: state-id-length removed (§13.2)', () => {
  it('does not emit `state-id-length` issues even when stateId+exitName is huge', () => {
    // 35 + 8 = 43, which would have tripped the 41-char joint cap on CC.
    const longState = 'a'.repeat(35);
    const longExit = 'b'.repeat(8);
    const m = aharness.machine({
      id: 'len',
      initial: longState,
      context: () => ({}),
      states: {
        [longState]: state({
          entryPrompt: 'do',
          exits: {
            [longExit]: exit<Record<string, never>>({ to: 'final' }),
          },
        }),
        final: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([[longState, longExit]]));
    // No issue with the (now removed) check id; the verifier passes overall.
    expect(
      // oxlint-disable-next-line typescript/no-explicit-any
      result.issues.find((i) => (i.check as any) === 'state-id-length'),
    ).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

// ─── Delta: per-state-data-schema-resolvable (renamed from submit-schemas-resolved) ──

describe('@aharness/core verify: per-state-data-schema-resolvable (renamed from submit-schemas-resolved)', () => {
  it('flags a stateful state with no sidecar entry for its submit exit using the renamed check id', () => {
    const m = aharness.machine({
      id: 's',
      initial: 'gated',
      context: () => ({}),
      states: {
        gated: state({
          entryPrompt: 'do it',
          exits: {
            ok: exit<Record<string, never>>({ to: 'final' }),
          },
        }),
        final: terminal('success'),
      },
    });
    // Empty sidecar — `gated::ok` has no entry.
    const result = verify(m, {}, []);
    const match = result.issues.find(
      (i) => i.check === 'per-state-data-schema-resolvable' && i.stateId === 'gated',
    );
    expect(match).toBeDefined();
    expect(match?.message).toContain('ok');
    // The old name must NOT appear under any circumstance.
    expect(
      // oxlint-disable-next-line typescript/no-explicit-any
      result.issues.some((i) => (i.check as any) === 'submit-schemas-resolved'),
    ).toBe(false);
  });

  it('re-emits per-state loader issues under the renamed check id', () => {
    const m = aharness.machine({
      id: 's2',
      initial: 'gated',
      context: () => ({}),
      states: {
        gated: state({
          entryPrompt: 'do it',
          exits: {
            ok: exit<Record<string, never>>({ to: 'final' }),
          },
        }),
        final: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([['gated', 'ok']]), [
      {
        code: 'exit-payload-any',
        stateId: 'gated',
        exitName: 'ok',
        line: 42,
        message: "submit exit 'gated::ok' has untyped payload <any>",
      },
    ]);
    const match = result.issues.find(
      (i) => i.check === 'per-state-data-schema-resolvable' && i.stateId === 'gated',
    );
    expect(match?.message).toContain('untyped payload');
  });
});

// ─── Delta: state-exit-tuple-unique (new, functional) ──────────────────────

describe('@aharness/core verify: state-exit-tuple-unique (new in §13.3)', () => {
  it('passes a machine with distinct (stateId, exitName) tuples', () => {
    const m = aharness.machine({
      id: 'unique',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'do',
          exits: {
            ok: exit<Record<string, never>>({ to: 'b' }),
          },
        }),
        b: state({
          entryPrompt: 'do',
          exits: {
            ok: exit<Record<string, never>>({ to: 'final' }),
          },
        }),
        final: terminal('success'),
      },
    });
    const result = verify(
      m,
      sidecarWith([
        ['a', 'ok'],
        ['b', 'ok'],
      ]),
    );
    expect(result.issues.find((i) => i.check === 'state-exit-tuple-unique')).toBeUndefined();
  });

  it('does not falsely flag two siblings that share the same exit-name `ok`', () => {
    // Sibling states `a` and `b` each declare an exit named `ok`. Their
    // `(stateKeyPath, exitName)` tuples are `('a', 'ok')` and `('b', 'ok')` —
    // distinct, so the check stays silent. This pins the "no false positive"
    // direction.
    const sharedMeta = state({
      entryPrompt: 'do',
      exits: { ok: exit<Record<string, never>>({ to: 'final' }) },
    });
    const m = aharness.machine({
      id: 'siblings',
      initial: 'a',
      context: () => ({}),
      states: {
        a: sharedMeta,
        b: sharedMeta,
        final: terminal('success'),
      },
    });
    const result = verify(
      m,
      sidecarWith([
        ['a', 'ok'],
        ['b', 'ok'],
      ]),
    );
    expect(result.issues.find((i) => i.check === 'state-exit-tuple-unique')).toBeUndefined();
  });

  it('flags two distinct StateNodes that resolve to the same (stateKeyPath, exitName)', () => {
    // `state-exit-tuple-unique` is intended as defence-in-depth for the
    // compile-time-evaded case where two distinct `StateNode`s return the
    // same `stateKeyPath`. XState's public v5 API enforces unique state keys
    // at each level, so we cannot author this via `aharness.machine(...)`.
    // To exercise the predicate's emit path we build a synthetic machine
    // shape that satisfies the verifier's structural reads only — namely a
    // `root` plus two child nodes that both report `path: ['shared']`. This
    // is a deliberate stub that bypasses XState's invariants on a single
    // synthesized machine; the check's job is exactly to catch this case.
    const exitMeta = state({
      entryPrompt: 'do',
      exits: { go: exit<Record<string, never>>({ to: 'final' }) },
    });
    // Shared shape between the two colliding nodes.
    const buildNode = (
      nodeId: string,
    ): {
      readonly id: string;
      readonly type: 'atomic';
      readonly path: ReadonlyArray<string>;
      readonly parent: unknown;
      readonly states: Record<string, never>;
      readonly config: { readonly meta: { readonly aharness: typeof exitMeta.meta.aharness } };
    } => ({
      id: nodeId,
      type: 'atomic',
      path: ['shared'],
      // `parent: rootRef` is patched in below once `rootRef` exists.
      parent: undefined,
      states: {},
      config: { meta: { aharness: exitMeta.meta.aharness } },
    });
    const nodeA = buildNode('m.dup.a');
    const nodeB = buildNode('m.dup.b');
    const root = {
      id: 'm',
      type: 'compound' as const,
      path: [] as ReadonlyArray<string>,
      parent: undefined,
      // `iterStates` walks `node.states` keys; both children reach the
      // walker.
      states: { dupA: nodeA, dupB: nodeB } as Record<string, unknown>,
      config: {},
    };
    // Wire the parent back-reference via cast — `stateKeyPath` consults
    // `node.parent` to skip the root; needs a non-`undefined` parent.
    (nodeA as unknown as { parent: unknown }).parent = root;
    (nodeB as unknown as { parent: unknown }).parent = root;
    // The verifier reads `machine.root` and `machine.implementations`; supply
    // both. `iterStates` walks the tree from `machine.root`.
    const fakeMachine = {
      root,
      implementations: { guards: {}, actions: {}, actors: {} },
    } as unknown as Parameters<typeof verify>[0];
    // checkStateConfigMissingAharnessMeta does `node.machine.root` on every
    // iterated node including the root itself — wire `machine` on all nodes.
    (root as unknown as { machine: unknown }).machine = fakeMachine;
    (nodeA as unknown as { machine: unknown }).machine = fakeMachine;
    (nodeB as unknown as { machine: unknown }).machine = fakeMachine;
    const result = verify(fakeMachine, sidecarWith([['shared', 'go']]));
    const collision = result.issues.find((i) => i.check === 'state-exit-tuple-unique');
    expect(collision).toBeDefined();
    expect(collision?.stateId).toBe('shared');
    expect(collision?.message).toContain('shared::go');
  });
});

// ─── Delta: scaffold check for MCP-server tool-name collisions (R5) ────────

describe('@aharness/core verify: request-user-input-name-collision (scaffold; activates with future MCP surface)', () => {
  it('passes when the FSM declares no MCP-server tools (the only path today)', () => {
    const m = aharness.machine({
      id: 'sc2',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          entryPrompt: 'do',
          exits: {
            ok: exit<Record<string, never>>({ to: 'final' }),
          },
        }),
        final: terminal('success'),
      },
    });
    const result = verify(m, sidecarWith([['a', 'ok']]));
    expect(
      result.issues.find((i) => i.check === 'request-user-input-name-collision'),
    ).toBeUndefined();
  });
});

// ─── New verifier checks (Task 8) ──────────────────────────────────────────

describe('new verifier checks', () => {
  it('exit-target-in-state-set rejects unknown target', () => {
    // Verifier path: XState throws at createMachine() time when a transition
    // target is unknown, so we cannot use aharness.machine() to construct this
    // case. Instead, bypass aharness.machine() with a synthetic fake-machine
    // whose meta.aharness.exits reference a non-existent sibling. The check
    // reads exits from meta.aharness, not from the resolved transition map.
    const stateMeta = {
      kind: 'stateful' as const,
      open: false,
      entryPrompt: 'go',
      exits: {
        submit: {
          kind: 'submit' as const,
          __aharnessPayloadMarker: true as const,
          to: 'noSuchState',
        },
      },
    };
    const fakeNodeA = {
      id: 'm.a',
      type: 'atomic' as const,
      path: ['a'] as ReadonlyArray<string>,
      parent: undefined as unknown,
      states: {} as Record<string, never>,
      config: { meta: { aharness: stateMeta } },
    };
    const fakeNodeB = {
      id: 'm.b',
      type: 'final' as const,
      path: ['b'] as ReadonlyArray<string>,
      parent: undefined as unknown,
      states: {} as Record<string, never>,
      config: { meta: { aharness: { kind: 'terminal' as const, outcome: 'success' as const } } },
    };
    const fakeRoot = {
      id: 'm',
      type: 'compound' as const,
      path: [] as ReadonlyArray<string>,
      parent: undefined,
      states: { a: fakeNodeA, b: fakeNodeB } as Record<string, unknown>,
      config: {},
    };
    // Wire parent back-references.
    (fakeNodeA as unknown as { parent: unknown }).parent = fakeRoot;
    (fakeNodeB as unknown as { parent: unknown }).parent = fakeRoot;
    // Wire machine back-references needed by checkStateConfigMissingAharnessMeta,
    // which does `node.machine.root` on every iterated node including the root.
    const fakeMachine = {
      root: fakeRoot,
      implementations: { guards: {}, actions: {}, actors: {} },
    } as unknown as Parameters<typeof verify>[0];
    (fakeRoot as unknown as { machine: unknown }).machine = fakeMachine;
    (fakeNodeA as unknown as { machine: unknown }).machine = fakeMachine;
    (fakeNodeB as unknown as { machine: unknown }).machine = fakeMachine;
    // resolveSiblingTarget uses node.parent.states to look up the sibling key.
    // fakeNodeA's parent is fakeRoot whose states map has 'a' and 'b' but NOT
    // 'noSuchState', so the check will fire.
    const result = verify(fakeMachine, sidecarWith([['a', 'submit']]));
    expect(result.errors.some((e) => e.check === 'exit-target-in-state-set')).toBe(true);
  });

  it('when-last-unguarded rejects guarded last entry', () => {
    // Runtime path: state() throws at construction time.
    expect(() =>
      aharness.machine({
        id: 'm',
        initial: 'a',
        states: {
          a: state({
            entryPrompt: 'go',
            exits: {
              submit: exit<{ x: number }>({
                when: [
                  { guard: 'g1', to: 'b' },
                  { guard: 'g2', to: 'b' }, // last entry is guarded — should fail
                ],
              }),
            },
          }),
          b: terminal('success'),
        },
      }),
    ).toThrow(/when\[\] last entry must be unguarded/);
  });

  it('when-array-min-length-2 rejects single-element when[]', () => {
    // Runtime path test: state() throws on length-1 with the "use sugar form" message.
    expect(() =>
      aharness.machine({
        id: 'm',
        initial: 'a',
        states: {
          a: state({
            entryPrompt: 'go',
            exits: {
              submit: exit<{ x: number }>({
                // @ts-expect-error — single-branch when[] is the malformed shape under test
                when: [{ to: 'b' }],
              }),
            },
          }),
          b: terminal('success'),
        },
      }),
    ).toThrow(/has length 1.*use sugar form/);
  });

  it('when-array-min-length-2 rejects empty when[]', () => {
    // Runtime path test: state() throws on length-0 with the "is empty" message.
    expect(() =>
      aharness.machine({
        id: 'm',
        initial: 'a',
        states: {
          a: state({
            entryPrompt: 'go',
            exits: {
              submit: exit<{ x: number }>({
                // @ts-expect-error — empty when[] is the malformed shape under test
                when: [],
              }),
            },
          }),
          b: terminal('success'),
        },
      }),
    ).toThrow(/when\[\] is empty/);
  });

  it('exit-shape-exclusive rejects to+when on the same exit', () => {
    // Runtime path: state() throws at construction time.
    expect(() =>
      aharness.machine({
        id: 'm',
        initial: 'a',
        states: {
          a: state({
            entryPrompt: 'go',
            exits: {
              submit: exit<{ x: number }>({
                to: 'b',
                // @ts-expect-error — intentionally constructing the invalid shape
                when: [{ to: 'b' }, { to: 'b' }],
              }),
            },
          }),
          b: terminal('success'),
        },
      }),
    ).toThrow(/cannot have both 'to' .+ and 'when'/);
  });

  it('await-no-multi-branch rejects await + when[]', () => {
    // Runtime path: state() throws at construction time.
    expect(() =>
      aharness.machine({
        id: 'm',
        initial: 'a',
        states: {
          a: state({
            entryPrompt: 'wait',
            exits: {
              ownerReply: {
                kind: 'await',
                // @ts-expect-error — intentionally constructing the invalid shape
                when: [{ to: 'b' }, { to: 'b' }],
              },
            },
          }),
          b: terminal('success'),
        },
      }),
    ).toThrow(/await exit '.+' cannot use when\[\]/);
  });

  it('no-handwritten-submit-await-handlers rejects hand-written SUBMIT__ key', () => {
    // Author hand-writes `on: { SUBMIT__a__submit: ... }` alongside the
    // helper-derived state config. The synthesizer in Task 6 snapshots the
    // pre-existing key onto `meta.aharness.__aharness_authoredOnKeys` BEFORE
    // overwriting `node.on[SUBMIT__a__submit]`. The verifier reads the
    // side-channel and reports the check. No raw-config access needed.
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          ...state({
            entryPrompt: 'go',
            exits: { submit: exit<{ x: number }>({ to: 'b' }) },
          }),
          on: {
            SUBMIT__a__submit: { target: 'b' }, // hand-written — should be rejected
          },
        },
        b: terminal('success'),
      },
    });
    const result = verify(machine, sidecarWith([['a', 'submit']]));
    const error = result.errors.find((e) => e.check === 'no-handwritten-submit-await-handlers');
    expect(error).toBeDefined();
    // stateId must be the bare key path 'a', not the XState full id 'm.a'.
    // This pins the stateKeyPath format so future regressions are caught.
    expect(error?.stateId).toBe('a');
  });

  it('no-handwritten-submit-await-handlers fires for a passive() state with a hand-written SUBMIT__ key', () => {
    // I-4 regression: the side-channel snapshot was previously only populated
    // inside `if (isStateful(node))`, so passive/terminal states with hand-
    // written SUBMIT__/AWAIT__ keys were silently missed. After the fix the
    // snapshot runs on every state node, so this must be caught.
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          ...passive(),
          on: {
            SUBMIT__a__x: { target: 'b' }, // hand-written on a passive state — should be rejected
          },
          always: { target: 'b' },
        },
        b: terminal('success'),
      },
    });
    const result = verify(machine, {});
    const error = result.errors.find((e) => e.check === 'no-handwritten-submit-await-handlers');
    expect(error).toBeDefined();
    expect(error?.stateId).toBe('a');
  });

  it('state-config-missing-aharness-meta fires when literal meta overwrites the helper spread', () => {
    // The smoking gun: `{...passive(), entry: 'x', meta: {custom: 'oops'}}`
    // — the literal `meta:` REPLACES the spread's meta, so meta.aharness is GONE.
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          ...passive(),
          entry: 'render',
          meta: { custom: 'oops' }, // overwrites passive().meta — meta.aharness now missing
          always: { target: 'b' },
        },
        b: terminal('success'),
      },
    });
    const result = verify(machine, {});
    expect(result.errors.some((e) => e.check === 'state-config-missing-aharness-meta')).toBe(true);
  });

  it('awaits-owner-text-no-await-exit rejects mixing both', () => {
    // Runtime path: state() throws at construction time.
    expect(() =>
      aharness.machine({
        id: 'm',
        initial: 'a',
        states: {
          a: state({
            entryPrompt: 'wait',
            awaitsOwnerText: { messageToUser: 'q?' },
            exits: { ownerReply: { kind: 'await', to: 'b' } },
          }),
          b: terminal('success'),
        },
      }),
    ).toThrow(/cannot declare awaitsOwnerText together with await exit/);
  });

  it('no-handwritten-submit-await-handlers fires for a hand-written AWAIT__ key (locks in /^(SUBMIT|AWAIT)__/ predicate)', () => {
    // M-6: existing test only covered SUBMIT__. This locks in the AWAIT__ half
    // of the `/^(SUBMIT|AWAIT)__/` predicate so both are regression-tested.
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          ...state({
            entryPrompt: 'wait',
            exits: { ownerReply: { kind: 'await', to: 'b' } },
          }),
          on: {
            AWAIT__a__wait: { target: 'b' }, // hand-written AWAIT__ key — should be rejected
          },
        },
        b: terminal('success'),
      },
    });
    const result = verify(machine, {});
    const error = result.errors.find((e) => e.check === 'no-handwritten-submit-await-handlers');
    expect(error).toBeDefined();
    expect(error?.stateId).toBe('a');
  });

  it('bare-branch-warning fires for non-last bare branch but exempts last entry', () => {
    // Verifier path: the verifier emits a warning for non-last bare branches.
    // The last entry is the intentional unguarded fallback and is exempt.
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'go',
          exits: {
            submit: exit<{ x: number }>({
              when: [
                { to: 'b' }, // non-last bare → WARN
                { to: 'b' }, // last bare → EXEMPT (legitimate fallback)
              ],
            }),
          },
        }),
        b: terminal('success'),
      },
    });
    const result = verify(machine, sidecarWith([['a', 'submit']]));
    const warnings = result.warnings.filter((w) => w.check === 'bare-branch-warning');
    expect(warnings).toHaveLength(1);
  });

  it('state-onEntry-must-be-function fires when onEntry is non-callable', () => {
    // Hand-build the meta to bypass the helper's runtime guard.
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: {
          meta: {
            aharness: {
              kind: 'stateful',
              open: false,
              entryPrompt: 'go',
              exits: {
                submit: { kind: 'submit', __aharnessPayloadMarker: true, to: 'b' },
              },
              onEntry: 'not-a-function',
            },
          },
          on: { SUBMIT__a__submit: { target: 'b' } },
        },
        b: terminal('success'),
      },
    });
    const result = verify(machine, sidecarWith([['a', 'submit']]));
    const error = result.errors.find((e) => e.check === 'state-onEntry-must-be-function');
    expect(error).toBeDefined();
    expect(error?.stateId).toBe('a');
  });

  it('onEntry-only-on-stateful-states fires when terminal meta carries onEntry', () => {
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'go',
          exits: { submit: exit<{ x: number }>({ to: 'b' }) },
        }),
        b: {
          type: 'final',
          meta: {
            aharness: {
              kind: 'terminal',
              outcome: 'success',
              // Hand-attached `onEntry` on a terminal kind — silently
              // dead in the daemon; verifier should call it out.
              onEntry: () => {
                /* noop */
              },
            },
          },
        },
      },
    });
    const result = verify(machine, sidecarWith([['a', 'submit']]));
    const error = result.errors.find((e) => e.check === 'onEntry-only-on-stateful-states');
    expect(error).toBeDefined();
    expect(error?.stateId).toBe('b');
  });

  it('state() throws at construction time when onEntry is non-function', () => {
    expect(() =>
      state({
        entryPrompt: 'go',
        exits: { submit: exit<{ x: number }>({ to: 'b' }) },
        // @ts-expect-error — testing the runtime guard
        onEntry: 'oops',
      }),
    ).toThrow(/onEntry must be a function/);
  });

  it('state() preserves onEntry on the resolved meta when supplied as a function', () => {
    const fn = (_ctx: unknown): void => {
      /* noop */
    };
    const cfg = state({
      entryPrompt: 'go',
      exits: { submit: exit<{ x: number }>({ to: 'b' }) },
      onEntry: fn,
    });
    expect(cfg.meta.aharness.onEntry).toBe(fn);
  });
});

// ─── Phase 1 fixture sanity checks ─────────────────────────────────────────

describe('Phase 1 fixture sanity checks', () => {
  it('verifies the Phase 1 self-loop fixture cleanly', async () => {
    const m = (await import('./fixtures/multiStateSelfLoop.fsm.js')).default;
    const result = verify(
      m,
      sidecarWith([
        ['counting', 'increment'],
        ['counting', 'finish'],
      ]),
    );
    expect(result.errors).toEqual([]);
  });

  it('verifies the Phase 1 hello fixture cleanly', async () => {
    const m = (await import('./fixtures/hello.fsm.js')).default;
    const result = verify(m, sidecarWith([['greet', 'finish']]));
    expect(result.errors).toEqual([]);
  });
});
