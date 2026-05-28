/**
 * R22 — verify the FSM author primitives are reachable through the
 * @aharness/core barrel and a tiny FSM compiles and constructs against them.
 *
 * If this passes in phase 1, Task 36's "example FSM compiles unchanged
 * after switching the import to @aharness/core" gate is safe.
 */
import { describe, expect, it } from 'vitest';
import { assign, createActor } from 'xstate';
import { aharness, state, terminal, passive, exit, createFsm } from '../src/index.js';

describe('state() new shape', () => {
  it('returns a state config with meta.aharness populated', () => {
    const cfg = state({
      entryPrompt: 'do thing',
      exits: { submit: exit<{ x: number }>({ to: 'next' }) },
      clearOnEntry: true,
    });
    expect(cfg).toHaveProperty('meta.aharness.kind', 'stateful');
    expect(cfg).toHaveProperty('meta.aharness.exits.submit.kind', 'submit');
    expect(cfg).toHaveProperty('meta.aharness.exits.submit.to', 'next');
    expect(cfg).toHaveProperty('meta.aharness.clearOnEntry', true);
  });

  it('defaults kind:"submit" on exit declarations omitting kind', () => {
    const cfg = state({
      entryPrompt: 'do thing',
      exits: { submit: exit<{ x: number }>({ to: 'next' }) },
    });
    const exits = (cfg as { meta: { aharness: { exits: Record<string, { kind: string }> } } }).meta
      .aharness.exits;
    expect(exits['submit']?.kind).toBe('submit');
  });

  it('preserves explicit kind:"await"', () => {
    const cfg = state({
      entryPrompt: 'wait',
      exits: { ownerReply: { kind: 'await', to: 'process' } },
    });
    const exits = (cfg as { meta: { aharness: { exits: Record<string, { kind: string }> } } }).meta
      .aharness.exits;
    expect(exits['ownerReply']?.kind).toBe('await');
  });

  it('preserves multi-branch when[] shape', () => {
    const cfg = state({
      entryPrompt: 'pick',
      exits: {
        submit: exit<{ done: boolean }>({
          when: [
            { guard: 'isDone', to: 'finish' },
            { to: 'self', actions: 'append' },
          ],
        }),
      },
    });
    const submitExit = (
      cfg as { meta: { aharness: { exits: Record<string, { when?: unknown[] }> } } }
    ).meta.aharness.exits['submit'];
    expect(submitExit?.when).toHaveLength(2);
  });
});

interface DemoPayload {
  value: number;
}

interface DemoCtx {
  count: number;
}

describe('@aharness/core author primitives (R22)', () => {
  it('constructs a tiny FSM from aharness/state/terminal/passive/type', () => {
    const machine = aharness.machine({
      id: 'demo',
      initial: 'start',
      context: (): DemoCtx => ({ count: 0 }),
      states: {
        start: state({
          entryPrompt: 'Submit a value to advance.',
          exits: {
            submit: exit<DemoPayload>({ to: 'mid' }),
          },
        }),
        mid: {
          ...passive(),
          always: { target: 'fin' },
        },
        fin: terminal('success'),
      },
    });

    expect(machine).toBeDefined();
    expect(machine.id).toBe('demo');
  });
});

interface CanonicalDemoData {
  color: 'red' | 'green' | null;
  fruit: string | null;
  reply: string | null;
  cleared: boolean;
}

