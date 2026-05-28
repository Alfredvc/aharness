/**
 * Tests for `runtime/hookDispatchers.ts` — the per-state codex hook
 * dispatcher factory.
 *
 * Spec: docs/specs/2026-05-08-per-state-hooks-design.md §5.6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsm, exit, aharness, state, terminal } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import { createPerStateHookDispatcher } from '../src/runtime/hookDispatchers.js';
import { makeSerializeDispatch } from '../src/runtime/serializeDispatch.js';

const baseEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'parentT',
  cwd: '/tmp',
  transcript_path: null,
  model: 'm',
  permission_mode: 'default',
  turn_id: 't1',
  tool_name: 'Bash',
  tool_use_id: 'u1',
  tool_input: {},
  triggered_at: '2026-05-08T00:00:00Z',
};

function buildHost(hookConfig: Record<string, unknown> | undefined): ActorHost {
  const machine = aharness.machine({
    id: 'm',
    initial: 's',
    states: {
      s: state({
        entryPrompt: 'p',
        exits: { go: exit<{ x: number }>({ to: 'done' }) },
        ...(hookConfig !== undefined ? { hooks: hookConfig } : {}),
      } as never),
      done: terminal('success'),
    },
  });
  const h = new ActorHost(machine, undefined, {
    runId: 'r',
    runDir: {
      runId: 'r',
      root: '/tmp',
      snapshotPath: '/tmp/s',
      eventsPath: '/tmp/e',
      artifactsDir: '/tmp/a',
    },
  });
  h.start();
  return h;
}

function activeThread(threadId = 'parentT') {
  return createActiveThreadBinding(threadId);
}

interface CanonicalHookCtx {
  count: number;
  notes: string[];
}

function buildCanonicalHookHost(
  on: Parameters<ReturnType<typeof createFsm<CanonicalHookCtx>>['state']>[0]['on'],
): ActorHost {
  const fsm = createFsm<CanonicalHookCtx>();
  const machine = fsm.machine({
    id: 'm',
    initial: 's',
    data: { count: 0, notes: [] },
    states: {
      s: fsm.state({
        prompt: 'p',
        on,
      }),
      done: fsm.final({ outcome: 'success' }),
    },
  });
  const h = new ActorHost(machine, undefined);
  h.start();
  return h;
}

describe('createPerStateHookDispatcher — PreToolUse deny aggregation', () => {
  it('returns deny when the only matched author handler denies', async () => {
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Bash$',
          handler: () => ({
            hookSpecificOutput: {
              permissionDecision: 'deny' as const,
              permissionDecisionReason: 'no bash',
            },
          }),
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const reply = await dispatch(JSON.stringify(baseEvent));
    expect(reply.status).toBe('OK');
    const body = JSON.parse(reply.body) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe('no bash');
  });

  it('runs every matching handler concurrently and lets deny win regardless of resolution order', async () => {
    const calls: string[] = [];
    let releaseDeny!: () => void;
    const denyReady = new Promise<void>((res) => {
      releaseDeny = res;
    });
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Bash$',
          handler: async () => {
            calls.push('deny-start');
            await denyReady;
            calls.push('deny-end');
            return {
              hookSpecificOutput: {
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'deny from slow handler',
              },
            };
          },
        },
        {
          matcher: '^Bash$',
          handler: () => {
            calls.push('allow');
            return {
              hookSpecificOutput: {
                permissionDecision: 'allow' as const,
              },
            };
          },
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const pending = dispatch(JSON.stringify(baseEvent));
    await vi.waitFor(() => expect(calls).toEqual(['deny-start', 'allow']));
    releaseDeny();
    const reply = await pending;
    expect(reply.status).toBe('OK');
    expect(calls).toEqual(['deny-start', 'allow', 'deny-end']);
    expect(JSON.parse(reply.body)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'deny from slow handler',
      },
    });
  });

  it('returns empty body when no matcher hits', async () => {
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Edit$',
          handler: () => ({
            hookSpecificOutput: { permissionDecision: 'deny' as const },
          }),
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const reply = await dispatch(JSON.stringify(baseEvent));
    expect(JSON.parse(reply.body)).toEqual({});
  });
});

describe('createPerStateHookDispatcher — canonical built-in hook events', () => {
  it('dispatches preToolUse through the selected canonical transition and returns after snapshot flush', async () => {
    const events: string[] = [];
    const host = buildCanonicalHookHost({
      preToolUse: {
        match: '^Bash$',
        reduce: (draft, event) => {
          draft.count += 1;
          draft.notes = [...draft.notes, event.toolName];
          events.push(`reduce:${draft.count}`);
        },
        return: (data, event) => {
          events.push(`return:${data.count}:${event.toolName}`);
          return {
            hookSpecificOutput: {
              permissionDecision: 'deny',
              permissionDecisionReason: `count ${data.count}`,
            },
          };
        },
      },
    });
    const flushSnapshot = vi.fn(() => {
      events.push(`flush:${host.currentContext().count}`);
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot,
    });

    const reply = await dispatch(JSON.stringify(baseEvent));

    expect(reply.status).toBe('OK');
    expect(JSON.parse(reply.body)).toEqual({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'count 1',
      },
    });
    expect(events).toEqual(['reduce:1', 'flush:1', 'return:1:Bash']);
  });

  it('reports committed canonical hook transitions after snapshot flush', async () => {
    const events: string[] = [];
    const fsm = createFsm<CanonicalHookCtx>();
    const machine = fsm.machine({
      id: 'm',
      initial: 's',
      data: { count: 0, notes: [] },
      states: {
        s: fsm.state({
          prompt: 'p',
          on: {
            preToolUse: {
              match: '^Bash$',
              to: 'next',
              reduce: (draft) => {
                draft.count += 1;
              },
              return: () => ({}),
            },
          },
        }),
        next: fsm.state({
          prompt: 'next',
          on: {
            preToolUse: {
              return: () => ({}),
            },
          },
        }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot: () => {
        events.push(`flush:${host.currentStateId()}`);
      },
      onCommittedTransition: (info) => {
        events.push(`committed:${info.from}->${info.to}`);
      },
    });

    await dispatch(JSON.stringify(baseEvent));

    expect(events).toEqual(['flush:next', 'committed:s->next']);
  });

  it('uses the selected postToolUse route branch as the hook response owner', async () => {
    const predicate = vi.fn(
      (_data: Readonly<CanonicalHookCtx>, event: { readonly toolResponse: unknown }) =>
        event.toolResponse === 'block',
    );
    const host = buildCanonicalHookHost({
      postToolUse: {
        match: '^Bash$',
        route: [
          {
            if: predicate,
            return: () => ({
              decision: 'block',
              reason: 'blocked by route',
              hookSpecificOutput: { additionalContext: 'route context' },
            }),
          },
          {
            return: () => ({
              hookSpecificOutput: { additionalContext: 'catch-all context' },
            }),
          },
        ],
      },
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PostToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot: vi.fn(),
    });

    const reply = await dispatch(
      JSON.stringify({
        ...baseEvent,
        hook_event_name: 'PostToolUse',
        tool_response: 'block',
      }),
    );

    expect(JSON.parse(reply.body)).toEqual({
      decision: 'block',
      reason: 'blocked by route',
      hookSpecificOutput: { additionalContext: 'route context' },
    });
    expect(predicate).toHaveBeenCalledTimes(1);
  });

  it('falls back to legacy hook aggregation when canonical match prefilter misses', async () => {
    const fsm = createFsm<{ count: number }>();
    const legacy = vi.fn(() => ({
      hookSpecificOutput: {
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'legacy response',
      },
    }));
    const machine = fsm.machine({
      id: 'm',
      initial: 's',
      data: { count: 0 },
      states: {
        s: {
          ...fsm.state({
            prompt: 'p',
            on: {
              preToolUse: {
                match: '^Edit$',
                return: () => ({
                  hookSpecificOutput: { permissionDecision: 'allow' as const },
                }),
              },
            },
          }),
          meta: {
            aharness: {
              ...fsm.state({
                prompt: 'p',
                on: {
                  preToolUse: {
                    match: '^Edit$',
                    return: () => ({
                      hookSpecificOutput: { permissionDecision: 'allow' as const },
                    }),
                  },
                },
              }).meta.aharness,
              hooks: { preToolUse: [{ matcher: '^Bash$', handler: legacy }] },
            },
          },
        },
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot: vi.fn(),
    });

    const reply = await dispatch(JSON.stringify(baseEvent));

    expect(JSON.parse(reply.body)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'legacy response',
      },
    });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('returns the hook no-decision default when no canonical or legacy handler is selected', async () => {
    const host = buildCanonicalHookHost({
      preToolUse: {
        match: '^Edit$',
        return: () => ({
          hookSpecificOutput: { permissionDecision: 'deny' as const },
        }),
      },
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot: vi.fn(),
    });

    const reply = await dispatch(JSON.stringify(baseEvent));

    expect(JSON.parse(reply.body)).toEqual({});
  });

  it('does not fall back to legacy aggregation after a canonical handler is selected', async () => {
    const fsm = createFsm<{ count: number }>();
    const legacy = vi.fn(() => ({
      hookSpecificOutput: {
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'legacy response',
      },
    }));
    const canonicalState = fsm.state({
      prompt: 'p',
      on: {
        preToolUse: {
          match: '^Bash$',
          reduce: () => {
            throw new Error('canonical failed');
          },
          return: () => ({
            hookSpecificOutput: { permissionDecision: 'allow' as const },
          }),
        },
      },
    });
    const machine = fsm.machine({
      id: 'm',
      initial: 's',
      data: { count: 0 },
      states: {
        s: {
          ...canonicalState,
          meta: {
            aharness: {
              ...canonicalState.meta.aharness,
              hooks: { preToolUse: [{ matcher: '^Bash$', handler: legacy }] },
            },
          },
        },
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot: vi.fn(),
    });

    const reply = await dispatch(JSON.stringify(baseEvent));

    expect(JSON.parse(reply.body)).toEqual({});
    expect(legacy).not.toHaveBeenCalled();
  });

  it('returns userPromptSubmit additional context from the selected canonical request transition', async () => {
    const host = buildCanonicalHookHost({
      userPromptSubmit: {
        return: (_data, event) => ({
          hookSpecificOutput: { additionalContext: `prompt:${event.prompt}` },
        }),
      },
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'UserPromptSubmit',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot: vi.fn(),
    });

    const reply = await dispatch(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'parentT',
        cwd: '/tmp',
        transcript_path: null,
        model: 'm',
        permission_mode: 'default',
        turn_id: 't1',
        prompt: 'hi',
        triggered_at: '2026-05-08T00:00:00Z',
      }),
    );

    expect(JSON.parse(reply.body)).toEqual({
      hookSpecificOutput: { additionalContext: 'prompt:hi' },
    });
  });

  it('reports canonical preToolUse final artifact failures and returns the default before commit', async () => {
    const host = buildCanonicalHookHost({
      preToolUse: {
        match: '^Bash$',
        to: 'done',
        reduce: (draft) => {
          draft.count = 9;
        },
        return: () => ({
          hookSpecificOutput: { permissionDecision: 'allow' as const },
        }),
      },
    });
    const flushSnapshot = vi.fn();
    const onTerminal = vi.fn();
    const onCanonicalEventError = vi.fn();
    const writeFinalArtifacts = vi.fn(async () => {
      throw new Error('disk full');
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
      onCanonicalEventError,
    });

    await expect(dispatch(JSON.stringify(baseEvent))).resolves.toEqual({
      status: 'OK',
      body: '{}',
    });
    expect(writeFinalArtifacts).toHaveBeenCalledWith('done', expect.objectContaining({ count: 9 }));
    expect(onCanonicalEventError).toHaveBeenCalledWith({
      eventName: 'preToolUse',
      stateId: 's',
      branchIndex: 0,
      phase: 'transition',
      error: expect.objectContaining({ message: 'disk full' }),
    });
    expect(host.currentStateId()).toBe('s');
    expect(host.currentContext().count).toBe(0);
    expect(flushSnapshot).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });
});

describe('createPerStateHookDispatcher — broad tool matchers', () => {
  it('invokes a broad matcher for legacy MCP-looking tool names', async () => {
    const handler = vi.fn(() => ({
      hookSpecificOutput: {
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'broad matcher saw it',
      },
    }));
    const host = buildHost({
      preToolUse: [{ matcher: '.*', handler }],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const reply = await dispatch(
      JSON.stringify({ ...baseEvent, tool_name: 'mcp__aharness_fsm__submit' }),
    );
    expect(JSON.parse(reply.body)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'broad matcher saw it',
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('createPerStateHookDispatcher — sub-thread tagging', () => {
  it('returns OK without host or hook side effects for an abandoned parent session id', async () => {
    const host = buildCanonicalHookHost({
      preToolUse: {
        match: '^Bash$',
        reduce: (draft) => {
          draft.count += 1;
        },
        return: () => ({
          hookSpecificOutput: {
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'should not run',
          },
        }),
      },
    });
    const currentMeta = vi.spyOn(host, 'currentMeta');
    const flushSnapshot = vi.fn();
    const writeFinalArtifacts = vi.fn(async () => {});
    const onTerminal = vi.fn();
    const onCanonicalEventError = vi.fn();
    const diagnostics: Array<{ threadId: string; source: string; message: string }> = [];
    const binding = activeThread('parentT');
    binding.set('parentT2');
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: binding,
      flushSnapshot,
      writeFinalArtifacts,
      onTerminal,
      onCanonicalEventError,
      onAbandonedThreadDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const reply = await dispatch(JSON.stringify(baseEvent));

    expect(reply).toEqual({ status: 'OK', body: '{}' });
    expect(diagnostics).toEqual([
      {
        threadId: 'parentT',
        source: 'hook:PreToolUse',
        message: 'PreToolUse hook frame ignored for abandoned thread',
      },
    ]);
    expect(currentMeta).not.toHaveBeenCalled();
    expect(flushSnapshot).not.toHaveBeenCalled();
    expect(writeFinalArtifacts).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onCanonicalEventError).not.toHaveBeenCalled();
  });

  it('marks isSubThread true and exposes subThreadId when sessionId differs from daemon threadId', async () => {
    let observedFlag: boolean | undefined;
    let observedSubThreadId: string | undefined;
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Bash$',
          handler: (_ctx: unknown, evt: unknown) => {
            const e = evt as { isSubThread: boolean; subThreadId?: string };
            observedFlag = e.isSubThread;
            observedSubThreadId = e.subThreadId;
            return undefined;
          },
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    await dispatch(JSON.stringify({ ...baseEvent, session_id: 'subT' }));
    expect(observedFlag).toBe(true);
    expect(observedSubThreadId).toBe('subT');
  });

  it('classifies hook events against the current active thread binding', async () => {
    const observed: boolean[] = [];
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Bash$',
          handler: (_ctx: unknown, evt: unknown) => {
            observed.push((evt as { isSubThread: boolean }).isSubThread);
            return undefined;
          },
        },
      ],
    });
    const binding = activeThread('parentT');
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: binding,
    });

    await dispatch(JSON.stringify({ ...baseEvent, session_id: 'parentT' }));
    binding.set('parentT2');
    await dispatch(JSON.stringify({ ...baseEvent, session_id: 'parentT' }));
    await dispatch(JSON.stringify({ ...baseEvent, session_id: 'parentT2' }));

    expect(observed).toEqual([false, false]);
  });
});

describe('createPerStateHookDispatcher — PostToolUse aggregation', () => {
  it('concatenates additionalContext in declaration order and preserves block reason', async () => {
    const host = buildHost({
      postToolUse: [
        {
          matcher: '^Bash$',
          handler: () => ({
            hookSpecificOutput: { additionalContext: 'first context' },
          }),
        },
        {
          matcher: '^Bash$',
          handler: () => ({
            decision: 'block' as const,
            reason: 'blocked by second handler',
            hookSpecificOutput: { additionalContext: 'second context' },
          }),
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PostToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const reply = await dispatch(
      JSON.stringify({
        ...baseEvent,
        hook_event_name: 'PostToolUse',
        tool_response: { ok: true },
      }),
    );
    expect(reply.status).toBe('OK');
    expect(JSON.parse(reply.body)).toEqual({
      decision: 'block',
      reason: 'blocked by second handler',
      hookSpecificOutput: {
        additionalContext: 'first context\n\nsecond context',
      },
    });
  });
});

describe('createPerStateHookDispatcher — UserPromptSubmit ignores matcher', () => {
  it('runs every UPS handler regardless of toolName', async () => {
    let invoked = 0;
    const host = buildHost({
      userPromptSubmit: [
        {
          handler: () => {
            invoked++;
            return { hookSpecificOutput: { additionalContext: 'note' } };
          },
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'UserPromptSubmit',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    await dispatch(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'parentT',
        cwd: '/tmp',
        transcript_path: null,
        model: 'm',
        permission_mode: 'default',
        turn_id: 't1',
        prompt: 'hi',
        triggered_at: '2026-05-08T00:00:00Z',
      }),
    );
    expect(invoked).toBe(1);
  });

  it('concatenates additionalContext from multiple handlers in declaration order', async () => {
    const host = buildHost({
      userPromptSubmit: [
        {
          handler: () => ({ hookSpecificOutput: { additionalContext: 'alpha' } }),
        },
        {
          handler: () => ({ hookSpecificOutput: { additionalContext: 'beta' } }),
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'UserPromptSubmit',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const reply = await dispatch(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'parentT',
        cwd: '/tmp',
        transcript_path: null,
        model: 'm',
        permission_mode: 'default',
        turn_id: 't1',
        prompt: 'hi',
        triggered_at: '2026-05-08T00:00:00Z',
      }),
    );
    expect(reply.status).toBe('OK');
    expect(JSON.parse(reply.body)).toEqual({
      hookSpecificOutput: { additionalContext: 'alpha\n\nbeta' },
    });
  });
});

describe('createPerStateHookDispatcher — malformed body', () => {
  it('returns ERROR with a useful message for malformed JSON', async () => {
    const host = buildHost({ preToolUse: [] });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    const reply = await dispatch('{not-json');
    expect(reply.status).toBe('ERROR');
    expect(JSON.parse(reply.body).message).toMatch(/bad PreToolUse body/);
  });
});

/**
 * The dispatcher's throw escalation (`setImmediate(() => { throw err; })`)
 * fires the same error as `uncaughtException` on the test process so the
 * production daemon's installed handler can log + exit (spec §5.6 step 9).
 * Vitest does not install its own `uncaughtException` handler by default,
 * so without intercepting it here the worker would crash mid-test.
 *
 * Pattern: each `describe` block that exercises the throw path installs a
 * capturing listener in `beforeEach`, asserts on the captured error
 * alongside the existing assertions, and removes the listener in
 * `afterEach`. Removing the default vitest `uncaughtException` listener
 * is unnecessary — vitest does not register one — and the local listener
 * fires before any later-registered listener would.
 */
