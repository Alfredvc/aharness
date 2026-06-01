/**
 * Tests for the Phase-2b await-resolver wiring in `cli/runCli.ts`.
 *
 * The resolver itself (`runtime/awaitResolver.ts`) is covered by
 * `runtime.awaitResolver.test.ts` — those tests pin the parse/commit
 * surface. This file covers the plumbing layer:
 *
 *   - `dispatchRawResponseItem(params, resolver)` routes
 *     `function_call` / `function_call_output` items into the resolver
 *     and drops everything else.
 *   - `currentAwaitExitName(host)` returns the first `await`-kind exit
 *     name on the host's currently active leaf, or `null` when the
 *     leaf is non-stateful or has no await exit.
 *   - `extractCallIdForLog(params)` returns a best-effort string call_id
 *     for the stderr diagnostic.
 *   - The `void ... .catch(...)` wrapper in `runCli.ts`'s notification
 *     subscription routes resolver-side throws to stderr without leaking
 *     as unhandled rejections; this file exercises that contract via
 *     `dispatchRawResponseItem` directly (the runCli-internal `.catch`
 *     is a thin one-liner over the same throw).
 *
 * The helpers live inline in `runCli.ts` (plan §Task-4 file-placement
 * pin) and are exported solely for these tests.
 */

import { describe, expect, it, vi } from 'vitest';

import { aharness, state, terminal, exit } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import { createAwaitResolver, type AwaitResolver } from '../src/runtime/awaitResolver.js';
import {
  currentAwaitExitName,
  dispatchRawResponseItem,
  extractCallIdForLog,
} from '../src/cli/runCli.js';

function makeSpyResolver(): {
  resolver: AwaitResolver;
  note: ReturnType<typeof vi.fn>;
  handle: ReturnType<typeof vi.fn>;
} {
  const note = vi.fn();
  const handle = vi.fn(async () => undefined);
  const resolver: AwaitResolver = {
    noteFunctionCall: note as AwaitResolver['noteFunctionCall'],
    handleFunctionCallOutput: handle as unknown as AwaitResolver['handleFunctionCallOutput'],
  };
  return { resolver, note, handle };
}