describe('createFsm() canonical authoring surface', () => {
  it('exports a typed factory with the Chunk 1 authoring helpers', () => {
    const fsm = createFsm<CanonicalDemoData>();

    expect(typeof fsm.machine).toBe('function');
    expect(typeof fsm.state).toBe('function');
    expect(typeof fsm.submit).toBe('function');
    expect(typeof fsm.await).toBe('function');
    expect(typeof fsm.final).toBe('function');
    expect(typeof fsm.passive).toBe('function');
    expect(typeof fsm.input.string).toBe('function');
    expect(typeof fsm.input.number).toBe('function');
    expect(typeof fsm.input.path).toBe('function');
    expect(typeof fsm.input.custom).toBe('function');
    expect(typeof fsm.input.values).toBe('function');
    expect(typeof fsm.skill).toBe('function');
    expect(typeof fsm.skill.path).toBe('function');
  });

  it('constructs the canonical Chunk 1 shapes without replacing primitive coverage', () => {
    const fsm = createFsm<CanonicalDemoData>();
    const clearOnEntry = fsm.state({
      prompt: (data) => `Pick fruit for ${data.color ?? 'unknown'}.`,
      ask: 'Pick red or green.',
      guidance: (data) => `Current fruit: ${data.fruit ?? 'none'}.`,
      clearOnEntry: true,
      skills: [
        fsm.skill('reviewer', { optional: true }),
        fsm.skill.path('./skills/reviewer.md', { optional: true }),
      ],
      on: {
        submit: fsm.submit<{ color: 'red' | 'green' }>({
          to: 'routeFruit',
          effect: async ({ data, payload }) => {
            expect(data.color).toBeNull();
            expect(payload.color).toMatch(/red|green/);
          },
          reduce: (draft, payload) => {
            draft.color = payload.color;
          },
        }),
      },
    });
    const routed = fsm.state({
      prompt: 'Route by accepted color.',
      on: {
        submit: fsm.submit<{ accepted: boolean; fruit: string }>({
          route: [
            {
              if: (_data, payload) => payload.accepted,
              to: 'waitForOwner',
              reduce: (draft, payload) => {
                draft.fruit = payload.fruit;
              },
            },
            {
              to: 'pickColor',
              reduce: (draft) => {
                draft.color = null;
                draft.fruit = null;
              },
            },
          ],
        }),
      },
    });
    const awaited = fsm.state({
      prompt: 'Ask owner for a checkpoint reply.',
      on: {
        proceed: fsm.await({
          ask: 'Proceed?',
          to: 'done',
          effect: async ({ ownerReply }) => {
            expect(ownerReply).toEqual(expect.any(String));
          },
          reduce: (draft, ownerReply) => {
            draft.reply = ownerReply;
          },
        }),
      },
    });
    const done = fsm.final({
      outcome: 'success',
      output: (data) => ({ fruit: data.fruit }),
      artifacts: {
        'result.md': (data) => `Fruit: ${data.fruit ?? 'none'}`,
      },
    });
    const passiveNode = fsm.passive({ always: { target: 'done' }, main: true });

    expect(clearOnEntry).toHaveProperty('meta.aharness.kind', 'stateful');
    expect(clearOnEntry).toHaveProperty('meta.aharness.clearOnEntry', true);
    expect(routed).toHaveProperty('meta.aharness.kind', 'stateful');
    expect(awaited).toHaveProperty('meta.aharness.kind', 'stateful');
    expect(done).toHaveProperty('meta.aharness.kind', 'terminal');
    expect(passiveNode).toHaveProperty('meta.aharness.kind', 'passive');
    expect(passiveNode).toHaveProperty('meta.aharness.main', true);
    expect(passiveNode).toHaveProperty('always', { target: 'done' });
  });

  it('validates canonical passive main metadata before lowering', () => {
    const fsm = createFsm<CanonicalDemoData>();

    expect(() => fsm.passive({ main: 'yes' })).toThrow(
      'passive(): main must be a boolean when provided',
    );
  });
});

describe('passive() new shape', () => {
  it('returns a spreadable state config with meta.aharness.kind="passive"', () => {
    const cfg = passive();
    expect(cfg).toEqual({ meta: { aharness: { kind: 'passive' } } });
  });

  it('lets author spread it alongside entry/always', () => {
    const author = { ...passive(), entry: 'render', always: { target: 'next' } };
    expect(author).toMatchObject({
      meta: { aharness: { kind: 'passive' } },
      entry: 'render',
      always: { target: 'next' },
    });
  });
});

describe('terminal() new shape', () => {
  it('returns a final state config with outcome', () => {
    const cfg = terminal('success');
    expect(cfg).toEqual({
      type: 'final',
      meta: { aharness: { kind: 'terminal', outcome: 'success' } },
    });
  });

  it('rejects outcomes outside the strict union at TS level (smoke)', () => {
    // Compile-time check only — runtime accepts strings; TS narrows the
    // signature to 'success' | 'failure'. Pick one to confirm runtime works.
    const cfg = terminal('failure');
    expect((cfg as { meta: { aharness: { outcome: string } } }).meta.aharness.outcome).toBe(
      'failure',
    );
  });
});

