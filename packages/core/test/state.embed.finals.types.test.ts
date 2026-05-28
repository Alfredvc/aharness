/**
 * Type-level tests for the embed-host typed `on:` mapped surface (Pain 5).
 *
 * The chain under test:
 *   1. `final<TOutput>()` returns `FinalConfig<TOutput>`, stamping the
 *      author-supplied output-callback return type into a phantom
 *      `__outputType` slot.
 *   2. `aharness.machine({states: TStates})` walks `TStates` via
 *      `ExtractFinals<TStates>` and surfaces the resulting `<finalId,
 *      TOutput>` record on `AharnessMachine<…, TFinals>.__finalsType`.
 *   3. `embed(child, opts)` reads that phantom via `FinalsOf<typeof child>`
 *      and types the `on:` map entries' `actions` / `guard` callbacks so
 *      `event.output` matches the child final's resolved `TOutput`.
 *
 * If `const TStates` widens past the literal config shape under the
 * `Omit<StateNodeConfig<…>, 'output' | 'states'>` wrapper, the entire chain
 * silently degrades and `event.output` falls back to `unknown` — the
 * `expectTypeOf` assertions below catch that regression.
 *
 * Ships under the `*.types.test.ts` glob in `tsconfig.lint.json` so
 * `pnpm typecheck` enforces the assertions on every CI run.
 */
import { assign } from 'xstate';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { embed, aharness, state, exit, final, createFsm, type AharnessOps } from '../src/index.js';

describe('embed() — typed event.output via FinalsOf<>', () => {
  // Build a child whose `shipped` final returns `{topic: string}`. This
  // is the load-bearing scenario: `event.output.topic` must type-check
  // without a cast in the parent's `actions:` callback.
  const child = aharness.machine({
    initial: 'compose',
    states: {
      compose: state({
        entryPrompt: 'go',
        exits: { decide: exit<{ accepted: boolean }>({ to: 'shipped' }) },
      }),
      shipped: final({
        outcome: 'success',
        output: () => ({ topic: 'hello' }),
      }),
      failed: final({ outcome: 'failure' }),
    },
  });

  it('CRITICAL PROBE: __finalsType phantom is populated through const TStates', () => {
    // Asserts the inference path the entire chain hangs on. If
    // `Omit<StateNodeConfig<…>, 'output' | 'states'>` widens the states
    // map past `const TStates`, this assertion fails before the embed-side
    // typing breaks downstream.
    type Finals = NonNullable<typeof child.__finalsType>;
    expectTypeOf<Finals['shipped']>().toEqualTypeOf<{ topic: string }>();
    expectTypeOf<Finals['failed']>().toEqualTypeOf<undefined>();
  });

  it('event.output is typed as the child final output() return shape', () => {
    interface ParentCtx extends Record<string, unknown> {
      readonly shippedTopic?: string;
    }
    embed<typeof child, ParentCtx>(child, {
      on: {
        shipped: {
          target: 'next',
          actions: assign({
            shippedTopic: ({ event }) => {
              // `event.output` resolves to `{topic: string}` — no cast.
              expectTypeOf(event.output).toEqualTypeOf<{ topic: string }>();
              return event.output.topic;
            },
          }),
        },
        failed: { target: 'next' },
      },
    });
  });

  it('wrong output shape in actions is rejected by tsc', () => {
    interface ParentCtx extends Record<string, unknown> {
      readonly bogus?: number;
    }
    embed<typeof child, ParentCtx>(child, {
      on: {
        shipped: {
          target: 'next',
          actions: assign({
            // `event.output.topic` is a string, so writing it to `bogus:
            // number` is a type error. The `@ts-expect-error` finds and
            // suppresses it; replacing the right-hand side with
            // `event.output.topic.length` (a number) makes typecheck
            // FAIL — confirming the directive is live.
            // @ts-expect-error — string return is not assignable to number slot
            bogus: ({ event }) => event.output.topic,
          }),
        },
        failed: { target: 'next' },
      },
    });
  });

  it('phantom carriers are never set at runtime', () => {
    // AharnessMachine.__inputType and __finalsType are declared as phantom
    // (type-level-only) fields on the AharnessMachine interface. The runtime
    // value of the compiled machine must never carry these properties —
    // they exist purely as TS-level carriers consumed by InputOf<> and
    // FinalsOf<> / embed(). A regression where the implementation
    // accidentally writes the fields would break serialization and violate
    // the spec comment ("never set at runtime").
    const m = aharness.machine({
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success', output: () => ({ topic: 'hello' }) }),
      },
    });

    const machine = m as unknown as Record<string, unknown>;
    expect(machine['__inputType']).toBeUndefined();
    expect(machine['__finalsType']).toBeUndefined();

    // __outputType lives on FinalConfig, not AharnessMachine. Verify that the
    // raw return value of final() — before it's processed by aharness.machine()
    // into an XState node — also never carries the phantom at runtime.
    const finalDef = final<{ topic: string }>({
      outcome: 'success',
      output: () => ({ topic: 'hello' }),
    }) as unknown as Record<string, unknown>;
    expect(finalDef['__outputType']).toBeUndefined();
  });
});

