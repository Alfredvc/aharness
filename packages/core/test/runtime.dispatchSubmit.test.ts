/**
 * Tests for `runtime/dispatchSubmit.ts` — Phase 1 + Phase 2a submit
 * dispatcher.
 *
 * Phase-1 scope (plan `2026-05-12-headless-phase-1a-transport-backbone.md`,
 * Task 9):
 *   - self-loop success → reply terse `'ok'`, legacy flush hook runs
 *     BEFORE reply when provided, transition logged.
 *   - terminal success → reply `Run complete. Terminal: success.`,
 *     `onTerminal` fired, legacy flush hook runs when provided.
 *   - off-state / off-exit / schema-fail → `success: false` reply, actor
 *     not mutated.
 *
 * Phase-2a scope (plan `2026-05-12-headless-phase-2a-cross-state.md`,
 * Task 3):
 *   - cross-state submits commit + optional legacy flush hook + log +
 *     compose nudge + invoke `scheduleCrossStateDance`, then reply terse
 *     `'ok'`.
 *   - `composeActiveStateNudge` runs AFTER commit so the live host is
 *     at the new leaf.
 *   - missing `composeActiveStateNudge` opt → throws
 *     `'composeActiveStateNudge not wired'`.
 *   - missing `scheduleCrossStateDance` opt → throws
 *     `'crossStateDance not wired'`.
 *
 * Phase-2b scope (plan `2026-05-13-headless-phase-2b-owner-yield.md`,
 * Task 6):
 *   - cross-state submit into an awaitsOwnerText target commits +
 *     schedules the dance identically to non-yielding targets. The
 *     `composeActiveStateNudge` callback runs once and the returned
 *     nudge (which `composeStateNudge` prepends with the
 *     `request_user_input` preamble carrying the verbatim
 *     `messageToUser`) flows verbatim into the dance opts.
 *
 * The Phase-1 wire shape uses tool name `'aharness_submit'` (renamed
 * from `'submit'` in Task 5).
 */
import { describe, expect, it, vi } from 'vitest';
import { assign } from 'xstate';

import { aharness, state, terminal, passive, exit, createFsm } from '@aharness/core';
import type { SchemaSidecar } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import {
  createSubmitDispatcher,
  publicSubmitFailureMetadataSymbol,
  type SubmitFailureMetadataCarrier,
} from '../src/runtime/dispatchSubmit.js';
import { composeStateNudge } from '../src/runtime/nudge.js';
import type { DynamicToolCallParams } from '../src/protocol/types.js';
import type { ClearOnEntryMeta } from '../src/state/exits.js';

interface Ctx {
  count: number;
}
interface GoPayload {
  inc: number;
}
interface NestedCtx {
  nested: { marks: string[] };
}
interface CanonicalEmbedParentCtx {
  topic: string;
  childSummary: string | null;
  marks: string[];
}
interface CanonicalEmbedChildCtx {
  topic: string;
  summary: string | null;
}

function call(args: unknown): DynamicToolCallParams {
  return {
    threadId: 't',
    turnId: 'tr',
    callId: 'c1',
    tool: 'aharness_submit',
    arguments: args as DynamicToolCallParams['arguments'],
  };
}

function publicFailureSummary(response: unknown): string | undefined {
  return (response as SubmitFailureMetadataCarrier)[publicSubmitFailureMetadataSymbol]?.summary;
}

// Two-state machine `a → b` where `b` is terminal. Exercises the
// terminal reply path and the R6 atomicity / `onTerminal` signalling.
function buildSelfTerminalMachine() {
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

const sidecarSelfTerminal: SchemaSidecar = {
  a: {
    go: {
      jsonSchema: {
        type: 'object',
        required: ['inc'],
        properties: { inc: { type: 'number' } },
      },
      validate: (input: unknown) => {
        const v = input as { inc?: unknown } | null;
        if (v && typeof v === 'object' && typeof v.inc === 'number') {
          return { ok: true, data: input };
        }
        return {
          ok: false,
          errors: [{ path: '/inc', message: 'must be number' }],
        };
      },
    },
  },
};

function makeSelfTerminalHost() {
  const machine = buildSelfTerminalMachine();
  const host = new ActorHost(machine, undefined);
  host.start();
  return { host, machine };
}

// Self-loop machine — single state, exit pointing back to itself. Used
// for the terse-`'ok'` reply path without crossing into Phase 2's
// cross-state territory.
function buildSelfLoopMachine() {
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => ({ count: 0 }),
    states: {
      a: state({
        exits: {
          again: exit<GoPayload>({
            to: 'a',
            actions: assign({
              count: ({ context, event }) =>
                context.count + (event as { payload: GoPayload }).payload.inc,
            }),
          }),
        },
        entryPrompt: 'in a',
      }),
    },
  });
}

const sidecarSelfLoop: SchemaSidecar = {
  a: {
    again: {
      jsonSchema: {
        type: 'object',
        required: ['inc'],
        properties: { inc: { type: 'number' } },
      },
      validate: (input: unknown) => {
        const v = input as { inc?: unknown } | null;
        if (v && typeof v === 'object' && typeof v.inc === 'number') {
          return { ok: true, data: input };
        }
        return { ok: false, errors: [{ path: '/inc', message: 'must be number' }] };
      },
    },
  },
};

