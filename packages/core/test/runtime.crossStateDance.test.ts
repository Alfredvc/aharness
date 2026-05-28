/**
 * Phase 2a cross-state dance tests (`runtime/crossStateDance.ts`).
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-2a-cross-state.md` Task 2.
 *
 * Covers:
 *  - Synchronous return (background scheduling).
 *  - Watcher registered BEFORE function returns (so codex's
 *    `item/completed` cannot beat the watcher); `markSubmittedThisTurn`
 *    fires synchronously.
 *  - Step ordering: watcher → `turn/interrupt` → `turn/start`.
 *  - `turn/start` wire shape: `input=[{type:'text', text:<orientationText>}]`
 *    with byte-equality on a fixture string carrying the
 *    `[harness] Now in state` marker (asserts the FULL composed nudge
 *    flows through, not the raw entryPrompt).
 *  - Non-fatal interrupt errors ("no active turn to interrupt",
 *    "expected active turn id") are swallowed; `turn/start` still
 *    issues.
 *  - Unexpected errors invoke `onError` and clear
 *    `submittedThisTurn`.
 */
import { describe, it, expect, vi } from 'vitest';

import { scheduleCrossStateDance } from '../src/runtime/crossStateDance.js';
import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import type { ItemCompletedWatcherRegistry } from '../src/transport/itemCompletedWatcher.js';
import type { JsonRpcClient } from '../src/jsonrpc/client.js';

/**
 * Build a fake watcher registry whose `register()` returns a manually-
 * controlled deferred promise so tests can sequence the await on
 * `item/completed` against the JSON-RPC requests.
 */
function makeControlledRegistry(): {
  registry: ItemCompletedWatcherRegistry;
  registered: string[];
  resolveMatch: (callId: string, item?: unknown) => void;
  rejectMatch: (callId: string, error: Error) => void;
} {
  const registered: string[] = [];
  const resolvers = new Map<string, (item: unknown) => void>();
  const rejecters = new Map<string, (e: Error) => void>();
  const registry: ItemCompletedWatcherRegistry = {
    register(callId: string) {
      registered.push(callId);
      return new Promise<unknown>((resolve, reject) => {
        resolvers.set(callId, resolve);
        rejecters.set(callId, reject);
      });
    },
    dispatch() {
      return false;
    },
    getPending() {
      return [...resolvers.keys()];
    },
  };
  return {
    registry,
    registered,
    resolveMatch: (callId, item = { type: 'dynamicToolCall', id: callId }) => {
      const resolve = resolvers.get(callId);
      if (!resolve) throw new Error(`no pending watcher for ${callId}`);
      resolvers.delete(callId);
      rejecters.delete(callId);
      resolve(item);
    },
    rejectMatch: (callId, error) => {
      const reject = rejecters.get(callId);
      if (!reject) throw new Error(`no pending watcher for ${callId}`);
      resolvers.delete(callId);
      rejecters.delete(callId);
      reject(error);
    },
  };
}

interface RecordedRequest {
  method: string;
  params: unknown;
}

/**
 * Build a fake JsonRpcClient whose `request()` records calls and looks
 * up a per-method response in a queue. If no entry is queued the
 * request resolves with `{}` (the empty success shape `turn/interrupt`
 * uses on the wire).
 */
function makeFakeClient(): {
  client: JsonRpcClient;
  requests: RecordedRequest[];
  queueResponse(method: string, value: unknown | Error): void;
} {
  const requests: RecordedRequest[] = [];
  const queues = new Map<string, Array<unknown | Error>>();
  const client = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      requests.push({ method, params });
      const q = queues.get(method);
      const next = q?.shift();
      if (next instanceof Error) throw next;
      return (next ?? ({} as unknown)) as T;
    },
  } as unknown as JsonRpcClient;
  return {
    client,
    requests,
    queueResponse(method, value) {
      const q = queues.get(method) ?? [];
      q.push(value);
      queues.set(method, q);
    },
  };
}

/**
 * Yield to the microtask queue. The dance's background promise consists
 * of a chain of awaits — flushing microtasks lets the chain advance
 * after each external event (watcher resolution, queued JSON-RPC
 * response).
 */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function activeThread(threadId = 't') {
  return createActiveThreadBinding(threadId);
}