describe('createPerStateHookDispatcher — handler exception', () => {
  let capturedFatal: Error[];
  let fatalListener: NodeJS.UncaughtExceptionListener;

  beforeEach(() => {
    capturedFatal = [];
    fatalListener = (err: Error) => {
      capturedFatal.push(err);
    };
    process.on('uncaughtException', fatalListener);
  });

  afterEach(() => {
    process.off('uncaughtException', fatalListener);
  });

  it('lets the exception propagate so the daemon crash handler can log + exit', async () => {
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Bash$',
          handler: () => {
            throw new Error('author bug');
          },
        },
      ],
    });
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
    });
    await expect(dispatch(JSON.stringify(baseEvent))).rejects.toThrow(/author bug/);
    // The dispatcher also escalates the throw via `setImmediate` so it
    // bypasses the per-frame UDS try/catch in `hookSocket.handleRequest`
    // and reaches the daemon's installed `uncaughtException` handler.
    // Yield once to let the `setImmediate` callback run.
    await new Promise<void>((res) => setImmediate(res));
    expect(capturedFatal).toHaveLength(1);
    expect(capturedFatal[0]?.message).toMatch(/author bug/);
  });
});

describe('createPerStateHookDispatcher — onAuthorHandlerError', () => {
  let capturedFatal: Error[];
  let fatalListener: NodeJS.UncaughtExceptionListener;

  beforeEach(() => {
    capturedFatal = [];
    fatalListener = (err: Error) => {
      capturedFatal.push(err);
    };
    process.on('uncaughtException', fatalListener);
  });

  afterEach(() => {
    process.off('uncaughtException', fatalListener);
  });

  it('invokes the callback with kind + stateId + matcher + error before re-throwing', async () => {
    const host = buildHost({
      preToolUse: [
        {
          matcher: '^Bash$',
          handler: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const calls: Array<{
      kind: string;
      stateId: string;
      matcher: string | null;
      error: Error;
    }> = [];
    const dispatch = createPerStateHookDispatcher({
      kind: 'PreToolUse',
      host,
      activeThreadBinding: activeThread('parentT'),
      onAuthorHandlerError: (info) => calls.push(info),
    });
    await expect(dispatch(JSON.stringify(baseEvent))).rejects.toThrow(/boom/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('PreToolUse');
    expect(calls[0]?.matcher).toBe('^Bash$');
    expect(calls[0]?.stateId).toBe('s');
    expect(calls[0]?.error.message).toBe('boom');
    // Yield once so the dispatcher's `setImmediate` re-throw fires as
    // `uncaughtException` on the test process. The local listener
    // captures it; without the listener vitest's worker would crash.
    await new Promise<void>((res) => setImmediate(res));
    expect(capturedFatal).toHaveLength(1);
    expect(capturedFatal[0]?.message).toBe('boom');
  });
});

/**
 * Exercises the production `makeSerializeDispatch` helper directly.
 * Each test constructs a fresh serializer so the chain state is
 * independent across cases.
 */
describe('serializeDispatch helper', () => {
  it('runs concurrent invocations FIFO', async () => {
    const serialize = makeSerializeDispatch();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((res) => {
      releaseFirst = res;
    });
    const p1 = serialize(async () => {
      order.push('1-start');
      await firstDone;
      order.push('1-end');
      return 1;
    });
    const p2 = serialize(async () => {
      order.push('2-start');
      return 2;
    });
    // Yield once so #1 has a chance to start.
    await Promise.resolve();
    expect(order).toEqual(['1-start']);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '1-end', '2-start']);
  });

  it('does not poison the chain when one segment rejects', async () => {
    const serialize = makeSerializeDispatch();
    const p1 = serialize(async () => {
      throw new Error('boom');
    });
    await expect(p1).rejects.toThrow(/boom/);
    const p2 = serialize(async () => 'ok');
    await expect(p2).resolves.toBe('ok');
  });
});