function makeSelfLoopHost() {
  const machine = buildSelfLoopMachine();
  const host = new ActorHost(machine, undefined);
  host.start();
  return { host, machine };
}

// Two-state machine `a → b` where `b` is stateful (non-terminal,
// non-self-loop). Used to exercise the Phase-2 cross-state throw.
function buildCrossStateMachine() {
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => ({ count: 0 }),
    states: {
      a: state({
        exits: { go: exit<GoPayload>({ to: 'b' }) },
        entryPrompt: 'in a',
      }),
      b: state({
        exits: { back: exit<{}>({ to: 'a' }) },
        entryPrompt: 'in b',
      }),
    },
  });
}

const sidecarCrossState: SchemaSidecar = {
  a: {
    go: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
  b: {
    back: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

function buildCrossStateClearOnEntryMachine(
  options: {
    readonly clearOnEntry?: ClearOnEntryMeta;
    readonly model?: {
      readonly name?: string;
      readonly effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    };
  } = {},
) {
  const { clearOnEntry = true, model } = options;
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => ({ count: 0 }),
    states: {
      a: state({
        exits: { go: exit<GoPayload>({ to: 'b' }) },
        entryPrompt: 'in a',
      }),
      b: state({
        exits: { back: exit<{}>({ to: 'a' }) },
        model,
        entryPrompt: 'in b',
        clearOnEntry,
      }),
    },
  });
}

// Two-state machine `a → b` where `b` declares awaitsOwnerText. Used
// to exercise the Phase-2b path where the cross-state target state
// advertises owner-yield: the dispatcher now treats this identically
// to a non-yielding cross-state target (commit + flush + schedule
// dance with the composed nudge — which itself carries the
// request_user_input preamble built by `composeStateNudge`).
function buildCrossStateAwaitsOwnerTextMachine() {
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => ({ count: 0 }),
    states: {
      a: state({
        exits: { next: exit<GoPayload>({ to: 'b' }) },
        entryPrompt: 'in a',
      }),
      b: state({
        exits: { done: exit<{}>({ to: 'a' }) },
        entryPrompt: 'in b',
        awaitsOwnerText: { messageToUser: 'what is your name?' },
      }),
    },
  });
}