describe('dispatchRawResponseItem', () => {
  it('routes function_call(name=request_user_input) to noteFunctionCall', async () => {
    const { resolver, note, handle } = makeSpyResolver();
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call',
          call_id: 'c1',
          name: 'request_user_input',
          arguments: '{"questions":[{"id":"q1"}]}',
        },
      },
      resolver,
    );
    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith({
      call_id: 'c1',
      name: 'request_user_input',
      arguments: '{"questions":[{"id":"q1"}]}',
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('routes function_call(name=other) to noteFunctionCall too (resolver filters by name)', async () => {
    // The resolver's `noteFunctionCall` filter (`name !== 'request_user_input'`)
    // is the SOURCE OF TRUTH for which calls matter; the dispatcher
    // does not pre-filter by name. This test pins that the dispatch
    // helper forwards every function_call unchanged so the resolver's
    // own filter remains authoritative.
    const { resolver, note } = makeSpyResolver();
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call',
          call_id: 'c2',
          name: 'bash',
          arguments: '{}',
        },
      },
      resolver,
    );
    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith({ call_id: 'c2', name: 'bash', arguments: '{}' });
  });

  it('routes function_call_output to handleFunctionCallOutput', async () => {
    const { resolver, note, handle } = makeSpyResolver();
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call_output',
          call_id: 'c1',
          output: '{"answers":{"q1":{"answers":["x"]}}}',
        },
      },
      resolver,
    );
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(
      {
        call_id: 'c1',
        output: '{"answers":{"q1":{"answers":["x"]}}}',
      },
      {},
    );
    expect(note).not.toHaveBeenCalled();
  });

  it('orders noteFunctionCall before handleFunctionCallOutput (separate notifications)', async () => {
    // The notification handler in runCli.ts subscribes once and forwards
    // each notification through dispatchRawResponseItem independently;
    // ordering across notifications is enforced by codex's emission
    // order, not by the dispatcher. This test pins that two sequential
    // calls fire their respective spies in observable order.
    const { resolver, note, handle } = makeSpyResolver();
    const order: string[] = [];
    note.mockImplementation(() => order.push('note'));
    handle.mockImplementation(() => {
      order.push('handle');
      return Promise.resolve();
    });
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call',
          call_id: 'c1',
          name: 'request_user_input',
          arguments: '{}',
        },
      },
      resolver,
    );
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call_output',
          call_id: 'c1',
          output: '"{}"',
        },
      },
      resolver,
    );
    expect(order).toEqual(['note', 'handle']);
  });

  it('drops other ResponseItem variants silently (e.g. assistant_message)', async () => {
    const { resolver, note, handle } = makeSpyResolver();
    await dispatchRawResponseItem(
      {
        item: {
          type: 'assistant_message',
          id: 'm1',
          content: [{ type: 'output_text', text: 'hi' }],
        },
      },
      resolver,
    );
    expect(note).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('drops malformed params (null, undefined, non-object) silently', async () => {
    const { resolver, note, handle } = makeSpyResolver();
    await dispatchRawResponseItem(null, resolver);
    await dispatchRawResponseItem(undefined, resolver);
    await dispatchRawResponseItem('not an object', resolver);
    await dispatchRawResponseItem({}, resolver); // no .item
    await dispatchRawResponseItem({ item: null }, resolver); // .item is null
    await dispatchRawResponseItem({ item: { type: 'function_call' } }, resolver); // missing call_id
    await dispatchRawResponseItem({ item: { type: 'function_call', call_id: 1 } }, resolver); // call_id non-string
    await dispatchRawResponseItem({ item: { type: 'function_call_output' } }, resolver); // missing call_id
    expect(note).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('propagates a throw from handleFunctionCallOutput (the runCli .catch surfaces it to stderr)', async () => {
    // `handleFunctionCallOutput` is the only awaited path in the helper;
    // a throw there must propagate so the notification handler's
    // `void ... .catch(...)` can route it to stderr. The helper itself
    // does NOT swallow.
    const { resolver, handle } = makeSpyResolver();
    handle.mockImplementation(() => Promise.reject(new Error('boom')));
    await expect(
      dispatchRawResponseItem(
        {
          item: {
            type: 'function_call_output',
            call_id: 'c1',
            output: '"x"',
          },
        },
        resolver,
      ),
    ).rejects.toThrow(/boom/);
  });

  it('runCli .catch shape: a resolver throw is formatted to stderr with the call_id', async () => {
    // Pin the on-wire `.catch` wrapper's stderr-message format. The
    // wrapper itself lives inline in `runCli.ts` inside the
    // `c.onNotification(rawResponseItem/completed, ...)` registration;
    // this test reproduces the same `.catch` shape against the exported
    // dispatcher to prove the format is stable. If the format ever
    // changes, both this test AND the runCli wrapper must update in
    // lockstep — the message is part of the operator-facing diagnostic
    // contract.
    const { resolver, handle } = makeSpyResolver();
    handle.mockImplementation(() => Promise.reject(new Error('boom')));
    const stderrChunks: string[] = [];
    const params = {
      item: {
        type: 'function_call_output',
        call_id: 'c-77',
        output: '"x"',
      },
    };
    await new Promise<void>((resolve) => {
      void dispatchRawResponseItem(params, resolver).catch((err: unknown) => {
        const callId = extractCallIdForLog(params);
        stderrChunks.push(
          `aharness: awaitResolver dispatch error (call_id=${callId ?? '<unknown>'}): ${
            (err as Error).message
          }\n`,
        );
        resolve();
      });
    });
    expect(stderrChunks).toHaveLength(1);
    expect(stderrChunks[0]).toBe('aharness: awaitResolver dispatch error (call_id=c-77): boom\n');
  });

  it('runCli .catch shape: falls back to <unknown> when params shape hides the call_id', async () => {
    // The wrapper's `extractCallIdForLog(params) ?? '<unknown>'` branch.
    // Reproduce the same .catch shape against a malformed params body
    // (`item.call_id` non-string) to pin the fallback string. A real
    // dispatcher early-returns on this shape (no throw to catch), so
    // we feed a well-shaped params to dispatch + force the resolver to
    // throw, but compute the diagnostic against a malformed params
    // payload — same pattern the runCli .catch uses.
    const { resolver, handle } = makeSpyResolver();
    handle.mockImplementation(() => Promise.reject(new Error('zap')));
    const stderrChunks: string[] = [];
    const goodParams = {
      item: { type: 'function_call_output', call_id: 'c-x', output: '"x"' },
    };
    const malformedParams = { item: { type: 'function_call_output' } }; // no call_id
    await new Promise<void>((resolve) => {
      void dispatchRawResponseItem(goodParams, resolver).catch((err: unknown) => {
        const callId = extractCallIdForLog(malformedParams);
        stderrChunks.push(
          `aharness: awaitResolver dispatch error (call_id=${callId ?? '<unknown>'}): ${
            (err as Error).message
          }\n`,
        );
        resolve();
      });
    });
    expect(stderrChunks[0]).toBe(
      'aharness: awaitResolver dispatch error (call_id=<unknown>): zap\n',
    );
  });
});

describe('extractCallIdForLog', () => {
  it('returns the call_id when shape is well-formed', () => {
    expect(
      extractCallIdForLog({
        item: { type: 'function_call_output', call_id: 'c1', output: '' },
      }),
    ).toBe('c1');
  });

  it('returns undefined for malformed shapes', () => {
    expect(extractCallIdForLog(null)).toBeUndefined();
    expect(extractCallIdForLog(undefined)).toBeUndefined();
    expect(extractCallIdForLog('nope')).toBeUndefined();
    expect(extractCallIdForLog({})).toBeUndefined();
    expect(extractCallIdForLog({ item: null })).toBeUndefined();
    expect(extractCallIdForLog({ item: {} })).toBeUndefined();
    expect(extractCallIdForLog({ item: { call_id: 7 } })).toBeUndefined();
  });
});

describe.skip('currentAwaitExitName for retired await exits', () => {
  function buildHostInState(initial: 'wait' | 'submitOnly' | 'fin'): ActorHost {
    const machine = aharness.machine({
      id: 'm',
      initial,
      context: () => ({}),
      states: {
        wait: state({
          exits: {
            // Submit exit comes FIRST in declaration order so the test
            // proves currentAwaitExitName scans past submits to find the
            // await-kind entry.
            other: exit({ to: 'submitOnly' }),
            reply: { kind: 'await', to: 'submitOnly' },
          },
          entryPrompt: 'wait',
        }),
        submitOnly: state({
          exits: { go: exit({ to: 'fin' }) },
          entryPrompt: 'submitOnly',
        }),
        fin: terminal('success'),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    return host;
  }

  it('returns the await-exit name when the active leaf declares one', () => {
    const host = buildHostInState('wait');
    expect(currentAwaitExitName(host)).toBe('reply');
  });

  it('returns null when the active leaf has only submit exits', () => {
    const host = buildHostInState('submitOnly');
    expect(currentAwaitExitName(host)).toBeNull();
  });

  it('returns null when the active leaf is terminal (non-stateful meta)', () => {
    const host = buildHostInState('fin');
    expect(currentAwaitExitName(host)).toBeNull();
  });
});

describe.skip('retired await-resolver wiring contract (dispatch + currentAwaitExitName + commit + flush)', () => {
  it('routes a function_call_output through a real resolver to commitAwait + onAfterTransition', async () => {
    // End-to-end wiring: synthesize the same `function_call` +
    // `function_call_output` pair codex emits for `request_user_input`,
    // pump them through `dispatchRawResponseItem` against a REAL
    // `createAwaitResolver`, and assert the resolver's `commitAwait` +
    // `onAfterTransition` callbacks fire with the expected payload. The
    // resolver's own filter / parse logic is covered by
    // `runtime.awaitResolver.test.ts`; this case proves the dispatcher
    // hands off cleanly.
    const commits: Array<{ stateId: string; exitName: string; msg: string }> = [];
    const afters: number[] = [];
    let afterTick = 0;
    const resolver = createAwaitResolver({
      currentStateId: () => 'wait',
      currentAwaitExitName: () => 'reply',
      commitAwait: (stateId, exitName, msg) => {
        commits.push({ stateId, exitName, msg });
      },
      onAfterTransition: () => {
        afters.push(++afterTick);
      },
    });

    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call',
          call_id: 'c-99',
          name: 'request_user_input',
          arguments: JSON.stringify({
            questions: [{ id: 'owner', header: '', question: 'name?' }],
          }),
        },
      },
      resolver,
    );
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call_output',
          call_id: 'c-99',
          output: JSON.stringify({ answers: { owner: { answers: ['alice'] } } }),
        },
      },
      resolver,
    );

    expect(commits).toEqual([{ stateId: 'wait', exitName: 'reply', msg: 'alice' }]);
    expect(afters).toEqual([1]);
  });

  it('through a real resolver: function_call(name=bash) is ignored (resolver filter at awaitResolver.ts:145)', async () => {
    // The dispatcher forwards every function_call into the resolver
    // (this is by design — the resolver owns the name-filter so future
    // tools can be added without touching the dispatcher). The
    // resolver's own `name !== "request_user_input"` filter is the
    // source of truth. This test pumps a bash function_call followed
    // by a function_call_output for the same call_id through a real
    // resolver and asserts the output is dropped (nothing committed),
    // proving the wiring respects the resolver's filter.
    const commit = vi.fn();
    const after = vi.fn();
    const resolver = createAwaitResolver({
      currentStateId: () => 'wait',
      currentAwaitExitName: () => 'reply',
      commitAwait: commit,
      onAfterTransition: after,
    });

    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call',
          call_id: 'c-bash',
          name: 'bash',
          arguments: '{}',
        },
      },
      resolver,
    );
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call_output',
          call_id: 'c-bash',
          output: JSON.stringify({ answers: { q: { answers: ['ignored'] } } }),
        },
      },
      resolver,
    );

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('drops a function_call_output for a non-noted call_id (resolver early-return)', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    const resolver = createAwaitResolver({
      currentStateId: () => 'wait',
      currentAwaitExitName: () => 'reply',
      commitAwait: commit,
      onAfterTransition: after,
    });

    // No prior noteFunctionCall — the output is dropped silently.
    await dispatchRawResponseItem(
      {
        item: {
          type: 'function_call_output',
          call_id: 'never-noted',
          output: JSON.stringify({ answers: { q: { answers: ['x'] } } }),
        },
      },
      resolver,
    );

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
});
