import { describe, expect, it, vi } from 'vitest';
import { assign } from 'xstate';

import { createFsm, aharness, state, terminal } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import { createEventDispatcher } from '../src/runtime/dispatchEvent.js';
import { createAharnessOps } from '../src/state/aharnessOps.js';
import type { CanonicalEventMeta } from '../src/state/exits.js';

interface Ctx {
  count: number;
  nested: { marks: string[] };
}
interface EmbeddedEventCtx {
  topic: string;
  summary: string | null;
  childSummary: string | null;
}

function customEvent(meta: CanonicalEventMeta<Ctx>): CanonicalEventMeta<Ctx> {
  return meta;
}

function buildHost(args: {
  readonly eventMeta?: CanonicalEventMeta<Ctx>;
  readonly eventTransition?: unknown;
  readonly initialContext?: Ctx;
}) {
  const machine = aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => args.initialContext ?? { count: 0, nested: { marks: [] } },
    states: {
      a: {
        ...state({
          entryPrompt: 'in a',
          exits: {},
          ...(args.eventMeta !== undefined
            ? { canonicalEvents: { ping: args.eventMeta } }
            : { canonicalEvents: {} }),
        }),
        ...(args.eventTransition !== undefined ? { on: { ping: args.eventTransition } } : {}),
      },
      b: state({
        entryPrompt: 'in b',
        exits: {},
        canonicalEvents: {},
      }),
      done: terminal('success'),
    },
  });
  const host = new ActorHost(machine, undefined);
  host.start();
  return host;
}

function buildCanonicalEventEmbeddedHost(events: string[], failOnSummary?: string) {
  const childBase = createFsm<EmbeddedEventCtx>();
  const childFsm = childBase.withEvents({
    complete: childBase.event<{ summary: string }>(),
  });
  const child = childFsm.machine({
    id: 'event-embedded-child',
    input: {
      topic: childFsm.input.string(),
    },
    data: ({ input }) => ({
      topic: input.topic,
      summary: null,
      childSummary: null,
    }),
    initial: 'compose',
    states: {
      compose: childFsm.state({
        prompt: 'compose',
        on: {
          complete: {
            to: 'shipped',
            reduce: (draft, payload) => {
              draft.summary = payload.summary;
            },
          },
        },
      }),
      shipped: childFsm.final({
        outcome: 'success',
        output: (data) => ({ summary: data.summary ?? '', topic: data.topic }),
      }),
    },
  });

  const parentFsm = createFsm<EmbeddedEventCtx>();
  const machine = parentFsm.machine({
    id: 'event-embedded-parent',
    data: () => ({ topic: 'auth', summary: null, childSummary: null }),
    initial: 'child',
    states: {
      child: parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic }),
        on: {
          shipped: {
            to: 'done',
            effect: async ({ output }) => {
              events.push(`effect:${output.summary}`);
              if (output.summary === failOnSummary) {
                throw new Error('canonical embed event effect failed');
              }
            },
            reduce: (draft, output) => {
              events.push(`reduce:${output.summary}`);
              draft.childSummary = output.summary;
            },
          },
        },
      }),
      done: parentFsm.final({ outcome: 'success' }),
    },
  });
  const host = new ActorHost(machine, undefined);
  host.start();
  return host;
}