describe('injectFrameworkActions synthesis', () => {
  it('synthesizes SUBMIT__<state>__<exit> on: handler from sugar exits', () => {
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'go',
          exits: { submit: exit<{ x: number }>({ to: 'b' }) },
        }),
        b: { type: 'final', meta: { aharness: { kind: 'terminal', outcome: 'success' } } },
      },
    });
    const aNode = machine.getStateNodeById('m.a');
    const handler = aNode.config.on?.['SUBMIT__a__submit'];
    expect(handler).toBeDefined();
  });

  it('synthesizes one transition entry per when[] branch', () => {
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'go',
          exits: {
            submit: exit<{ done: boolean }>({
              when: [
                { guard: 'isDone', to: 'b' },
                { to: 'a', actions: 'append' },
              ],
            }),
          },
        }),
        b: { type: 'final', meta: { aharness: { kind: 'terminal', outcome: 'success' } } },
      },
    });
    const aNode = machine.getStateNodeById('m.a');
    const handler = aNode.config.on?.['SUBMIT__a__submit'];
    expect(Array.isArray(handler)).toBe(true);
    expect((handler as Array<unknown>).length).toBe(2);
  });

  it('emits reenter:false on self-loop branches', () => {
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'go',
          exits: {
            submit: exit<{ done: boolean }>({
              when: [
                { guard: 'isDone', to: 'b' },
                { to: 'a', actions: 'append' },
              ],
            }),
          },
        }),
        b: { type: 'final', meta: { aharness: { kind: 'terminal', outcome: 'success' } } },
      },
    });
    const aNode = machine.getStateNodeById('m.a');
    const handler = aNode.config.on?.['SUBMIT__a__submit'] as Array<{
      target?: string;
      reenter?: boolean;
    }>;
    const selfLoop = handler.find((h) => h.target === 'a');
    expect(selfLoop?.reenter).toBe(false);
  });
});

describe('self-loop visit-count semantics', () => {
  it('increments visit count exactly once per self-loop iteration', () => {
    // Note: `injectFrameworkActions` builds `stateId = path.join('.')` where
    // `path` excludes the machine id (the walker is invoked with `path: []`
    // and recurses into `machine.config.states`). For `id: 'm', states: { a }`
    // the visit-count key is `'a'`, NOT `'m.a'`. Guards are registered via
    // `.provide({guards})` against the machine returned by `aharness.machine()`
    // — verified that the wrapper produces a machine supporting `.provide()`
    // (XState v5 `AnyStateMachine` exposes `.provide()`).
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'loop',
          exits: {
            submit: exit<{ done: boolean }>({
              when: [
                { guard: 'isDone', to: 'b' },
                { to: 'a' }, // self-loop
              ],
            }),
          },
        }),
        b: { type: 'final', meta: { aharness: { kind: 'terminal', outcome: 'success' } } },
      },
    });
    const actor = createActor(
      machine.provide({
        guards: {
          isDone: ({ event }) => (event as { payload?: { done?: boolean } }).payload?.done === true,
        },
      }),
    );
    actor.start();
    // Initial entry: visit=1.
    expect(
      (actor.getSnapshot().context as { __aharness_visitCount: Record<string, number> })
        .__aharness_visitCount['a'],
    ).toBe(1);
    // Self-loop submit: visit=2.
    actor.send({ type: 'SUBMIT__a__submit', payload: { done: false } });
    expect(
      (actor.getSnapshot().context as { __aharness_visitCount: Record<string, number> })
        .__aharness_visitCount['a'],
    ).toBe(2);
    // Self-loop submit again: visit=3.
    actor.send({ type: 'SUBMIT__a__submit', payload: { done: false } });
    expect(
      (actor.getSnapshot().context as { __aharness_visitCount: Record<string, number> })
        .__aharness_visitCount['a'],
    ).toBe(3);
    // External submit: leaves a → b. a's visit count stays at 3.
    actor.send({ type: 'SUBMIT__a__submit', payload: { done: true } });
    expect(
      (actor.getSnapshot().context as { __aharness_visitCount: Record<string, number> })
        .__aharness_visitCount['a'],
    ).toBe(3);
    expect(actor.getSnapshot().value).toBe('b');
  });
});

describe('AWAIT self-loop branch action ordering', () => {
  it('buildBranch: AWAIT self-loop prepends ASSIGN_OWNER_REPLY and VISIT_ACTION (in that order), omits CLEAR_OWNER_REPLY', () => {
    // M-7: pins the exact action ordering for an AWAIT exit whose `to` matches
    // the current state (isSelfLoop=true). Expected synthesized actions:
    //   [{ type: ASSIGN_OWNER_REPLY }, { type: VISIT_ACTION, params: { stateId } }]
    // CLEAR_OWNER_REPLY must NOT appear (it's skipped for both AWAIT and self-loops).
    const machine = aharness.machine({
      id: 'm',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'wait for owner',
          exits: {
            ownerReply: { kind: 'await', to: 'a' }, // AWAIT self-loop
          },
        }),
        b: terminal('success'),
      },
    });
    const aNode = machine.getStateNodeById('m.a');
    const handler = aNode.config.on?.['AWAIT__a__ownerReply'] as Array<{
      target?: string;
      reenter?: boolean;
      actions?: Array<{ type: string; params?: unknown }>;
    }>;
    expect(Array.isArray(handler)).toBe(true);
    expect(handler).toHaveLength(1);
    const branch = handler[0];
    // Must be an internal self-loop.
    expect(branch?.reenter).toBe(false);
    expect(branch?.target).toBe('a');
    const actions = branch?.actions ?? [];
    // ASSIGN_OWNER_REPLY must be first.
    expect(actions[0]).toMatchObject({ type: '__aharnessAssignOwnerReply' });
    // VISIT_ACTION must be second (with stateId param).
    expect(actions[1]).toMatchObject({
      type: '__aharnessIncrementVisit',
      params: { stateId: 'a' },
    });
    // CLEAR_OWNER_REPLY must not appear at all.
    expect(actions.every((a) => a.type !== '__aharnessClearOwnerReply')).toBe(true);
    // No author actions beyond the two framework ones.
    expect(actions).toHaveLength(2);
  });
});