const sidecarCrossStateAwaits: SchemaSidecar = {
  a: {
    next: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
  b: {
    done: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

function buildCanonicalRoutedMachine() {
  const fsm = createFsm<{ branch: string | null }>();
  let predicateCalls = 0;
  return fsm.machine({
    id: 'm',
    initial: 'a',
    data: () => ({ branch: null }),
    states: {
      a: fsm.state({
        prompt: 'route',
        on: {
          go: fsm.submit<{ chooseFirst: boolean }>({
            route: [
              {
                if: (_data, payload) => {
                  predicateCalls += 1;
                  return payload.chooseFirst && predicateCalls === 1;
                },
                to: 'b',
                reduce: (draft) => {
                  draft.branch = 'first';
                },
              },
              {
                to: 'c',
                reduce: (draft) => {
                  draft.branch = 'catchall';
                },
              },
            ],
          }),
        },
      }),
      b: fsm.final({ outcome: 'success' }),
      c: fsm.final({ outcome: 'failure' }),
    },
  });
}

const sidecarCanonicalRouted: SchemaSidecar = {
  a: {
    go: {
      jsonSchema: {
        type: 'object',
        required: ['chooseFirst'],
        properties: { chooseFirst: { type: 'boolean' } },
      },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

function buildCanonicalFailingSubmitEffectMachine() {
  const fsm = createFsm<NestedCtx>();
  return fsm.machine({
    id: 'm',
    initial: 'a',
    data: () => ({ nested: { marks: [] } }),
    states: {
      a: fsm.state({
        prompt: 'submit',
        on: {
          go: fsm.submit<{ ok: boolean }>({
            to: 'b',
            effect: ({ data }) => {
              data.nested.marks.push('submit-effect');
              throw new Error('submit exploded');
            },
          }),
        },
      }),
      b: fsm.final({ outcome: 'success' }),
    },
  });
}

function buildCanonicalFailingRoutePredicateMachine() {
  const fsm = createFsm<NestedCtx>();
  return fsm.machine({
    id: 'm',
    initial: 'a',
    data: () => ({ nested: { marks: [] } }),
    states: {
      a: fsm.state({
        prompt: 'route',
        on: {
          go: fsm.submit<{ ok: boolean }>({
            route: [
              {
                if: (data) => {
                  data.nested.marks.push('route-predicate');
                  throw new Error('predicate exploded');
                },
                to: 'b',
              },
              { to: 'c' },
            ],
          }),
        },
      }),
      b: fsm.final({ outcome: 'success' }),
      c: fsm.final({ outcome: 'failure' }),
    },
  });
}

function buildCanonicalFailingRouteEffectMachine() {
  const fsm = createFsm<NestedCtx>();
  return fsm.machine({
    id: 'm',
    initial: 'a',
    data: () => ({ nested: { marks: [] } }),
    states: {
      a: fsm.state({
        prompt: 'route',
        on: {
          go: fsm.submit<{ ok: boolean }>({
            route: [
              {
                if: () => true,
                to: 'b',
                effect: ({ data }) => {
                  data.nested.marks.push('route-effect');
                  throw new Error('route effect exploded');
                },
              },
              { to: 'c' },
            ],
          }),
        },
      }),
      b: fsm.final({ outcome: 'success' }),
      c: fsm.final({ outcome: 'failure' }),
    },
  });
}

const sidecarCanonicalNested: SchemaSidecar = {
  a: {
    go: {
      jsonSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

function buildCanonicalSubmitEmbeddedMachine(events: string[], failOnSummary?: string) {
  const childFsm = createFsm<CanonicalEmbedChildCtx>();
  const child = childFsm.machine({
    id: 'submit-embedded-child',
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

  const parentFsm = createFsm<CanonicalEmbedParentCtx>();
  return parentFsm.machine({
    id: 'submit-embedded-parent',
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

const sidecarCanonicalEmbeddedSubmit: SchemaSidecar = {
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

// Two-state machine `a → b` where `b` is passive. Passive states are
// valid resting points in general (reached via XState `always`/`entry`
// transitions) but CANNOT be submit targets — the dispatcher must
// reject before commit. The verifier would normally catch this at
// machine-load time, but the dispatcher's job is to gate it at runtime
// for FSMs that bypass verification (raw `createMachine`, tests, etc).
function buildPassiveTargetMachine() {
  return aharness.machine({
    id: 'm',
    initial: 'a',
    context: (): Ctx => ({ count: 0 }),
    states: {
      a: state({
        exits: { go: exit<GoPayload>({ to: 'b' }) },
        entryPrompt: 'in a',
      }),
      b: passive(),
    },
  });
}

const sidecarPassiveTarget: SchemaSidecar = {
  a: {
    go: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

describe('createSubmitDispatcher — Phase 1', () => {
  // ─── core failure paths ──────────────────────────────────────────────

  it('rejects unexpected tool name with internal error', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: vi.fn(),
    });
    const r = await dispatch({
      threadId: 't',
      turnId: 'tr',
      callId: 'c1',
      tool: 'not_the_tool',
      arguments: JSON.stringify({ state: 'a', exit: 'go', data: { inc: 1 } }),
    });
    expect(r.success).toBe(false);
    const text = r.contentItems[0]?.type === 'inputText' ? r.contentItems[0].text : '';
    expect(text).toMatch(/unexpected tool name/);
    expect(host.currentStateId()).toBe('a');
  });

  it('off-state submit is rejected with retry message; actor not mutated', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const flush = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: flush,
    });
    const r = await dispatch(
      call(JSON.stringify({ state: 'WRONG', exit: 'go', data: { inc: 1 } })),
    );
    expect(r.success).toBe(false);
    const text = r.contentItems[0]?.type === 'inputText' ? r.contentItems[0].text : '';
    expect(text).toMatch(/Off-state submit/);
    expect(text).toContain("'a'");
    expect(text).toContain("'WRONG'");
    expect(publicFailureSummary(r)).toContain('Off-state submit');
    expect(JSON.stringify(r)).not.toContain('publicSubmitFailureMetadata');
    expect(host.currentStateId()).toBe('a');
    expect(flush).not.toHaveBeenCalled();
  });

  it('off-exit submit is rejected; actor not mutated', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const flush = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: flush,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'NOT_AN_EXIT', data: {} })));
    expect(r.success).toBe(false);
    const text = r.contentItems[0]?.type === 'inputText' ? r.contentItems[0].text : '';
    expect(text).toMatch(/Off-exit submit/);
    expect(text).toContain("'a'");
    expect(text).toContain("'NOT_AN_EXIT'");
    expect(publicFailureSummary(r)).toBe(
      "Off-exit submit. State 'a' has no submit exit named 'NOT_AN_EXIT'.",
    );
    expect(host.currentStateId()).toBe('a');
    expect(flush).not.toHaveBeenCalled();
  });

  it('schema-invalid data is rejected with humanized ajv errors; actor not mutated', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const flush = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: flush,
    });
    const r = await dispatch(
      call(JSON.stringify({ state: 'a', exit: 'go', data: { inc: 'oops' } })),
    );
    expect(r.success).toBe(false);
    const text = r.contentItems[0]?.type === 'inputText' ? r.contentItems[0].text : '';
    expect(publicFailureSummary(r)).toContain('Schema validation failed');
    expect(text).toMatch(/Schema validation failed/);
    expect(text).toContain('data.inc must be number');
    expect(host.currentStateId()).toBe('a');
    expect(flush).not.toHaveBeenCalled();
  });

  it('JSON parse failure replies with error; actor not mutated', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const flush = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: flush,
    });
    const r = await dispatch(call('{not json'));
    expect(r.success).toBe(false);
    const text = r.contentItems[0]?.type === 'inputText' ? r.contentItems[0].text : '';
    expect(text).toMatch(/parse/i);
    expect(host.currentStateId()).toBe('a');
    expect(flush).not.toHaveBeenCalled();
  });

  it('accepts already-parsed-object arguments (JsonValue not necessarily a string)', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: vi.fn(),
    });
    const r = await dispatch(
      call({
        state: 'a',
        exit: 'go',
        data: { inc: 2 },
      } as unknown as DynamicToolCallParams['arguments']),
    );
    expect(r.success).toBe(true);
    expect(host.currentStateId()).toBe('b');
  });

  // ─── self-loop happy path ────────────────────────────────────────────

  it('self-loop success → reply terse "ok"; legacy flush hook runs BEFORE reply; transition logged', async () => {
    const { host, machine } = makeSelfLoopHost();
    const events: string[] = [];
    const flush = vi.fn(() => {
      events.push('flush');
    });
    const onTransition = vi.fn((info: { from: string; exit: string; to: string }) => {
      events.push(`transition:${info.from}->${info.to}`);
    });
    const onTerminal = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfLoop,
      flushSnapshot: flush,
      onTransition,
      onTerminal,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'again', data: { inc: 3 } })));
    events.push('dispatch-resolved');
    expect(r.success).toBe(true);
    expect(r.contentItems).toEqual([{ type: 'inputText', text: 'ok' }]);
    expect(host.currentStateId()).toBe('a');
    // Legacy compatibility: the optional flush hook runs BEFORE the reply.
    expect(events[0]).toBe('flush');
    expect(events).toContain('dispatch-resolved');
    expect(events.indexOf('flush')).toBeLessThan(events.indexOf('dispatch-resolved'));
    expect(onTransition).toHaveBeenCalledWith({ from: 'a', exit: 'again', to: 'a' });
    expect(onTerminal).not.toHaveBeenCalled();
    // Context advanced (the assign action ran).
    expect((host.currentContext() as Ctx).count).toBe(3);
  });

  // ─── terminal happy path ─────────────────────────────────────────────

  it('terminal success → reply "Run complete. Terminal: success."; onTerminal fires; legacy flush hook runs', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const flush = vi.fn();
    const onTerminal = vi.fn();
    const onTransition = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: flush,
      onTerminal,
      onTransition,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: { inc: 1 } })));
    expect(r.success).toBe(true);
    expect(r.contentItems).toEqual([
      { type: 'inputText', text: 'Run complete. Terminal: success.' },
    ]);
    expect(host.currentStateId()).toBe('b');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith('b');
    expect(onTransition).toHaveBeenCalledWith({ from: 'a', exit: 'go', to: 'b' });
  });

  it('canonical routed submit commits the same branch selected during pre-commit preparation', async () => {
    const machine = buildCanonicalRoutedMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCanonicalRouted,
      flushSnapshot: vi.fn(),
    });

    const r = await dispatch(
      call(JSON.stringify({ state: 'a', exit: 'go', data: { chooseFirst: true } })),
    );

    expect(r.success).toBe(true);
    expect(host.currentStateId()).toBe('b');
    expect(host.currentContext()).toMatchObject({ branch: 'first' });
  });

  it('canonical routed submit final artifacts and commit preserve low-level actions before reducers', async () => {
    const fsm = createFsm<{ count: number; marks: string[] }>();
    const machine = fsm.machine({
      id: 'm',
      initial: 'a',
      data: () => ({ count: 1, marks: [] }),
      states: {
        a: fsm.state({
          prompt: 'route',
          on: {
            go: fsm.submit<{ accepted: boolean; multiplier: number }>({
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
                { to: 'done' },
              ],
            }),
          },
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const writeFinalArtifacts = vi.fn(async (_terminalStateId: string, context) => {
      expect(host.currentStateId()).toBe('a');
      expect(context).toMatchObject({
        count: 22,
        marks: ['action:1', 'reduce:11'],
      });
    });
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: {
        a: {
          go: {
            jsonSchema: { type: 'object' },
            validate: (input: unknown) => ({ ok: true, data: input }),
          },
        },
      },
      flushSnapshot: vi.fn(),
      writeFinalArtifacts,
    });

    const result = await dispatch(
      call(
        JSON.stringify({
          state: 'a',
          exit: 'go',
          data: { accepted: true, multiplier: 2 },
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(writeFinalArtifacts).toHaveBeenCalledTimes(1);
    expect(host.currentStateId()).toBe('done');
    expect(host.currentContext()).toMatchObject({
      count: 22,
      marks: ['action:1', 'reduce:11'],
    });
  });

  it('rejects canonical submit effects without leaking nested context mutations', async () => {
    const machine = buildCanonicalFailingSubmitEffectMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCanonicalNested,
      flushSnapshot: vi.fn(),
    });

    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } })));

    expect(r.success).toBe(false);
    expect(r.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: expect.stringContaining('submit exploded'),
    });
    expect(publicFailureSummary(r)).toBeUndefined();
    expect(host.currentStateId()).toBe('a');
    expect(host.currentContext()).toMatchObject({ nested: { marks: [] } });
  });

  it('rejects canonical route predicates without leaking nested context mutations', async () => {
    const machine = buildCanonicalFailingRoutePredicateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCanonicalNested,
      flushSnapshot: vi.fn(),
    });

    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } })));

    expect(r.success).toBe(false);
    expect(r.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: expect.stringContaining('predicate exploded'),
    });
    expect(host.currentStateId()).toBe('a');
    expect(host.currentContext()).toMatchObject({ nested: { marks: [] } });
  });

  it('rejects canonical route effects without leaking nested context mutations', async () => {
    const machine = buildCanonicalFailingRouteEffectMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCanonicalNested,
      flushSnapshot: vi.fn(),
    });

    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: { ok: true } })));

    expect(r.success).toBe(false);
    expect(r.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: expect.stringContaining('route effect exploded'),
    });
    expect(host.currentStateId()).toBe('a');
    expect(host.currentContext()).toMatchObject({ nested: { marks: [] } });
  });

  it('preflights canonical embedded child-final effect and reducer before committing a submit into the child final', async () => {
    const events: string[] = [];
    const machine = buildCanonicalSubmitEmbeddedMachine(events);
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn(() => {
      events.push(`flush:${host.currentStateId()}:${host.currentContext().childSummary ?? 'none'}`);
    });
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCanonicalEmbeddedSubmit,
      flushSnapshot,
      composeActiveStateNudge: () => 'child nudge',
      scheduleCrossStateDance: vi.fn(),
    });

    await dispatch(call(JSON.stringify({ state: 'start', exit: 'go', data: {} })));
    events.length = 0;
    const result = await dispatch(
      call(JSON.stringify({ state: 'child.compose', exit: 'finish', data: { summary: 'draft' } })),
    );

    expect(result.success).toBe(true);
    expect(host.currentStateId()).toBe('done');
    expect(host.currentContext()).toMatchObject({
      childSummary: 'draft',
      marks: ['auth'],
    });
    expect(events).toEqual([
      'effect:start:none:draft',
      'effect:after-async',
      'reduce:draft',
      'flush:done:draft',
    ]);
  });

  it('does not commit a submit into an embedded child final when its canonical effect rejects', async () => {
    const events: string[] = [];
    const machine = buildCanonicalSubmitEmbeddedMachine(events, 'bad');
    const host = new ActorHost(machine, undefined);
    host.start();
    const flushSnapshot = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCanonicalEmbeddedSubmit,
      flushSnapshot,
      composeActiveStateNudge: () => 'child nudge',
      scheduleCrossStateDance: vi.fn(),
    });

    await dispatch(call(JSON.stringify({ state: 'start', exit: 'go', data: {} })));
    flushSnapshot.mockClear();
    events.length = 0;
    const result = await dispatch(
      call(JSON.stringify({ state: 'child.compose', exit: 'finish', data: { summary: 'bad' } })),
    );

    expect(result.success).toBe(false);
    expect(result.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: expect.stringContaining('canonical embed effect failed'),
    });
    expect(host.currentStateId()).toBe('child.compose');
    expect(host.currentContext()).toMatchObject({ childSummary: null, marks: [] });
    expect(events).toEqual(['effect:start:none:bad', 'effect:after-async']);
    expect(flushSnapshot).not.toHaveBeenCalled();
  });

  it('writes canonical final artifacts before committing terminal submit success', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const writeFinalArtifacts = vi.fn(async (_terminalStateId: string, context) => {
      expect(host.currentStateId()).toBe('a');
      expect(context).toMatchObject({ count: 1 });
    });
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: vi.fn(),
      writeFinalArtifacts,
    });

    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: { inc: 1 } })));

    expect(r.success).toBe(true);
    expect(writeFinalArtifacts).toHaveBeenCalledWith('b', expect.objectContaining({ count: 1 }));
    expect(host.currentStateId()).toBe('b');
  });

  it('rejects terminal submit without committing when canonical final artifact writes fail', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: vi.fn(),
      onTerminal: vi.fn(),
      writeFinalArtifacts: vi.fn(async () => {
        expect(host.currentStateId()).toBe('a');
        throw new Error('disk full');
      }),
    });

    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: { inc: 1 } })));

    expect(r.success).toBe(false);
    expect(r.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: expect.stringContaining('disk full'),
    });
    expect(host.currentStateId()).toBe('a');
    expect(host.currentContext()).toMatchObject({ count: 0 });
  });

  // ─── Phase 2a cross-state happy path ─────────────────────────────────

  it('cross-state submit returns "ok" reply', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const flush = vi.fn();
    const composeActiveStateNudge = vi.fn(
      () => '[aharness] Now in state "b"\n\nValid exits:\n  back: object\n\nin b',
    );
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: flush,
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    expect(r.success).toBe(true);
    expect(r.contentItems).toEqual([{ type: 'inputText', text: 'ok' }]);
    expect(host.currentStateId()).toBe('b');
  });

  it('cross-state submit commits before legacy flush hook, composeActiveStateNudge, and scheduleCrossStateDance', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const events: string[] = [];
    // Observing the live host inside each callback proves that commit
    // already ran before the legacy flush hook, before compose (the
    // compose-time read sees the new leaf), and before schedule.
    const flush = vi.fn(() => {
      events.push(`flush:${host.currentStateId()}`);
    });
    const composeActiveStateNudge = vi.fn(() => {
      events.push(`compose:${host.currentStateId()}`);
      return 'nudge-text';
    });
    const scheduleCrossStateDance = vi.fn(() => {
      events.push(`schedule:${host.currentStateId()}`);
    });
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: flush,
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    expect(host.currentStateId()).toBe('a');
    await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    // All three callbacks observe the new leaf — commit ran first.
    // Ordering: flush before compose before schedule.
    expect(events).toEqual(['flush:b', 'compose:b', 'schedule:b']);
  });

  it('cross-state submit awaits onEntry before scheduling or replying', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const events: string[] = [];
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: () => {
        events.push('flush:transition');
      },
      runOnEntry: async () => {
        events.push('onEntry');
      },
      composeActiveStateNudge: () => {
        events.push('compose');
        return 'nudge-text';
      },
      scheduleCrossStateDance: () => {
        events.push('schedule');
      },
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    events.push('reply-observed');

    expect(r.success).toBe(true);
    expect(events).toEqual([
      'flush:transition',
      'onEntry',
      'compose',
      'schedule',
      'reply-observed',
    ]);
  });

  it('cross-state submit into clearOnEntry schedules fresh clear after the submit reply instead of the cross-state dance', async () => {
    const machine = buildCrossStateClearOnEntryMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const events: string[] = [];
    const afterReplyCallbacks: Array<() => void | Promise<void>> = [];
    const scheduleCrossStateDance = vi.fn(() => {
      events.push('dance');
    });
    const composeActiveStateNudge = vi.fn(() => 'must-not-compose');
    const scheduleFreshClear = vi.fn(
      (request: {
        readonly from: string;
        readonly to: string;
        readonly oldThreadId: string;
        readonly oldTurnId?: string;
        readonly afterReply: (callback: () => void | Promise<void>) => void;
      }) => {
        events.push(
          `fresh:${request.from}->${request.to}:${request.oldThreadId}:${request.oldTurnId}`,
        );
        request.afterReply(() => {
          events.push('fresh-after-reply');
        });
      },
    );
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: () => {
        events.push(`flush:${host.currentStateId()}`);
      },
      runOnEntry: async () => {
        events.push('onEntry');
      },
      composeActiveStateNudge,
      scheduleCrossStateDance,
      scheduleFreshClear,
    });

    const r = await dispatch(
      {
        threadId: 'thread-old',
        turnId: 'turn-old',
        callId: 'cid-1',
        tool: 'aharness_submit',
        arguments: JSON.stringify({ state: 'a', exit: 'go', data: {} }),
      },
      {
        requestId: 'req-1',
        afterReply(callback) {
          afterReplyCallbacks.push(callback);
        },
      },
    );
    events.push('reply-observed');
    await afterReplyCallbacks[0]?.();

    expect(r.success).toBe(true);
    expect(r.contentItems).toEqual([{ type: 'inputText', text: 'ok' }]);
    expect(host.currentStateId()).toBe('b');
    expect(composeActiveStateNudge).not.toHaveBeenCalled();
    expect(scheduleCrossStateDance).not.toHaveBeenCalled();
    expect(scheduleFreshClear).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'flush:b',
      'onEntry',
      'fresh:a->b:thread-old:turn-old',
      'reply-observed',
      'fresh-after-reply',
    ]);
  });

  it('cross-state submit into clearOnEntry cwd object schedules fresh clear', async () => {
    const machine = buildCrossStateClearOnEntryMachine({ clearOnEntry: { cwd: '/abs/worktree' } });
    const host = new ActorHost(machine, undefined);
    host.start();
    const scheduleFreshClear = vi.fn();
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge: vi.fn(() => 'must-not-compose'),
      scheduleCrossStateDance,
      scheduleFreshClear,
    });

    const r = await dispatch(
      {
        threadId: 'thread-old',
        turnId: 'turn-old',
        callId: 'cid-1',
        tool: 'aharness_submit',
        arguments: JSON.stringify({ state: 'a', exit: 'go', data: {} }),
      },
      {
        requestId: 'req-1',
        afterReply: vi.fn(),
      },
    );

    expect(r.success).toBe(true);
    expect(host.currentStateId()).toBe('b');
    expect(scheduleFreshClear).toHaveBeenCalledTimes(1);
    expect(scheduleCrossStateDance).not.toHaveBeenCalled();
  });

  it('cross-state submit into state-level model object schedules fresh clear', async () => {
    const machine = buildCrossStateClearOnEntryMachine({
      model: {
        name: 'gpt-5.1-codex',
        effort: 'high',
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const scheduleFreshClear = vi.fn();
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge: vi.fn(() => 'must-not-compose'),
      scheduleCrossStateDance,
      scheduleFreshClear,
    });

    const r = await dispatch(
      {
        threadId: 'thread-old',
        turnId: 'turn-old',
        callId: 'cid-1',
        tool: 'aharness_submit',
        arguments: JSON.stringify({ state: 'a', exit: 'go', data: {} }),
      },
      {
        requestId: 'req-1',
        afterReply: vi.fn(),
      },
    );

    expect(r.success).toBe(true);
    expect(host.currentStateId()).toBe('b');
    expect(scheduleFreshClear).toHaveBeenCalledTimes(1);
    expect(scheduleCrossStateDance).not.toHaveBeenCalled();
  });

  it('submit failure paths do not call runOnEntry', async () => {
    const { host, machine } = makeSelfTerminalHost();
    const runOnEntry = vi.fn(async () => undefined);
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarSelfTerminal,
      flushSnapshot: vi.fn(),
      runOnEntry,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'WRONG', exit: 'go', data: {} })));
    expect(r.success).toBe(false);
    expect(runOnEntry).not.toHaveBeenCalled();
  });

  it('cross-state submit calls composeActiveStateNudge() AFTER commit so the live host is at the new leaf', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    let capturedStateId: string | undefined;
    const composeActiveStateNudge = vi.fn(() => {
      // Read the live host inside the compose callback — must reflect
      // the post-commit (target) leaf.
      capturedStateId = host.currentStateId();
      return 'nudge-text';
    });
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    expect(capturedStateId).toBe('b');
  });

  it('cross-state submit invokes scheduleCrossStateDance with {threadId, turnId, callId, orientationText} where orientationText is the composeActiveStateNudge return value', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const composedNudge = '[aharness] Now in state "b"\n\nValid exits:\n  back: object\n\nin b';
    const composeActiveStateNudge = vi.fn(() => composedNudge);
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    await dispatch({
      threadId: 'thr-1',
      turnId: 'tur-1',
      callId: 'cid-1',
      tool: 'aharness_submit',
      arguments: JSON.stringify({ state: 'a', exit: 'go', data: {} }),
    });
    expect(scheduleCrossStateDance).toHaveBeenCalledTimes(1);
    expect(scheduleCrossStateDance).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thr-1',
        turnId: 'tur-1',
        callId: 'cid-1',
        orientationText: composedNudge,
      }),
    );
  });

  it('cross-state submit passes applyStateModel callback through to scheduleCrossStateDance', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const composeActiveStateNudge = vi.fn(() => 'nudge-text');
    const applyStateModel = vi.fn(async () => undefined);
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge,
      applyStateModel,
      scheduleCrossStateDance,
    });
    await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    expect(scheduleCrossStateDance).toHaveBeenCalledTimes(1);
    const arg = scheduleCrossStateDance.mock.calls[0]![0] as {
      applyStateModel?: () => Promise<void>;
    };
    expect(arg.applyStateModel).toBeDefined();
    expect(arg.applyStateModel).toEqual(expect.any(Function));
  });

  it('cross-state submit without scheduleCrossStateDance opt throws "crossStateDance not wired"', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const composeActiveStateNudge = vi.fn(() => 'nudge-text');
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge,
      // scheduleCrossStateDance intentionally omitted
    });
    await expect(
      dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} }))),
    ).rejects.toThrow(/crossStateDance not wired/);
  });

  it('cross-state submit where composeActiveStateNudge throws → reply "ok", dance scheduled with fallback nudge, legacy flush hook already ran', async () => {
    // F2 defense-in-depth (plan `2026-05-13-headless-phase-2a-followups.md`
    // Task 3): a throw between commit and reply would violate the
    // dispatcher success contract. The dispatcher wraps
    // `composeActiveStateNudge()` so the throw becomes a fallback nudge
    // string; the cross-state path still reaches the dance and still
    // replies `'ok'`.
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const flush = vi.fn();
    const composeActiveStateNudge = vi.fn(() => {
      throw new Error('boom');
    });
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: flush,
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    // (1) reply is the same `'ok'` text the success path produces.
    expect(r.success).toBe(true);
    expect(r.contentItems).toEqual([{ type: 'inputText', text: 'ok' }]);
    // (2) legacy flush hook already ran; it fires BEFORE compose, so
    // external legacy observers see post-commit state regardless of the
    // throw.
    expect(flush).toHaveBeenCalledTimes(1);
    // (3) dance invoked exactly once with fallback orientation text
    // matching the documented shape.
    expect(scheduleCrossStateDance).toHaveBeenCalledTimes(1);
    const arg = scheduleCrossStateDance.mock.calls[0]![0] as {
      orientationText: string;
    };
    expect(arg.orientationText).toMatch(
      /^\(aharness: error composing nudge for state '[^']+': boom\)$/,
    );
    expect(arg.orientationText).toContain("'b'");
    // Actor advanced to the new leaf — commit was not rolled back.
    expect(host.currentStateId()).toBe('b');
  });

  it('cross-state submit without composeActiveStateNudge opt throws "composeActiveStateNudge not wired"', async () => {
    const machine = buildCrossStateMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossState,
      flushSnapshot: vi.fn(),
      // composeActiveStateNudge intentionally omitted
      scheduleCrossStateDance,
    });
    await expect(
      dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} }))),
    ).rejects.toThrow(/composeActiveStateNudge not wired/);
    // composeActiveStateNudge throws BEFORE the dance is invoked, but
    // AFTER commit + flush (the throw lives between the post-commit
    // signal and the dance dispatch). scheduleCrossStateDance must NOT
    // have been invoked.
    expect(scheduleCrossStateDance).not.toHaveBeenCalled();
  });

  // ─── Phase 2b cross-state into awaitsOwnerText ──────────────────────

  it('cross-state submit into a state with awaitsOwnerText commits and schedules the dance', async () => {
    // Plan `2026-05-13-headless-phase-2b-owner-yield.md` Task 6: the
    // pre-commit awaitsOwnerText throw is gone — a cross-state target
    // declaring awaitsOwnerText now follows the same dance path as a
    // non-yielding target. `composeStateNudge` (run inside the
    // production `composeActiveStateNudge` closure) prepends the
    // `request_user_input` preamble carrying the verbatim
    // `messageToUser`. Here we wire `composeActiveStateNudge` to the
    // real `composeStateNudge` so the test exercises the same path the
    // runtime uses; pinning on the verbatim `messageToUser` substring
    // (rather than on preamble wording) keeps the assertion resilient
    // to harmless preamble rewordings.
    const machine = buildCrossStateAwaitsOwnerTextMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const flush = vi.fn();
    const composeActiveStateNudge = vi.fn(() =>
      composeStateNudge({
        stateId: 'b',
        exits: [{ kind: 'submit', name: 'done', schema: { type: 'object' } }],
        entryPromptText: 'in b',
        awaitsOwnerText: { messageToUser: 'what is your name?' },
      }),
    );
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossStateAwaits,
      flushSnapshot: flush,
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    await dispatch(call(JSON.stringify({ state: 'a', exit: 'next', data: {} })));
    // commit ran and the actor advanced to the awaitsOwnerText leaf.
    expect(host.currentStateId()).toBe('b');
    // Legacy compatibility: the flush hook ran before the dance was scheduled.
    expect(flush).toHaveBeenCalledTimes(1);
    // composeActiveStateNudge invoked exactly once (post-commit).
    expect(composeActiveStateNudge).toHaveBeenCalledTimes(1);
    // Dance scheduled exactly once; orientationText is the composed
    // nudge verbatim — proven by the presence of the author-supplied
    // messageToUser substring.
    expect(scheduleCrossStateDance).toHaveBeenCalledTimes(1);
    const arg = scheduleCrossStateDance.mock.calls[0]![0] as {
      orientationText: string;
    };
    expect(arg.orientationText).toContain('what is your name?');
  });

  it('cross-state submit into awaitsOwnerText still replies "ok"', async () => {
    // The dispatcher's reply text is unaffected by the target's
    // awaitsOwnerText declaration: cross-state submits always reply
    // terse `'ok'`. The dance owns the subsequent turn/start that
    // surfaces the new state's nudge (with the request_user_input
    // preamble) to the model.
    const machine = buildCrossStateAwaitsOwnerTextMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const composeActiveStateNudge = vi.fn(() =>
      composeStateNudge({
        stateId: 'b',
        exits: [{ kind: 'submit', name: 'done', schema: { type: 'object' } }],
        entryPromptText: 'in b',
        awaitsOwnerText: { messageToUser: 'what is your name?' },
      }),
    );
    const scheduleCrossStateDance = vi.fn();
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarCrossStateAwaits,
      flushSnapshot: vi.fn(),
      composeActiveStateNudge,
      scheduleCrossStateDance,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'next', data: {} })));
    expect(r.success).toBe(true);
    expect(r.contentItems).toEqual([{ type: 'inputText', text: 'ok' }]);
  });

  // ─── passive submit target ───────────────────────────────────────────

  it('rejects submit whose target is a passive state; actor not mutated; legacy flush hook not called', async () => {
    const machine = buildPassiveTargetMachine();
    const host = new ActorHost(machine, undefined);
    host.start();
    const flush = vi.fn();
    const onTerminal = vi.fn();
    const onTransition = vi.fn();
    const commitSpy = vi.spyOn(host, 'commitSubmit');
    const dispatch = createSubmitDispatcher({
      host,
      machine,
      sidecar: sidecarPassiveTarget,
      flushSnapshot: flush,
      onTerminal,
      onTransition,
    });
    const r = await dispatch(call(JSON.stringify({ state: 'a', exit: 'go', data: {} })));
    expect(r.success).toBe(false);
    const text = r.contentItems[0]?.type === 'inputText' ? r.contentItems[0].text : '';
    // The error names the offending target state and explains the
    // passive-cannot-be-submit-target rule from the model's perspective.
    expect(text).toContain("'b'");
    expect(text).toContain("'go'");
    expect(text).toContain("'a'");
    expect(text).toMatch(/passive/i);
    expect(text).toMatch(/submit/i);
    // No commit, no legacy flush hook, no transition log, no terminal signal.
    // The actor remains on state `a`.
    expect(commitSpy).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(onTransition).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(host.currentStateId()).toBe('a');
  });
});