describe('createFsm().embed — canonical child-final output contract', () => {
  interface ParentData {
    shippedTopic: string | null;
    failureReason: string | null;
  }
  interface ChildData {
    topic: string;
  }

  const childFsm = createFsm<ChildData>();
  const child = childFsm.machine({
    input: {
      topic: childFsm.input.string(),
    },
    data: ({ input }) => ({ topic: input.topic }),
    initial: 'compose',
    states: {
      compose: childFsm.state({
        prompt: 'compose',
        on: {
          ship: childFsm.submit<{ ok: boolean }>({
            route: [{ if: (_data, payload) => payload.ok, to: 'shipped' }, { to: 'failed' }],
          }),
        },
      }),
      shipped: childFsm.final({
        outcome: 'success',
        output: (data) => ({ topic: data.topic, status: 'shipped' as const }),
      }),
      failed: childFsm.final({
        outcome: 'failure',
        output: () => ({ reason: 'rejected' as const }),
      }),
    },
  });

  it('requires an exact on map and types each handler output by final id', () => {
    const parentFsm = createFsm<ParentData>();
    parentFsm.embed(child, {
      input: () => ({ topic: 'auth' }),
      on: {
        shipped: {
          to: 'done',
          effect: async ({ data, output, ops }) => {
            expectTypeOf(data).toEqualTypeOf<Readonly<ParentData>>();
            expectTypeOf(output).toEqualTypeOf<{ topic: string; status: 'shipped' }>();
            expectTypeOf(ops).toEqualTypeOf<AharnessOps>();
          },
          reduce: (draft, output) => {
            expectTypeOf(draft).toEqualTypeOf<ParentData>();
            expectTypeOf(output).toEqualTypeOf<{ topic: string; status: 'shipped' }>();
            draft.shippedTopic = output.topic;
          },
        },
        failed: {
          to: 'failed',
          reduce: (draft, output) => {
            expectTypeOf(output).toEqualTypeOf<{ reason: 'rejected' }>();
            draft.failureReason = output.reason;
          },
        },
      },
    });
  });

  it('rejects missing final keys, extra final keys, and invalid output access', () => {
    const parentFsm = createFsm<ParentData>();

    if (false) {
      parentFsm.embed(child, {
        input: () => ({ topic: 'auth' }),
        // @ts-expect-error on map must include every child final id
        on: {
          shipped: { to: 'done' },
        },
      });

      parentFsm.embed(child, {
        input: () => ({ topic: 'auth' }),
        on: {
          shipped: { to: 'done' },
          failed: { to: 'failed' },
          // @ts-expect-error on map may not include keys outside the child final ids
          unknownFinal: { to: 'failed' },
        },
      });

      parentFsm.embed(child, {
        input: () => ({ topic: 'auth' }),
        on: {
          shipped: {
            to: 'done',
            reduce: (_draft, output) => {
              // @ts-expect-error shipped output has no `reason`
              output.reason;
            },
          },
          failed: {
            to: 'failed',
            effect: ({ output }) => {
              // @ts-expect-error failed output has no `topic`
              output.topic;
            },
          },
        },
      });
    }
  });
});