describe('createEventDispatcher', () => {
  it('dispatches through createFsm().withEvents() lowered keyed handlers', async () => {
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      ping: base.event<{ inc: number }, string>({ defaultReturn: 'fallback' }),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            ping: {
              to: 'b',
              actions: assign(({ context }) => {
                (context as Ctx).nested.marks.push('action');
                return {};
              }),
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
              return: (data) => `count:${data.count}`,
            },
          },
        }),
        b: fsm.state({
          prompt: 'b',
          on: {
            ping: {
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
              return: (data) => `count:${data.count}`,
            },
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn();
    const dispatch = createEventDispatcher({ host, flushSnapshot });

    const result = await dispatch('ping', { inc: 4 });

    expect(result).toEqual({ handled: true, stateChanged: true, returnValue: 'count:4' });
    expect(host.currentStateId()).toBe('b');
    expect(host.currentContext().count).toBe(4);
    expect(host.currentContext().nested).toEqual({ marks: ['action'] });
    expect(flushSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports committed non-self event transitions after the legacy flush hook', async () => {
    const events: string[] = [];
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      ping: base.event<{ inc: number }>(),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            ping: {
              to: 'b',
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
            },
          },
        }),
        b: fsm.state({
          prompt: 'b',
          on: {
            ping: {
              reduce: () => undefined,
            },
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createEventDispatcher({
      host,
      flushSnapshot: () => {
        events.push(`flush:${host.currentStateId()}`);
      },
      onCommittedTransition: (info) => {
        events.push(`committed:${info.from}->${info.to}`);
      },
    });

    await dispatch('ping', { inc: 1 });

    expect(events).toEqual(['flush:b', 'committed:a->b']);
  });

  it('passes runtime-bound ops to canonical event effects', async () => {
    const emitted = vi.fn(async () => ({
      handled: true,
      stateChanged: false,
      returnValue: 'nested-ok',
    }));
    const opsHandle = createAharnessOps({ emit: emitted });
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      ping: base.event<{ inc: number }>(),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            ping: {
              effect: async ({ ops, payload }) => {
                await ops.emit('nested', payload);
              },
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
            },
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createEventDispatcher({
      host,
      flushSnapshot: vi.fn(),
      ops: opsHandle.ops,
    });

    await dispatch('ping', { inc: 3 });

    expect(emitted).toHaveBeenCalledWith('nested', { inc: 3 });
    expect(host.currentContext().count).toBe(3);
  });

  it('runs terminal artifact and completion callbacks for event transitions to finals', async () => {
    const order: string[] = [];
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      finish: base.event<{ inc: number }>(),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            finish: {
              to: 'done',
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
            },
          },
        }),
        done: fsm.final({
          outcome: 'success',
          artifacts: {
            'result.md': (data) => `count:${data.count}`,
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn(() => {
      order.push(`flush:${host.currentStateId()}:${host.currentContext().count}`);
    });
    const writeFinalArtifacts = vi.fn(async (terminalStateId: string, context) => {
      order.push(`artifacts:${terminalStateId}:${(context as Ctx).count}`);
    });
    const onTerminal = vi.fn((terminalStateId: string) => {
      order.push(`terminal:${terminalStateId}`);
    });
    const dispatch = createEventDispatcher({
      host,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
    });

    const result = await dispatch('finish', { inc: 5 });

    expect(result).toEqual({ handled: true, stateChanged: true, returnValue: undefined });
    expect(host.currentStateId()).toBe('done');
    expect(writeFinalArtifacts).toHaveBeenCalledWith('done', expect.objectContaining({ count: 5 }));
    expect(onTerminal).toHaveBeenCalledWith('done');
    expect(order).toEqual(['artifacts:done:5', 'flush:done:5', 'terminal:done']);
  });

  it('rejects terminal event artifact failures before commit, flush, or terminal completion', async () => {
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      finish: base.event<{ inc: number }>(),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            finish: {
              to: 'done',
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
            },
          },
        }),
        done: fsm.final({
          outcome: 'success',
          artifacts: {
            'result.md': (data) => `count:${data.count}`,
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn();
    const onTerminal = vi.fn();
    const writeFinalArtifacts = vi.fn(async () => {
      throw new Error('disk full');
    });
    const dispatch = createEventDispatcher({
      host,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
    });

    await expect(dispatch('finish', { inc: 5 })).rejects.toThrow(/disk full/);
    expect(writeFinalArtifacts).toHaveBeenCalledWith('done', expect.objectContaining({ count: 5 }));
    expect(host.currentStateId()).toBe('a');
    expect(host.currentContext().count).toBe(0);
    expect(flushSnapshot).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('reports request-event terminal artifact failures and returns the default before commit', async () => {
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      finish: base.event<{ inc: number }, string>({ defaultReturn: 'fallback' }),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'a',
      states: {
        a: fsm.state({
          prompt: 'a',
          on: {
            finish: {
              to: 'done',
              reduce: (draft, payload) => {
                draft.count += payload.inc;
              },
              return: () => 'accepted',
            },
          },
        }),
        done: fsm.final({
          outcome: 'success',
          artifacts: {
            'result.md': (data) => `count:${data.count}`,
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn();
    const onTerminal = vi.fn();
    const onCanonicalEventError = vi.fn();
    const writeFinalArtifacts = vi.fn(async () => {
      throw new Error('disk full');
    });
    const dispatch = createEventDispatcher({
      host,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
      onCanonicalEventError,
    });

    await expect(dispatch('finish', { inc: 5 })).resolves.toEqual({
      handled: false,
      stateChanged: false,
      returnValue: 'fallback',
    });
    expect(writeFinalArtifacts).toHaveBeenCalledWith('done', expect.objectContaining({ count: 5 }));
    expect(onCanonicalEventError).toHaveBeenCalledWith({
      eventName: 'finish',
      stateId: 'a',
      branchIndex: 0,
      phase: 'transition',
      error: expect.objectContaining({ message: 'disk full' }),
    });
    expect(host.currentStateId()).toBe('a');
    expect(host.currentContext().count).toBe(0);
    expect(flushSnapshot).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('preflights request-event artifacts for nested relative terminal targets', async () => {
    const base = createFsm<Ctx>();
    const fsm = base.withEvents({
      finish: base.event<{ inc: number }, string>({ defaultReturn: 'fallback' }),
    });
    const machine = fsm.machine({
      data: () => ({ count: 0, nested: { marks: [] } }),
      initial: 'parent',
      states: {
        parent: {
          initial: 'work',
          states: {
            work: fsm.state({
              prompt: 'work',
              on: {
                finish: {
                  to: 'done',
                  reduce: (draft, payload) => {
                    draft.count += payload.inc;
                  },
                  return: () => 'accepted',
                },
              },
            }),
            done: fsm.final({
              outcome: 'success',
              artifacts: {
                'result.md': (data) => `count:${data.count}`,
              },
            }),
          },
        },
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn();
    const onTerminal = vi.fn();
    const onCanonicalEventError = vi.fn();
    const writeFinalArtifacts = vi.fn(async () => {
      throw new Error('disk full');
    });
    const dispatch = createEventDispatcher({
      host,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
      onCanonicalEventError,
    });

    await expect(dispatch('finish', { inc: 5 })).resolves.toEqual({
      handled: false,
      stateChanged: false,
      returnValue: 'fallback',
    });
    expect(writeFinalArtifacts).toHaveBeenCalledWith(
      'parent.done',
      expect.objectContaining({ count: 5 }),
    );
    expect(onCanonicalEventError).toHaveBeenCalledWith({
      eventName: 'finish',
      stateId: 'parent.work',
      branchIndex: 0,
      phase: 'transition',
      error: expect.objectContaining({ message: 'disk full' }),
    });
    expect(host.currentStateId()).toBe('parent.work');
    expect(host.currentContext().count).toBe(0);
    expect(flushSnapshot).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('commits a selected signal branch after awaiting effect and before the legacy flush hook', async () => {
    const events: string[] = [];
    const host = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: false,
        branches: [
          {
            effect: async ({ data, payload }) => {
              events.push(`effect:${data.count}:${(payload as { inc: number }).inc}`);
            },
            reduce: (draft, payload) => {
              events.push(`reduce:${draft.count}:${(payload as { inc: number }).inc}`);
              draft.count += (payload as { inc: number }).inc;
            },
            to: 'b',
          },
        ],
      }),
      eventTransition: {
        target: 'b',
        actions: assign(({ event }) => {
          const next = (event as { payload?: { __aharnessCanonicalCommitContext?: Ctx } }).payload
            ?.__aharnessCanonicalCommitContext;
          events.push(`commit:${next?.count}`);
          return next ?? {};
        }),
      },
    });
    const flushSnapshot = vi.fn(() => {
      events.push(`flush:${host.currentStateId()}:${host.currentContext().count}`);
    });
    const dispatch = createEventDispatcher({ host, flushSnapshot });

    const result = await dispatch('ping', { inc: 3 });

    expect(result).toEqual({ handled: true, stateChanged: true, returnValue: undefined });
    expect(host.currentStateId()).toBe('b');
    expect(host.currentContext().count).toBe(3);
    expect(events).toEqual(['effect:0:3', 'reduce:0:3', 'commit:3', 'flush:b:3']);
  });

  it('runs request return after commit and legacy flush hook using post-commit data', async () => {
    const events: string[] = [];
    const host = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'default',
        branches: [
          {
            reduce: (draft, payload) => {
              draft.count += (payload as { inc: number }).inc;
            },
            return: (data, payload) => {
              events.push(`return:${data.count}:${(payload as { inc: number }).inc}`);
              return `count:${data.count}`;
            },
          },
        ],
      }),
      eventTransition: {
        actions: assign(({ event }) => {
          const next = (event as { payload?: { __aharnessCanonicalCommitContext?: Ctx } }).payload
            ?.__aharnessCanonicalCommitContext;
          events.push(`commit:${next?.count}`);
          return next ?? {};
        }),
      },
    });
    const flushSnapshot = vi.fn(() => {
      events.push(`flush:${host.currentStateId()}:${host.currentContext().count}`);
    });
    const dispatch = createEventDispatcher({ host, flushSnapshot });

    const result = await dispatch('ping', { inc: 2 });

    expect(result).toEqual({ handled: true, stateChanged: false, returnValue: 'count:2' });
    expect(host.currentStateId()).toBe('a');
    expect(events).toEqual(['commit:2', 'flush:a:2', 'return:2:2']);
  });

  it('returns a request default when no handler exists or no route branch matches', async () => {
    const noHandlerHost = buildHost({});
    const noHandlerDispatch = createEventDispatcher({
      host: noHandlerHost,
      flushSnapshot: vi.fn(),
    });

    await expect(
      noHandlerDispatch('missing', { value: true }, { request: true, defaultReturn: 'fallback' }),
    ).resolves.toEqual({ handled: false, stateChanged: false, returnValue: 'fallback' });

    const noMatchHost = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'fallback',
        branches: [
          {
            predicate: () => false,
            return: () => 'selected',
          },
        ],
      }),
      eventTransition: {},
    });
    const flushSnapshot = vi.fn();
    const noMatchDispatch = createEventDispatcher({ host: noMatchHost, flushSnapshot });

    await expect(noMatchDispatch('ping', {})).resolves.toEqual({
      handled: false,
      stateChanged: false,
      returnValue: 'fallback',
    });
    expect(flushSnapshot).not.toHaveBeenCalled();
  });

  it('does not flush or leak nested live-context mutations when effect or reducer fails', async () => {
    const effectHost = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'fallback',
        branches: [
          {
            effect: ({ data }) => {
              data.nested.marks.push('effect');
              throw new Error('boom');
            },
            reduce: (draft) => {
              draft.nested.marks.push('reduce');
            },
            return: () => 'selected',
          },
        ],
      }),
      eventTransition: {},
    });
    const effectFlushSnapshot = vi.fn();
    const effectDispatch = createEventDispatcher({
      host: effectHost,
      flushSnapshot: effectFlushSnapshot,
    });

    const effectResult = await effectDispatch('ping', {});

    expect(effectResult).toEqual({ handled: false, stateChanged: false, returnValue: 'fallback' });
    expect(effectHost.currentContext()).toEqual({
      count: 0,
      nested: { marks: [] },
      __aharness_lastOwnerReply: undefined,
      __aharness_visitCount: { a: 1 },
    });
    expect(effectFlushSnapshot).not.toHaveBeenCalled();

    const reducerHost = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'fallback',
        branches: [
          {
            reduce: (draft) => {
              draft.nested.marks.push('reduce');
              throw new Error('reducer boom');
            },
            return: () => 'selected',
          },
        ],
      }),
      eventTransition: {},
    });
    const reducerFlushSnapshot = vi.fn();
    const reducerDispatch = createEventDispatcher({
      host: reducerHost,
      flushSnapshot: reducerFlushSnapshot,
    });

    const reducerResult = await reducerDispatch('ping', {});

    expect(reducerResult).toEqual({ handled: false, stateChanged: false, returnValue: 'fallback' });
    expect(reducerHost.currentContext()).toEqual({
      count: 0,
      nested: { marks: [] },
      __aharness_lastOwnerReply: undefined,
      __aharness_visitCount: { a: 1 },
    });
    expect(reducerFlushSnapshot).not.toHaveBeenCalled();
  });

  it('reports selected transition and return failures without hiding request defaults', async () => {
    const transitionHost = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'fallback',
        branches: [
          {
            reduce: () => {
              throw new Error('reducer boom');
            },
            return: () => 'selected',
          },
        ],
      }),
      eventTransition: {},
    });
    const transitionError = vi.fn();
    const transitionDispatch = createEventDispatcher({
      host: transitionHost,
      flushSnapshot: vi.fn(),
      onCanonicalEventError: transitionError,
    });

    await expect(transitionDispatch('ping', {})).resolves.toEqual({
      handled: false,
      stateChanged: false,
      returnValue: 'fallback',
    });
    expect(transitionError).toHaveBeenCalledWith({
      eventName: 'ping',
      stateId: 'a',
      branchIndex: 0,
      phase: 'transition',
      error: expect.objectContaining({ message: 'reducer boom' }),
    });

    const returnHost = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'fallback',
        branches: [
          {
            reduce: (draft) => {
              draft.count = 7;
            },
            return: () => {
              throw new Error('return failed');
            },
          },
        ],
      }),
      eventTransition: {
        actions: assign(({ event }) => {
          const next = (event as { payload?: { __aharnessCanonicalCommitContext?: Ctx } }).payload
            ?.__aharnessCanonicalCommitContext;
          return next ?? {};
        }),
      },
    });
    const returnError = vi.fn();
    const returnDispatch = createEventDispatcher({
      host: returnHost,
      flushSnapshot: vi.fn(),
      onCanonicalEventError: returnError,
    });

    await expect(returnDispatch('ping', {})).resolves.toEqual({
      handled: true,
      stateChanged: false,
      returnValue: 'fallback',
    });
    expect(returnHost.currentContext().count).toBe(7);
    expect(returnError).toHaveBeenCalledWith({
      eventName: 'ping',
      stateId: 'a',
      branchIndex: 0,
      phase: 'return',
      error: expect.objectContaining({ message: 'return failed' }),
    });
  });

  it('does not roll back a committed request when return fails', async () => {
    const host = buildHost({
      eventMeta: customEvent({
        kind: 'event',
        eventKind: 'custom',
        request: true,
        defaultReturn: 'fallback',
        branches: [
          {
            reduce: (draft) => {
              draft.count = 7;
            },
            return: () => {
              throw new Error('return failed');
            },
          },
        ],
      }),
      eventTransition: {
        actions: assign(({ event }) => {
          const next = (event as { payload?: { __aharnessCanonicalCommitContext?: Ctx } }).payload
            ?.__aharnessCanonicalCommitContext;
          return next ?? {};
        }),
      },
    });
    const flushSnapshot = vi.fn();
    const dispatch = createEventDispatcher({ host, flushSnapshot });

    const result = await dispatch('ping', {});

    expect(result).toEqual({ handled: true, stateChanged: false, returnValue: 'fallback' });
    expect(host.currentContext().count).toBe(7);
    expect(flushSnapshot).toHaveBeenCalledTimes(1);
  });

  it('preflights canonical embedded child-final effect and reducer before committing a custom event into the child final', async () => {
    const events: string[] = [];
    const host = buildCanonicalEventEmbeddedHost(events);
    const flushSnapshot = vi.fn(() => {
      events.push(`flush:${host.currentStateId()}:${host.currentContext().childSummary ?? 'none'}`);
    });
    const dispatch = createEventDispatcher({ host, flushSnapshot });

    const result = await dispatch('complete', { summary: 'draft' });

    expect(result).toEqual({ handled: true, stateChanged: true, returnValue: undefined });
    expect(host.currentStateId()).toBe('done');
    expect(host.currentContext()).toMatchObject({ childSummary: 'draft' });
    expect(events).toEqual(['effect:draft', 'reduce:draft', 'flush:done:draft']);
  });

  it('does not commit a custom event into an embedded child final when its canonical effect rejects', async () => {
    const events: string[] = [];
    const host = buildCanonicalEventEmbeddedHost(events, 'bad');
    const flushSnapshot = vi.fn();
    const dispatch = createEventDispatcher({ host, flushSnapshot });

    const result = await dispatch('complete', { summary: 'bad' });

    expect(result).toEqual({ handled: false, stateChanged: false, returnValue: undefined });
    expect(host.currentStateId()).toBe('child.compose');
    expect(host.currentContext()).toMatchObject({ childSummary: null });
    expect(events).toEqual(['effect:bad']);
    expect(flushSnapshot).not.toHaveBeenCalled();
  });
});
