import { describe, expect, it } from 'vitest';
import { assign, createActor } from 'xstate';
import { harness, state, exit, final, arg, createFsm } from '../src/index.js';

describe('harness.machine({input})', () => {
  it('preserves the input declaration on the compiled machine config', () => {
    const m = harness.machine({
      input: {
        ideafilePath: arg<string>({ description: 'path' }),
        topic: arg<string>(),
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
    const inputDecl = (m.config as { input?: Record<string, unknown> }).input;
    expect(inputDecl).toBeDefined();
    expect(Object.keys(inputDecl as Record<string, unknown>).sort()).toEqual([
      'ideafilePath',
      'topic',
    ]);
  });

  it('preserves the input declaration on the __harnessRawConfig snapshot', () => {
    const m = harness.machine({
      input: { topic: arg<string>() },
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' }),
      },
    });
    const snap = (m as { __harnessRawConfig?: { input?: Record<string, unknown> } })
      .__harnessRawConfig;
    expect(snap?.input).toBeDefined();
    expect(Object.keys(snap!.input as Record<string, unknown>)).toEqual(['topic']);
  });

  it('passes input through to context via XState createActor', () => {
    const m = harness.machine({
      input: { topic: arg<string>() },
      context: ({ input }: { input: { topic?: string } }) => ({ topic: input.topic ?? '' }),
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' }),
      },
    });
    const actor = createActor(m, { input: { topic: 'auth' } });
    actor.start();
    expect((actor.getSnapshot().context as { topic: string }).topic).toBe('auth');
  });
});

describe('createFsm().machine({ input, data })', () => {
  it('preserves canonical input helpers and passes resolved input into data()', () => {
    const fsm = createFsm<{ topic: string; rounds: number }>();
    const m = fsm.machine({
      input: {
        topic: fsm.input.string({ description: 'topic' }),
        rounds: fsm.input.number({ default: 2 }),
      },
      data: ({ input }) => ({ topic: input.topic, rounds: input.rounds }),
      initial: 'done',
      states: {
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const actor = createActor(m, { input: { topic: 'auth', rounds: 4 } });
    actor.start();
    expect(actor.getSnapshot().context).toMatchObject({ topic: 'auth', rounds: 4 });
  });

  it('stores canonical embed input projection from readonly parent data', () => {
    const childFsm = createFsm<{ topic: string; rounds: number }>();
    const child = childFsm.machine({
      input: {
        topic: childFsm.input.string(),
        rounds: childFsm.input.number(),
      },
      data: ({ input }) => ({ topic: input.topic, rounds: input.rounds }),
      initial: 'done',
      states: {
        done: childFsm.final({ outcome: 'success' }),
      },
    });
    const parentFsm = createFsm<{ topic: string; count: number }>();
    const embedded = parentFsm.embed(child, {
      input: (data) => ({ topic: data.topic, rounds: data.count }),
      on: {
        done: { to: 'done' },
      },
    });
    const input = (
      embedded as {
        meta: {
          harness: {
            embedded: {
              input?: (args: { readonly context: { topic: string; count: number } }) => unknown;
            };
          };
        };
      }
    ).meta.harness.embedded.input;

    expect(input?.({ context: { topic: 'auth', count: 4 } })).toEqual({
      topic: 'auth',
      rounds: 4,
    });
  });

  it('merges canonical state xstate.meta without overwriting harness metadata', () => {
    const fsm = createFsm<{ count: number }>();
    const node = fsm.state({
      prompt: 'count',
      xstate: {
        meta: {
          author: { label: 'Count state' },
          harness: { authorSupplied: true },
        },
        tags: ['visible'],
      },
      on: {
        submit: fsm.submit<{ count: number }>({
          to: 'done',
          reduce: (draft, payload) => {
            draft.count = payload.count;
          },
        }),
      },
    }) as {
      readonly meta: {
        readonly author?: { readonly label?: string };
        readonly harness?: { readonly kind?: string; readonly authorSupplied?: boolean };
      };
      readonly tags?: ReadonlyArray<string>;
    };

    expect(node.tags).toEqual(['visible']);
    expect(node.meta.author).toEqual({ label: 'Count state' });
    expect(node.meta.harness?.kind).toBe('stateful');
    expect(node.meta.harness?.authorSupplied).toBeUndefined();
  });

  it('runs low-level direct submit actions before canonical reducers', () => {
    const fsm = createFsm<{ count: number; marks: string[] }>();
    const m = fsm.machine({
      data: () => ({ count: 1, marks: [] }),
      initial: 'start',
      states: {
        start: fsm.state({
          prompt: 'increment',
          on: {
            submit: fsm.submit<{ multiplier: number }>({
              to: 'done',
              actions: assign(({ context }) => ({
                count: context.count + 10,
                marks: [...context.marks, `action:${context.count}`],
              })),
              reduce: (draft, payload) => {
                draft.marks.push(`reduce:${draft.count}`);
                draft.count *= payload.multiplier;
              },
            }),
          },
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const actor = createActor(m);
    actor.start();

    actor.send({ type: 'SUBMIT__start__submit', payload: { multiplier: 2 } });

    expect(actor.getSnapshot().context).toMatchObject({
      count: 22,
      marks: ['action:1', 'reduce:11'],
    });
  });

  it('preserves low-level routed submit branch actions before canonical reducers', () => {
    const fsm = createFsm<{ count: number; marks: string[] }>();
    const m = fsm.machine({
      data: () => ({ count: 1, marks: [] }),
      initial: 'start',
      states: {
        start: fsm.state({
          prompt: 'route',
          on: {
            submit: fsm.submit<{ accepted: boolean; multiplier: number }>({
              route: [
                {
                  if: (_data, payload) => payload.accepted,
                  to: 'done',
                  actions: assign(({ context }) => ({
                    count: context.count + 10,
                    marks: [...context.marks, `action:${context.count}`],
                  })),
                  reduce: (draft, payload) => {
                    draft.marks.push(`reduce:${draft.count}`);
                    draft.count *= payload.multiplier;
                  },
                },
                { to: 'retry' },
              ],
            }),
          },
        }),
        retry: fsm.final({ outcome: 'failure' }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const actor = createActor(m);
    actor.start();

    actor.send({
      type: 'SUBMIT__start__submit',
      payload: { accepted: true, multiplier: 2 },
    });

    expect(actor.getSnapshot().value).toBe('done');
    expect(actor.getSnapshot().context).toMatchObject({
      count: 22,
      marks: ['action:1', 'reduce:11'],
    });
  });

  it('runs canonical submit effects before reducers and rolls back rejected effects', async () => {
    const fsm = createFsm<{ count: number; log: string[]; nested: { marks: string[] } }>();
    const events: string[] = [];
    const m = fsm.machine({
      data: () => ({ count: 0, log: [], nested: { marks: [] } }),
      initial: 'start',
      states: {
        start: fsm.state({
          prompt: 'increment',
          on: {
            submit: fsm.submit<{ amount: number; fail?: boolean }>({
              to: 'done',
              effect: async ({ data, payload }) => {
                events.push(`effect:${data.count}:${payload.amount}`);
                if (payload.fail) {
                  data.nested.marks.push('raw-submit-effect');
                  throw new Error('no commit');
                }
              },
              reduce: (draft, payload) => {
                events.push(`reduce:${draft.count}:${payload.amount}`);
                draft.count += payload.amount;
                draft.log.push('reduced');
                draft.nested.marks.push('reduced');
              },
            }),
          },
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const actor = createActor(m);
    actor.start();

    actor.send({ type: 'SUBMIT__start__submit', payload: { amount: 2, fail: true } });
    expect(actor.getSnapshot().context).toMatchObject({ count: 0, log: [], nested: { marks: [] } });

    actor.send({ type: 'SUBMIT__start__submit', payload: { amount: 2 } });
    expect(events).toEqual(['effect:0:2', 'effect:0:2', 'reduce:0:2']);
    expect(actor.getSnapshot().context).toMatchObject({
      count: 2,
      log: ['reduced'],
      nested: { marks: ['reduced'] },
    });
  });
});
