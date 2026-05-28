/**
 * Type-level tests for `InputOf<TFsm>` and the `HarnessMachine<…>` typed
 * return of `harness.machine({...})` (Task 12a).
 *
 * `expectTypeOf` from vitest is a TS-compile-time assertion: it erases at
 * runtime, so failures only surface under `tsc`. This file ships under
 * the `packages/*\/test/**\/*.types.test.ts` glob added to
 * `tsconfig.lint.json` so `pnpm typecheck` (and therefore `pnpm verify`)
 * catches regressions in either resolution path of `InputOf<>`.
 */
import { describe, expectTypeOf, it } from 'vitest';
import {
  harness,
  state,
  exit,
  final,
  arg,
  createFsm,
  type ArgSentinel,
  type InputOf,
  type HarnessMachine,
  type PermissionRequestDecision,
  type PermissionRequestEvent,
  type ResolveInput,
  type HarnessOps,
} from '../src/index.js';

describe('InputOf<typeof child>', () => {
  it('resolves through the literal config-input path', () => {
    const child = harness.machine({
      input: {
        ideafilePath: arg<string>({ description: 'p' }),
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
    expectTypeOf<ChildInput>().toEqualTypeOf<{ ideafilePath: string; runs: number }>();
  });

  it('resolves through the __inputType phantom path on HarnessMachine<…>', () => {
    type AnnotatedChild = HarnessMachine<unknown, never, { topic: string }>;
    type ChildInput = InputOf<AnnotatedChild>;
    expectTypeOf<ChildInput>().toEqualTypeOf<{ topic: string }>();
  });

  it('returns `never` for non-FSM types', () => {
    type X = InputOf<{ unrelated: true }>;
    expectTypeOf<X>().toEqualTypeOf<never>();
  });
});

describe('harness.machine generic inference', () => {
  it('infers TInput from input: literal and TContext from context() return', () => {
    const m = harness.machine({
      id: 'pipeline',
      input: { topic: arg<string>({ description: 'Project topic' }) },
      context: ({ input }) => ({ topic: input.topic }),
      initial: 'router',
      states: {
        router: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' }),
      },
    });
    type MInput = InputOf<typeof m>;
    expectTypeOf<MInput>().toEqualTypeOf<{ topic: string }>();
  });

  it('ResolveInput<> maps each ArgSentinel<T> field to T', () => {
    type Decl = { a: ArgSentinel<number>; b: ArgSentinel<string> };
    expectTypeOf<ResolveInput<Decl>>().toEqualTypeOf<{ a: number; b: string }>();
  });
});

describe('createFsm() canonical type contract', () => {
  interface Data {
    topic: string;
    count: number;
    reply: string | null;
  }

  it('infers InputOf<typeof canonicalMachine> from fsm.input helpers', () => {
    const fsm = createFsm<Data>();
    const m = fsm.machine({
      input: {
        topic: fsm.input.string({ description: 'topic' }),
        rounds: fsm.input.number({ default: 1 }),
      },
      data: ({ input }) => ({ topic: input.topic, count: input.rounds, reply: null }),
      initial: 'done',
      states: {
        done: fsm.final({ outcome: 'success', output: (data) => ({ topic: data.topic }) }),
      },
    });
    type MInput = InputOf<typeof m>;
    expectTypeOf<MInput>().toEqualTypeOf<{ topic: string; rounds: number }>();
  });

  it('types canonical embed input projection against InputOf<typeof child>', () => {
    interface ChildData {
      topic: string;
      runs: number;
    }
    const childFsm = createFsm<ChildData>();
    const child = childFsm.machine({
      input: {
        topic: childFsm.input.string({ description: 'topic' }),
        runs: childFsm.input.number({ default: 1 }),
      },
      data: ({ input }) => ({ topic: input.topic, runs: input.runs }),
      initial: 'done',
      states: {
        done: childFsm.final({ outcome: 'success', output: (data) => ({ runs: data.runs }) }),
      },
    });
    type ChildInput = InputOf<typeof child>;
    expectTypeOf<ChildInput>().toEqualTypeOf<{ topic: string; runs: number }>();

    const parentFsm = createFsm<Data>();
    type ParentFsm = ReturnType<typeof createFsm<Data>>;
    type CanonicalEmbed = ParentFsm['embed'];

    parentFsm.embed(child, {
      input: (data) => {
        expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
        return { topic: data.topic, runs: data.count };
      },
      on: {
        done: {
          to: 'done',
          reduce: (draft, output) => {
            expectTypeOf(draft).toEqualTypeOf<Data>();
            expectTypeOf(output).toEqualTypeOf<{ runs: number }>();
            draft.count = output.runs;
          },
        },
      },
    });
  });

  it('rejects invalid canonical embed input projections and primitive projection shape', () => {
    interface ChildData {
      topic: string;
      runs: number;
    }
    const childFsm = createFsm<ChildData>();
    const child = childFsm.machine({
      input: {
        topic: childFsm.input.string(),
        runs: childFsm.input.number(),
      },
      data: ({ input }) => ({ topic: input.topic, runs: input.runs }),
      initial: 'done',
      states: {
        done: childFsm.final({ outcome: 'success' }),
      },
    });
    const parentFsm = createFsm<Data>();

    if (false) {
      parentFsm.embed(child, {
        // @ts-expect-error projection must satisfy InputOf<typeof child>
        input: (data) => ({ topic: data.topic }),
        on: { done: { to: 'done' } },
      });

      parentFsm.embed(child, {
        // @ts-expect-error canonical projection receives readonly parent data directly, not { context }
        input: ({ context }) => ({ topic: context.topic, runs: context.count }),
        on: { done: { to: 'done' } },
      });
    }
  });

  it('types submit and await reducer/effect callback shapes', () => {
    const fsm = createFsm<Data>();
    fsm.state({
      prompt: 'submit',
      entry: async (data, ops) => {
        expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
        expectTypeOf(ops).toEqualTypeOf<HarnessOps>();
      },
      on: {
        submit: fsm.submit<{ amount: number }>({
          to: 'awaiting',
          effect: async ({ data, payload, ops }) => {
            expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
            expectTypeOf(payload).toEqualTypeOf<{ amount: number }>();
            expectTypeOf(ops).toEqualTypeOf<HarnessOps>();
          },
          reduce: (draft, payload) => {
            expectTypeOf(draft).toEqualTypeOf<Data>();
            expectTypeOf(payload).toEqualTypeOf<{ amount: number }>();
            draft.count += payload.amount;
          },
        }),
      },
    });

    fsm.state({
      prompt: 'await',
      on: {
        proceed: fsm.await({
          ask: 'Proceed?',
          to: 'done',
          effect: async ({ data, ownerReply, ops }) => {
            expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
            expectTypeOf(ownerReply).toEqualTypeOf<string>();
            expectTypeOf(ops).toEqualTypeOf<HarnessOps>();
          },
          reduce: (draft, ownerReply) => {
            expectTypeOf(draft).toEqualTypeOf<Data>();
            expectTypeOf(ownerReply).toEqualTypeOf<string>();
            draft.reply = ownerReply;
          },
        }),
      },
    });
  });

  it('rejects invalid canonical transition shapes where the literal type is knowable', () => {
    const fsm = createFsm<Data>();

    if (false) {
      fsm.state({
        prompt: 'bad payload access',
        on: {
          submit: fsm.submit<{ amount: number }>({
            to: 'done',
            reduce: (_draft, payload) => {
              // @ts-expect-error reducer payload is the declared submit payload
              payload.missing;
            },
          }),
        },
      });

      fsm.state({
        prompt: 'bad route shape',
        on: {
          submit: fsm.submit<{ ready: boolean }>({
            // @ts-expect-error route requires at least two branches
            route: [{ to: 'done' }],
          }),
        },
      });

      fsm.state({
        prompt: 'bad route catchall',
        on: {
          submit: fsm.submit<{ ready: boolean }>({
            // @ts-expect-error final route branch is the catch-all and omits if
            route: [
              { if: (_data, payload) => payload.ready, to: 'done' },
              { if: () => false, to: 'retry' },
            ],
          }),
        },
      });

      fsm.state({
        prompt: 'bad unguarded non-last branch',
        on: {
          submit: fsm.submit<{ ready: boolean }>({
            // @ts-expect-error every non-last route branch declares if
            route: [{ to: 'retry' }, { to: 'done' }],
          }),
        },
      });

      fsm.state({
        prompt: 'bad missing branch target',
        on: {
          submit: fsm.submit<{ ready: boolean }>({
            // @ts-expect-error every route branch declares to
            route: [{ if: (_data, payload) => payload.ready }, { to: 'retry' }],
          }),
        },
      });

      fsm.state({
        prompt: 'bad mixed direct and routed submit',
        on: {
          submit: fsm.submit<{ ready: boolean }>({
            to: 'done',
            // @ts-expect-error submit declares exactly one of to or route
            route: [
              {
                if: (_data: Readonly<Data>, payload: { ready: boolean }) => payload.ready,
                to: 'done',
              },
              { to: 'retry' },
            ],
          }),
        },
      });

      // @ts-expect-error owner-yield ask and await exit are mutually exclusive
      fsm.state({
        prompt: 'bad await owner-yield mix',
        ask: 'Owner prompt',
        on: {
          proceed: fsm.await({ ask: 'Proceed?', to: 'done' }),
        },
      });

      // @ts-expect-error a state may declare at most one await exit
      fsm.state({
        prompt: 'bad multiple await exits',
        on: {
          first: fsm.await({ ask: 'First?', to: 'one' }),
          second: fsm.await({ ask: 'Second?', to: 'two' }),
        },
      });
    }
  });

  it('types keyed canonical event handlers from withEvents()', () => {
    const base = createFsm<Data>();
    const fsm = base.withEvents({
      testsFinished: base.event<{ passed: boolean; outputPath: string }>(),
      approval: base.event<{ command?: string }, 'acceptForSession' | 'delegate'>({
        defaultReturn: 'delegate',
      }),
    });

    fsm.state({
      prompt: 'events',
      on: {
        testsFinished: {
          route: [
            {
              if: (data, payload) => {
                expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
                expectTypeOf(payload).toEqualTypeOf<{
                  passed: boolean;
                  outputPath: string;
                }>();
                return payload.passed;
              },
              to: 'done',
            },
            { to: 'fixTests' },
          ],
        },
        approval: {
          reduce: (draft, payload) => {
            expectTypeOf(draft).toEqualTypeOf<Data>();
            expectTypeOf(payload).toEqualTypeOf<{ command?: string }>();
            draft.reply = payload.command ?? null;
          },
          return: (data, payload) => {
            expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
            expectTypeOf(payload).toEqualTypeOf<{ command?: string }>();
            return payload.command === 'pnpm test' ? 'acceptForSession' : 'delegate';
          },
        },
        submit: fsm.submit<{ amount: number }>({ to: 'done' }),
      },
    });
  });

  it('types reserved keyed built-in hook handlers', () => {
    const fsm = createFsm<Data>();

    fsm.state({
      prompt: 'hooks',
      on: {
        permissionRequest: {
          match: '^Bash$',
          reduce: (draft, payload) => {
            expectTypeOf(draft).toEqualTypeOf<Data>();
            expectTypeOf(payload).toEqualTypeOf<PermissionRequestEvent>();
            draft.reply = payload.command ?? null;
          },
          return: (data, payload) => {
            expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
            expectTypeOf(payload).toEqualTypeOf<PermissionRequestEvent>();
            return 'delegate' satisfies PermissionRequestDecision;
          },
        },
      },
    });
  });

  it('rejects keyed event typos and invalid event returns', () => {
    const base = createFsm<Data>();
    const fsm = base.withEvents({
      testsFinished: base.event<{ passed: boolean }>(),
      approval: base.event<{ command?: string }, 'accept' | 'delegate'>({
        defaultReturn: 'delegate',
      }),
    });

    if (false) {
      // @ts-expect-error custom events may not use reserved built-in hook names
      base.withEvents({ permissionRequest: base.event<{ ok: boolean }>() });

      // @ts-expect-error unknown on keys may not use plain event handler objects
      fsm.state({
        prompt: 'bad typo',
        on: {
          testFinished: { to: 'done' },
        },
      });

      fsm.state({
        prompt: 'bad signal return',
        on: {
          testsFinished: {
            to: 'done',
            // @ts-expect-error signal events cannot declare return
            return: () => 'delegate',
          },
        },
      });

      fsm.state({
        prompt: 'bad request return',
        on: {
          approval: {
            // @ts-expect-error request return must match the event output type
            return: () => 'cancel',
          },
        },
      });

      fsm.state({
        prompt: 'submit typo is allowed when branded',
        on: {
          retry: fsm.submit<{ reason: string }>({ to: 'done' }),
        },
      });
    }
  });
});
