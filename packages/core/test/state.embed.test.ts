import { describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { aharness } from '../src/state/machine.js';
import { state, exit, final } from '../src/state/exits.js';
import { embed, isEmbeddedNode } from '../src/state/embed.js';
import { createFsm } from '../src/state/createFsm.js';
import { ActorHost } from '../src/runtime/actorHost.js';
import { createSubmitDispatcher } from '../src/runtime/dispatchSubmit.js';
import type { SchemaSidecar } from '../src/types.js';
import parent from './fixtures/embed/parent.fsm.js';

interface ParentCtx {
  readonly capturedShippedOutput: unknown;
  readonly capturedFailedOutput: unknown;
}

interface CanonicalParentData {
  topic: string;
  childSummary: string | null;
  marks: string[];
}

interface CanonicalChildData {
  topic: string;
  summary: string | null;
}

interface RenamedInputParentData {
  parentTopic: string;
  childSummary: string | null;
  childTopicSeen: string | null;
}

interface RenamedInputChildData {
  childTopic: string;
  summary: string | null;
}

function submitCall(stateId: string, exitName: string, data: unknown) {
  return {
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    tool: 'aharness_submit',
    arguments: JSON.stringify({ state: stateId, exit: exitName, data }),
  };
}

function buildCanonicalEmbedMachine(events: string[], failOnSummary?: string) {
  const childFsm = createFsm<CanonicalChildData>();
  const child = childFsm.machine({
    id: 'canonical-child',
    input: {
      topic: childFsm.input.string(),
    },
    data: ({ input }) => ({ topic: input.topic, summary: null }),
    initial: 'compose',
    states: {
      compose: childFsm.state({
        prompt: 'compose child',
        on: {
          finish: childFsm.submit<{ summary: string }>({
            to: 'shipped',
            reduce: (draft, payload) => {
              draft.summary = payload.summary;
            },
          }),
        },
      }),
      shipped: childFsm.final({
        outcome: 'success',
        output: (data) => ({ summary: data.summary ?? '', topic: data.topic }),
      }),
    },
  });

  const parentFsm = createFsm<CanonicalParentData>();
  return parentFsm.machine({
    id: 'canonical-parent',
    data: () => ({ topic: 'auth', childSummary: null, marks: [] }),
    initial: 'start',
    states: {
      start: parentFsm.state({
        prompt: 'start',
        on: {
          go: parentFsm.submit<{}>({ to: 'child' }),
        },
      }),
      child: parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic }),
        on: {
          shipped: {
            to: 'done',
            effect: async ({ data, output }) => {
              events.push(`effect:start:${data.childSummary ?? 'none'}:${output.summary}`);
              await Promise.resolve();
              events.push('effect:after-async');
              if (output.summary === failOnSummary) {
                throw new Error('canonical embed effect failed');
              }
            },
            reduce: (draft, output) => {
              events.push(`reduce:${output.summary}`);
              draft.childSummary = output.summary;
              draft.marks = [...draft.marks, output.topic];
            },
          },
        },
      }),
      done: parentFsm.final({ outcome: 'success' }),
    },
  });
}

function buildCanonicalEmbedWithRenamedInput() {
  const childFsm = createFsm<RenamedInputChildData>();
  const child = childFsm.machine({
    id: 'canonical-renamed-input-child',
    input: {
      childTopic: childFsm.input.string(),
    },
    data: ({ input }) => ({ childTopic: input.childTopic, summary: null }),
    initial: 'compose',
    states: {
      compose: childFsm.state({
        prompt: (data) => `Compose ${data.childTopic}.`,
        on: {
          finish: childFsm.submit<{ summary: string }>({
            to: 'shipped',
            reduce: (draft, payload) => {
              draft.summary = payload.summary;
            },
          }),
        },
      }),
      shipped: childFsm.final({
        outcome: 'success',
        output: (data) => ({
          childTopic: data.childTopic,
          summary: data.summary ?? '',
        }),
      }),
    },
  });

  const parentFsm = createFsm<RenamedInputParentData>();
  return parentFsm.machine({
    id: 'canonical-renamed-input-parent',
    data: () => ({ parentTopic: 'billing', childSummary: null, childTopicSeen: null }),
    initial: 'start',
    states: {
      start: parentFsm.state({
        prompt: 'start',
        on: {
          go: parentFsm.submit<{}>({ to: 'child' }),
        },
      }),
      child: parentFsm.embed(child, {
        input: (data) => ({ childTopic: data.parentTopic }),
        on: {
          shipped: {
            to: 'done',
            reduce: (draft, output) => {
              draft.childSummary = output.summary;
              draft.childTopicSeen = output.childTopic;
            },
          },
        },
      }),
      done: parentFsm.final({ outcome: 'success' }),
    },
  });
}