describe('state() hooks runtime guards', () => {
  const baseOpts = {
    entryPrompt: 'do the thing',
    exits: { go: exit<{ x: number }>({ to: 'next' }) },
  };

  it('accepts a well-formed preToolUse entry', () => {
    expect(() =>
      state({
        ...baseOpts,
        hooks: {
          preToolUse: [{ matcher: '^Bash$', handler: () => undefined }],
        },
      }),
    ).not.toThrow();
  });

  it('rejects a non-function handler', () => {
    expect(() =>
      state({
        ...baseOpts,
        hooks: {
          // oxlint-disable-next-line typescript/no-explicit-any
          preToolUse: [{ matcher: '^Bash$', handler: 'not a function' as any }],
        },
      }),
    ).toThrow(/handler must be a function/);
  });

  it('rejects an empty matcher on preToolUse', () => {
    expect(() =>
      state({
        ...baseOpts,
        hooks: {
          preToolUse: [{ matcher: '', handler: () => undefined }],
        },
      }),
    ).toThrow(/matcher must be a non-empty string/);
  });

  it('rejects a malformed regex matcher on preToolUse', () => {
    expect(() =>
      state({
        ...baseOpts,
        hooks: {
          preToolUse: [{ matcher: '[', handler: () => undefined }],
        },
      }),
    ).toThrow(/is not a valid regex/);
  });

  it('rejects a non-empty matcher on userPromptSubmit', () => {
    expect(() =>
      state({
        ...baseOpts,
        hooks: {
          // oxlint-disable-next-line typescript/no-explicit-any
          userPromptSubmit: [{ matcher: 'foo', handler: () => undefined } as any],
        },
      }),
    ).toThrow(/userPromptSubmit entries must not declare a matcher/);
  });

  it('rejects reserved kinds (sessionStart)', () => {
    expect(() =>
      state({
        ...baseOpts,
        hooks: {
          // oxlint-disable-next-line typescript/no-explicit-any
          sessionStart: [{ matcher: '.*', handler: () => undefined }] as any,
        },
      }),
    ).toThrow(/sessionStart is not yet supported/);
  });
});

describe('typed aharness.machine(...) + state<Ctx>(...) + exit<P>(...) author surface', () => {
  it('flows TContext + TPayload into inline assign / guard / entry callbacks', () => {
    interface TestCtx {
      count: number;
      lastGoal: string | null;
    }
    interface TestPayload {
      readonly goal: string;
      readonly bump: number;
    }

    const renderEntry = ({ context }: { context: TestCtx }) => {
      // Acts as the typed-entry-action regression guard. If `aharness.machine`
      // regresses to the loose AnyConfig shape — or the `context()` factory's
      // return type stops flowing into TContext — this const fails to assign
      // to `entry: renderEntry` below and the test file does not compile.
      void context.count;
    };

    // Compile-time assertions: if any of Tasks 1-4 regress, the assign /
    // guard / entry callbacks below fail to type-check and the file does
    // not compile. The runtime body confirms semantics are unchanged.
    const machine = aharness.machine({
      id: 'tm',
      initial: 'a',
      context: (): TestCtx => ({ count: 0, lastGoal: null }),
      states: {
        a: state<TestCtx>({
          entryPrompt: 'go',
          exits: {
            submit: exit<TestPayload>({
              when: [
                {
                  guard: ({ event }) => event.payload.bump > 0,
                  to: 'b',
                  actions: assign(({ context, event }) => ({
                    count: context.count + event.payload.bump,
                    lastGoal: event.payload.goal,
                  })),
                },
                { to: 'a' },
              ],
            }),
          },
        }),
        b: { ...terminal('success'), entry: renderEntry },
      },
    });

    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'SUBMIT__a__submit', payload: { goal: 'g', bump: 3 } });
    const ctx = actor.getSnapshot().context as TestCtx;
    expect(ctx.count).toBe(3);
    expect(ctx.lastGoal).toBe('g');
    expect(actor.getSnapshot().value).toBe('b');
  });
});
