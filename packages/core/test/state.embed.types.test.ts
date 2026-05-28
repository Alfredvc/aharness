import { describe, expectTypeOf, it } from 'vitest';
import { embed, harness, state, exit, final, arg, createFsm, type InputOf } from '../src/index.js';

describe('embed() — static type-check of input projection', () => {
  // Build a child once for all tests; type inference reads from `typeof child`.
  const child = harness.machine({
    input: {
      topic: arg<string>(),
      runs: arg<number>({ default: 3 }),
    },
    initial: 'go',
    states: {
      go: state({
        entryPrompt: 'go',
        exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
      }),
      done: final({ outcome: 'success' }),
    },
  });
  type ChildInput = InputOf<typeof child>;

  it('projection that returns ChildInput is accepted', () => {
    type GoodProjection = (parent: { context: { x: string } }) => ChildInput;
    expectTypeOf<GoodProjection>().toMatchTypeOf<
      (parent: { context: { x: string } }) => InputOf<typeof child>
    >();
  });

  it('projection missing a required field is rejected at the type level', () => {
    // `topic` is required (no default). A projection that returns only
    // `{runs: number}` must NOT be assignable to the projection slot.
    type BadProjection = (parent: { context: { x: string } }) => { runs: number };
    expectTypeOf<BadProjection>().not.toMatchTypeOf<
      (parent: { context: { x: string } }) => InputOf<typeof child>
    >();
  });

  it('projection with extra fields is accepted (TS structural compatibility)', () => {
    // The runtime verifier ignores extras; the type system also accepts them
    // structurally. Authors who want strict-extras rejection use `satisfies`.
    type ExtraProjection = (parent: { context: { x: string } }) => ChildInput & { extra: number };
    expectTypeOf<ExtraProjection>().toMatchTypeOf<
      (parent: { context: { x: string } }) => InputOf<typeof child>
    >();
  });

  it('embed() call with a correct projection compiles', () => {
    // Compile-time assertion: this expression must type-check.
    const compound = embed(child, {
      input: ({ context: _ }) => ({ topic: 'auth', runs: 5 }) as ChildInput,
      on: { done: { target: 'next' } },
    });
    expectTypeOf(compound.initial).toEqualTypeOf<string>();
  });

  it('embed() call with a projection missing a required field is rejected at the call site', () => {
    // The previous tests assert projection-type vs projection-type via
    // `expectTypeOf` — they pass even when `embed()`'s type parameters are
    // loosened (e.g. to `EmbedOptions<TParentCtx, Record<string, unknown>>`)
    // because they never invoke `embed()`. This test plugs that gap by
    // applying `@ts-expect-error` directly to an `embed()` call whose
    // projection returns `{runs: number}` — `topic` is required (no default)
    // so the projection is invalid against `InputOf<typeof child>` and the
    // `embed()` overload must reject it.
    //
    // To verify the signal is live, temporarily replace the projection with
    // a correct one (e.g. `() => ({ topic: 'a', runs: 5 })`): typecheck
    // should then FAIL because `@ts-expect-error` finds no error to
    // suppress. Restore to confirm clean.
    embed(child, {
      // @ts-expect-error — projection returns {runs: number} but child requires `topic` (no default)
      input: () => ({ runs: 5 }),
      on: { done: { target: 'next' } },
    });
  });
});

describe('createFsm().embed — canonical input projection contract', () => {
  interface ParentData {
    topic: string;
    runs: number;
  }
  interface ChildData {
    topic: string;
    runs: number;
  }

  const childFsm = createFsm<ChildData>();
  const child = childFsm.machine({
    input: {
      topic: childFsm.input.string(),
      runs: childFsm.input.number({ default: 1 }),
    },
    data: ({ input }) => ({ topic: input.topic, runs: input.runs }),
    initial: 'done',
    states: {
      done: childFsm.final({ outcome: 'success', output: (data) => ({ runs: data.runs }) }),
    },
  });

  it('accepts a HarnessMachine child and an input projection returning InputOf<typeof child>', () => {
    const parentFsm = createFsm<ParentData>();
    parentFsm.embed(child, {
      input: (data) => {
        expectTypeOf(data).toEqualTypeOf<Readonly<ParentData>>();
        return { topic: data.topic, runs: data.runs } satisfies InputOf<typeof child>;
      },
      on: {
        done: { to: 'next' },
      },
    });
  });

  it('rejects invalid canonical projection shapes at the call site', () => {
    const parentFsm = createFsm<ParentData>();

    if (false) {
      parentFsm.embed(child, {
        // @ts-expect-error `runs` is required by InputOf<typeof child>
        input: (data) => ({ topic: data.topic }),
        on: { done: { to: 'next' } },
      });

      parentFsm.embed(child, {
        // @ts-expect-error canonical embed input receives parent data directly, not primitive { context }
        input: ({ context }) => ({ topic: context.topic, runs: context.runs }),
        on: { done: { to: 'next' } },
      });
    }
  });

  it('rejects state-only fields on canonical embed hosts', () => {
    const parentFsm = createFsm<ParentData>();

    if (false) {
      parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic, runs: data.runs }),
        on: { done: { to: 'next' } },
        // @ts-expect-error embed hosts do not accept prompt
        prompt: 'not a normal state',
      });

      parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic, runs: data.runs }),
        on: { done: { to: 'next' } },
        // @ts-expect-error embed hosts do not accept ask
        ask: 'owner question',
      });

      parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic, runs: data.runs }),
        on: { done: { to: 'next' } },
        // @ts-expect-error embed hosts do not accept entry
        entry: () => undefined,
      });

      parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic, runs: data.runs }),
        on: { done: { to: 'next' } },
        // @ts-expect-error embed hosts do not accept skills
        skills: [],
      });

      parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic, runs: data.runs }),
        on: { done: { to: 'next' } },
        // @ts-expect-error embed hosts do not accept xstate escape-hatch config
        xstate: {},
      });
    }
  });
});