const canonicalEmbedSidecar: SchemaSidecar = {
  start: {
    go: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
  'child.compose': {
    finish: {
      jsonSchema: {
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

// Build a fresh compiled child per `it()` to avoid sharing mutated state
// across tests. The child's pre-synthesis snapshot lives on `child.__aharnessRawConfig`.
function buildChild() {
  return aharness.machine({
    id: 'child',
    initial: 'go',
    states: {
      go: state({
        entryPrompt: 'go',
        exits: {
          out: exit<{ ok: boolean }>({ to: 'shipped' }),
        },
      }),
      shipped: final({ outcome: 'success' as const, output: () => ({ ok: true }) }),
      failed: final({ outcome: 'failure' as const }),
    },
  } as never);
}

describe('embed()', () => {
  it('returns a compound-state config carrying embedded provenance', () => {
    const compound = embed(buildChild(), {
      on: {
        shipped: { target: 'next', actions: [] },
        failed: { target: 'router' },
      },
    });
    expect(compound.initial).toBe('go');
    expect(compound.states).toBeDefined();
    expect(isEmbeddedNode(compound)).toBe(true);
    expect([...compound.meta.aharness.embedded.exits].sort()).toEqual(['failed', 'shipped']);
  });

  it('records the on-map for the synthesizer to consume', () => {
    const compound = embed(buildChild(), {
      on: { shipped: { target: 'next' }, failed: { target: 'router' } },
    });
    expect(compound.meta.aharness.embedded.onMap.shipped).toEqual({ target: 'next' });
    expect(compound.meta.aharness.embedded.onMap.failed).toEqual({ target: 'router' });
  });

  it('records the input projection function when supplied', () => {
    const proj = ({ context }: { context: { x: number } }) => ({ x: context.x });
    const compound = embed(buildChild(), {
      input: proj,
      on: { shipped: { target: 'next' }, failed: { target: 'router' } },
    });
    expect(compound.meta.aharness.embedded.input).toBe(proj);
  });

  it('rejects an on-map missing keys for declared finals', () => {
    expect(() => embed(buildChild(), { on: { shipped: { target: 'next' } } as never })).toThrow(
      /on-map missing entries for final\(s\): failed/,
    );
  });

  it('rejects extra on-map keys not matching any final', () => {
    expect(() =>
      embed(buildChild(), {
        on: {
          shipped: { target: 'next' },
          failed: { target: 'router' },
          bogus: { target: 'x' },
        } as never,
      }),
    ).toThrow(/on-map references unknown final\(s\): bogus/);
  });

  it('reads the pre-synthesis snapshot from a compiled machine via __aharnessRawConfig', () => {
    const child = buildChild();
    const compound = embed(child, {
      on: { shipped: { target: 'next' }, failed: { target: 'router' } },
    });
    // The lifted `states` should be the snapshot's states (no SUBMIT__ keys),
    // not the post-synthesis machine.config.states.
    const goNode = (compound.states as Record<string, { on?: Record<string, unknown> }>).go;
    const submitKeys = Object.keys(goNode.on ?? {}).filter((k) => k.startsWith('SUBMIT__'));
    expect(submitKeys).toEqual([]);
  });

  it('also accepts a raw MachineConfig (advanced case)', () => {
    // No __aharnessRawConfig — embed() uses the raw object directly.
    const rawConfig = {
      id: 'inline',
      initial: 'go',
      states: {
        go: state({
          entryPrompt: 'go',
          exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
        }),
        done: final({ outcome: 'success' as const }),
      },
    };
    const compound = embed(rawConfig as never, { on: { done: { target: 'next' } } });
    expect(compound.initial).toBe('go');
    expect(compound.meta.aharness.embedded.exits).toEqual(['done']);
  });

  it('produces independent compounds when embed() is called twice on the same child', () => {
    const child = buildChild();
    const compoundA = embed(child, {
      on: { shipped: { target: 'targetA' }, failed: { target: 'failA' } },
    });
    const compoundB = embed(child, {
      on: { shipped: { target: 'targetB' }, failed: { target: 'failB' } },
    });
    // The lifted `states` must be separate objects; mutating one must not
    // affect the other (the parent's synthesizer will write
    // qualified-id SUBMIT keys onto whichever path it's at).
    const goA = (compoundA.states as Record<string, unknown>).go;
    const goB = (compoundB.states as Record<string, unknown>).go;
    expect(goA).not.toBe(goB);
    // Sanity: both compounds carry the same final IDs.
    expect([...compoundA.meta.aharness.embedded.exits].sort()).toEqual(['failed', 'shipped']);
    expect([...compoundB.meta.aharness.embedded.exits].sort()).toEqual(['failed', 'shipped']);
  });
});

describe('createFsm().embed() — canonical runtime contract', () => {
  it('runs child-final effect before reducer and passes child output directly', async () => {
    const events: string[] = [];
    const machine = buildCanonicalEmbedMachine(events);
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: canonicalEmbedSidecar,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge: () => 'child nudge',
      scheduleCrossStateDance: vi.fn(),
    });

    const enter = await dispatch(submitCall('start', 'go', {}));
    expect(enter.success).toBe(true);
    expect(host.currentStateId()).toBe('child.compose');

    const finish = await dispatch(submitCall('child.compose', 'finish', { summary: 'draft' }));
    expect(finish.success).toBe(true);
    expect(events).toEqual(['effect:start:none:draft', 'effect:after-async', 'reduce:draft']);
    expect(host.currentContext()).toMatchObject({
      topic: 'auth',
      childSummary: 'draft',
      marks: ['auth'],
    });
  });

  it('does not commit the child final transition or parent reducer when child-final effect rejects', async () => {
    const events: string[] = [];
    const machine = buildCanonicalEmbedMachine(events, 'bad');
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: canonicalEmbedSidecar,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge: () => 'child nudge',
      scheduleCrossStateDance: vi.fn(),
    });

    await dispatch(submitCall('start', 'go', {}));
    const finish = await dispatch(submitCall('child.compose', 'finish', { summary: 'bad' }));

    expect(finish.success).toBe(false);
    expect(finish.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: expect.stringContaining('canonical embed effect failed'),
    });
    expect(events).toEqual(['effect:start:none:bad', 'effect:after-async']);
    expect(host.currentStateId()).toBe('child.compose');
    expect(host.currentContext()).toMatchObject({
      topic: 'auth',
      childSummary: null,
      marks: [],
    });
  });

  it('materializes projected child input before child reducers and final output run', async () => {
    const machine = buildCanonicalEmbedWithRenamedInput();
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: {
        start: {
          go: {
            jsonSchema: { type: 'object' },
            validate: (input: unknown) => ({ ok: true, data: input }),
          },
        },
        'child.compose': {
          finish: {
            jsonSchema: {
              type: 'object',
              required: ['summary'],
              properties: { summary: { type: 'string' } },
            },
            validate: (input: unknown) => ({ ok: true, data: input }),
          },
        },
      },
      flushSnapshot: vi.fn(),
      composeActiveStateNudge: () => 'child nudge',
      scheduleCrossStateDance: vi.fn(),
    });

    const enter = await dispatch(submitCall('start', 'go', {}));
    expect(enter.success).toBe(true);
    expect(host.currentContext()).toMatchObject({
      parentTopic: 'billing',
      childTopic: 'billing',
      summary: null,
    });

    const finish = await dispatch(submitCall('child.compose', 'finish', { summary: 'done' }));
    expect(finish.success).toBe(true);
    expect(host.currentContext()).toMatchObject({
      parentTopic: 'billing',
      childTopic: 'billing',
      summary: 'done',
      childSummary: 'done',
      childTopicSeen: 'billing',
    });
  });
});