describe('scheduleCrossStateDance (Phase 2a)', () => {
  it('schedules background promise and returns synchronously', () => {
    const { registry } = makeControlledRegistry();
    const { client } = makeFakeClient();
    const mark = vi.fn();

    const result = scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: mark,
    });
    expect(result).toBeUndefined();
  });

  it('registers watcher BEFORE returning (markSubmittedThisTurn fires synchronously)', () => {
    const { registry, registered } = makeControlledRegistry();
    const { client } = makeFakeClient();
    const mark = vi.fn();

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: mark,
    });

    // Both assertions read state synchronously — no `await` between the
    // call and the read. If either side were async we'd see an empty
    // array / zero invocations here.
    expect(registered).toEqual(['call-1']);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('awaits watcher resolution before issuing turn/interrupt', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, requests } = makeFakeClient();

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
    });

    // Watcher still pending: no request should fire yet.
    await flushMicrotasks();
    expect(requests).toEqual([]);

    resolveMatch('call-1');
    await flushMicrotasks();

    expect(requests[0]).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 't', turnId: 'turn-1' },
    });
  });

  it('reads the active thread binding when requests are issued', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, requests } = makeFakeClient();
    const binding = activeThread('thread-before');

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: binding,
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
    });

    binding.set('thread-after');
    resolveMatch('call-1');
    await flushMicrotasks();

    expect(requests).toEqual([
      {
        method: 'turn/interrupt',
        params: { threadId: 'thread-after', turnId: 'turn-1' },
      },
      {
        method: 'turn/start',
        params: { threadId: 'thread-after', input: [{ type: 'text', text: 'nudge' }] },
      },
    ]);
  });

  it('awaits turn/interrupt before issuing turn/start', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();

    // Bespoke client for this test: turn/interrupt blocks on a deferred
    // so we can prove turn/start does not race ahead.
    let releaseInterrupt!: () => void;
    const interruptDone = new Promise<unknown>((resolve) => {
      releaseInterrupt = () => resolve({});
    });
    const requests: RecordedRequest[] = [];
    const client = {
      request: async (method: string, params: unknown): Promise<unknown> => {
        requests.push({ method, params });
        if (method === 'turn/interrupt') return interruptDone;
        return {};
      },
    } as unknown as JsonRpcClient;

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
    });

    resolveMatch('call-1');
    await flushMicrotasks();
    // turn/interrupt should be in-flight; turn/start must NOT have fired.
    expect(requests.map((r) => r.method)).toEqual(['turn/interrupt']);

    releaseInterrupt();
    await flushMicrotasks();
    expect(requests.map((r) => r.method)).toEqual(['turn/interrupt', 'turn/start']);
  });

  it("turn/start carries input=[{type:'text', text: <orientationText>}]", async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, requests } = makeFakeClient();

    const fullNudge = '[harness] Now in state "b"\n\nValid exits:\n  - done({})\n\nstate b active';

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('thread-x'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: fullNudge,
      markSubmittedThisTurn: () => {},
    });

    resolveMatch('call-1');
    await flushMicrotasks();

    const turnStart = requests.find((r) => r.method === 'turn/start');
    expect(turnStart).toBeDefined();
    // Byte-equality on the wire shape: assert the full composed nudge
    // flows through verbatim, not just the raw entryPrompt fragment.
    expect(turnStart!.params).toEqual({
      threadId: 'thread-x',
      input: [{ type: 'text', text: fullNudge }],
    });
    expect((turnStart!.params as { input: Array<{ text: string }> }).input[0].text).toContain(
      '[harness] Now in state',
    );
  });

  it('non-fatal interrupt error: "no active turn to interrupt" is swallowed; turn/start still issues', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, requests, queueResponse } = makeFakeClient();
    const onError = vi.fn();
    const clearMark = vi.fn();

    queueResponse('turn/interrupt', new Error('no active turn to interrupt'));

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
      clearSubmittedThisTurn: clearMark,
      onError,
    });

    resolveMatch('call-1');
    await flushMicrotasks();

    expect(requests.map((r) => r.method)).toEqual(['turn/interrupt', 'turn/start']);
    // Non-fatal: not surfaced to onError, and the flag is NOT cleared.
    expect(onError).not.toHaveBeenCalled();
    expect(clearMark).not.toHaveBeenCalled();
  });

  it('non-fatal interrupt error: stale turnId is swallowed; turn/start still issues', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, requests, queueResponse } = makeFakeClient();
    const onError = vi.fn();
    const clearMark = vi.fn();

    queueResponse(
      'turn/interrupt',
      new Error('jsonrpc error -32000: expected active turn id turn-2 but found turn-1'),
    );

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
      clearSubmittedThisTurn: clearMark,
      onError,
    });

    resolveMatch('call-1');
    await flushMicrotasks();

    expect(requests.map((r) => r.method)).toEqual(['turn/interrupt', 'turn/start']);
    expect(onError).not.toHaveBeenCalled();
    expect(clearMark).not.toHaveBeenCalled();
  });

  it('unexpected error invokes onError and clears submittedThisTurn', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, requests, queueResponse } = makeFakeClient();
    const onError = vi.fn();
    const clearMark = vi.fn();

    // Non-matching message — should propagate to the outer catch.
    queueResponse('turn/interrupt', new Error('jsonrpc error -32603: internal server error'));

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
      clearSubmittedThisTurn: clearMark,
      onError,
    });

    resolveMatch('call-1');
    await flushMicrotasks();

    // turn/interrupt fired; turn/start did NOT fire (outer catch swallowed
    // before reaching it).
    expect(requests.map((r) => r.method)).toEqual(['turn/interrupt']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/internal server error/);
    expect(clearMark).toHaveBeenCalledTimes(1);
  });

  it('F1 salvage: turn/interrupt unknown error invokes requestDriveForwardSalvage AFTER clear + onError', async () => {
    const { registry, resolveMatch } = makeControlledRegistry();
    const { client, queueResponse } = makeFakeClient();

    queueResponse('turn/interrupt', new Error('jsonrpc error -32603: internal server error'));

    // Shared sequence buffer so we can prove the ordering documented at
    // `crossStateDance.ts`'s outer catch: clear → onError → salvage.
    const sequence: string[] = [];
    const clearMark = vi.fn(() => {
      sequence.push('clear');
    });
    const onError = vi.fn(() => {
      sequence.push('onError');
    });
    const requestDriveForwardSalvage = vi.fn(() => {
      sequence.push('salvage');
    });

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
      clearSubmittedThisTurn: clearMark,
      onError,
      requestDriveForwardSalvage,
    });

    resolveMatch('call-1');
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(clearMark).toHaveBeenCalledTimes(1);
    expect(requestDriveForwardSalvage).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(['clear', 'onError', 'salvage']);
  });

  it('F1 salvage: watcher rejection (timeout) invokes requestDriveForwardSalvage AFTER clear + onError', async () => {
    const { registry, rejectMatch } = makeControlledRegistry();
    const { client, requests } = makeFakeClient();

    const sequence: string[] = [];
    const clearMark = vi.fn(() => {
      sequence.push('clear');
    });
    const onError = vi.fn(() => {
      sequence.push('onError');
    });
    const requestDriveForwardSalvage = vi.fn(() => {
      sequence.push('salvage');
    });

    scheduleCrossStateDance({
      client,
      watcherRegistry: registry,
      activeThreadBinding: activeThread('t'),
      turnId: 'turn-1',
      callId: 'call-1',
      orientationText: 'nudge',
      markSubmittedThisTurn: () => {},
      clearSubmittedThisTurn: clearMark,
      onError,
      requestDriveForwardSalvage,
    });

    // Simulate the watcher-timeout failure mode: the registered promise
    // rejects with the same error shape `itemCompletedWatcher` produces
    // on its 30 s timeout.
    rejectMatch(
      'call-1',
      new Error('itemCompletedWatcher: timeout after 30000ms for callId=call-1'),
    );
    await flushMicrotasks();

    // No JSON-RPC traffic should have fired — the dance never reached
    // turn/interrupt because the watcher rejected first.
    expect(requests).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/itemCompletedWatcher: timeout/);
    expect(clearMark).toHaveBeenCalledTimes(1);
    expect(requestDriveForwardSalvage).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(['clear', 'onError', 'salvage']);
  });
});