describe('embed() synthesis — bare-finalId raise + parent on-map', () => {
  it("raises 'shipped' when the embedded child enters its shipped final, parent transitions to done", () => {
    const actor = createActor(parent);
    actor.start();
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    expect(actor.getSnapshot().value).toEqual({ inner: 'go' });
    actor.send({ type: 'SUBMIT__inner.go__out', payload: { ok: true } });
    expect(actor.getSnapshot().value).toBe('done');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it("raises 'failed' when the embedded child enters its failed final, parent routes back to router", () => {
    const actor = createActor(parent);
    actor.start();
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    actor.send({ type: 'SUBMIT__inner.go__bad', payload: { ok: false } });
    expect(actor.getSnapshot().value).toBe('router');
    expect(actor.getSnapshot().status).toBe('active');
  });

  it("event inside the parent's on-map handler is the raised event, not the SUBMIT (XState 5 semantics, fixes v4 bug #3059)", () => {
    // The parent's `assign({capturedShippedOutput: ({event}) => event.output})` runs as
    // an action on the on['shipped'] transition. In XState 5 (unlike v4), `event` here
    // is the *raised* event {type: 'shipped', output: ...}, NOT the SUBMIT that drove
    // entry into the embedded final. The synthesizer puts `output` on the raised event,
    // which is why event.output works. Pin this contract: the captured value carries
    // the user's output() return verbatim — having `receivedFromSubmit` proves event.output
    // existed (i.e. the on-map handler saw the raised event). If event were the SUBMIT,
    // event.output would be undefined.
    const actor = createActor(parent);
    actor.start();
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    actor.send({ type: 'SUBMIT__inner.go__out', payload: { ok: true } });
    const ctx = actor.getSnapshot().context as ParentCtx;
    expect(ctx.capturedShippedOutput).toBeDefined();
    expect((ctx.capturedShippedOutput as { receivedFromSubmit?: unknown }).receivedFromSubmit).toBe(
      true,
    );
  });

  it("event inside the embedded final's output() callback is the SUBMIT event that drove entry — entry-action context", () => {
    // The child's shipped final has `output: ({event}) => ({ok: true, receivedFromSubmit: event.payload.ok})`.
    // This test pins the contract specifically for the entry-action evaluation context inside
    // the user's `output` callback: when XState evaluates the synthesized `entry: raise(({event}) => ...)`,
    // the `event` arg is the transition-causing event (the SUBMIT that drove entry into the embedded
    // final), not a synthetic one. NOTE: this is distinct from the `event` seen by the parent's on-map
    // handler downstream — that one is the raised event, see test #3 above.
    const actor = createActor(parent);
    actor.start();
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    actor.send({ type: 'SUBMIT__inner.go__out', payload: { ok: false } });
    const ctx = actor.getSnapshot().context as ParentCtx;
    expect(ctx.capturedShippedOutput).toEqual({ ok: true, receivedFromSubmit: false });
  });

  it('output is undefined on event when the child final declares no output() callback (failed)', () => {
    const actor = createActor(parent);
    actor.start();
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    actor.send({ type: 'SUBMIT__inner.go__bad', payload: { ok: false } });
    const ctx = actor.getSnapshot().context as ParentCtx;
    expect(ctx.capturedFailedOutput).toBeUndefined();
  });
});
