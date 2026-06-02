/**
 * Phase 1 drive-forward listener tests (`runtime/driveForward.ts`).
 *
 * Spec: `docs/plans/2026-05-12-headless-phase-1a-transport-backbone.md` Task 10.
 *
 * Phase 1 surface: posture is just `isTerminal`. Default branch fires
 * `turn/start` with the active state's nudge as TUI-visible input.
 * `isAwaiting` is a real short-circuit (returns without issuing turn/start
 * when a `request_user_input` ServerRequest is parked). `isOpen` is the
 * browser-owned prompt posture.
 *
 * Imports from the direct module path (not the `runtime.js` barrel)
 * because the Group D barrel re-export is added in a separate
 * orchestrator consolidation commit.
 */
import { describe, it, expect, vi } from 'vitest';

import { createDriveForward } from '../src/runtime/driveForward.js';
import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import type { JsonRpcClient } from '../src/jsonrpc/client.js';

function makeStubClient(overrides: Partial<JsonRpcClient> = {}): JsonRpcClient {
  return { request: async () => ({}), ...overrides } as unknown as JsonRpcClient;
}

function activeThread(threadId = 'p') {
  return createActiveThreadBinding(threadId);
}

describe('drive-forward (Phase 1)', () => {
  it('issues turn/start with the active state nudge after every non-terminal turn/completed', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { turn: { id: 't1' } };
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal: () => false,
      composeActiveStateNudge: () => 'nudge text',
      onShutdown: () => {
        throw new Error('should not be reached');
      },
    });
    await driveForward.onTurnCompleted();
    await driveForward.onTurnCompleted();
    expect(requests).toEqual([
      {
        method: 'turn/start',
        params: { threadId: 'p', input: [{ type: 'text', text: 'nudge text' }] },
      },
      {
        method: 'turn/start',
        params: { threadId: 'p', input: [{ type: 'text', text: 'nudge text' }] },
      },
    ]);
  });

  it('reads the active thread binding when issuing default turn/start', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const binding = activeThread('parent-1');
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: binding,
      isTerminal: () => false,
      composeActiveStateNudge: () => 'nudge',
      onShutdown: () => {},
    });

    binding.set('parent-2');
    await driveForward.onTurnCompleted();

    expect(requests).toEqual([
      {
        method: 'turn/start',
        params: { threadId: 'parent-2', input: [{ type: 'text', text: 'nudge' }] },
      },
    ]);
  });

  it('fires onShutdown when terminal', async () => {
    const shutdown = vi.fn();
    const driveForward = createDriveForward({
      client: makeStubClient(),
      activeThreadBinding: activeThread('p'),
      isTerminal: () => true,
      composeActiveStateNudge: () => 'unused',
      onShutdown: shutdown,
    });
    await driveForward.onTurnCompleted();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('onTurnCompleted: isAwaiting=true short-circuits before isTerminal check', async () => {
    // A request_user_input ServerRequest is parked. Codex normally holds the
    // turn open via the tool call, but if a turn/completed ever fires in this
    // posture, drive-forward must return without issuing a fresh turn/start
    // (which would race the parked tool reply) and without invoking onShutdown.
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isAwaiting returns true');
    });
    const onShutdown = vi.fn();
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'unused',
      onShutdown,
      isAwaiting: () => true,
    });

    await driveForward.onTurnCompleted();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('runs onTurnCompletedBeforeDecision before posture predicates', async () => {
    const events: string[] = [];
    const driveForward = createDriveForward({
      client: makeStubClient(),
      activeThreadBinding: activeThread('p'),
      isTerminal: () => false,
      composeActiveStateNudge: () => {
        events.push('compose');
        return 'x';
      },
      onShutdown: () => {},
      onTurnCompletedBeforeDecision: () => events.push('counter'),
    });
    await driveForward.onTurnCompleted();
    expect(events).toEqual(['counter', 'compose']);
  });

  it('returns without issuing turn/start when isOpen returns true', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isOpen returns true');
    });
    const onShutdown = vi.fn();
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'x',
      onShutdown,
      isOpen: () => true,
    });

    await driveForward.onTurnCompleted();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('returns without issuing turn/start when isChoice returns true', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isChoice returns true');
    });
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'x',
      onShutdown: () => {},
      isChoice: () => true,
    });

    await driveForward.onTurnCompleted();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('submittedThisTurn() === true short-circuits before isTerminal check', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when submittedThisTurn returns true');
    });
    const onShutdown = vi.fn();
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'unused',
      onShutdown,
      submittedThisTurn: () => true,
    });

    await driveForward.onTurnCompleted();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('submittedThisTurn opt absent or returns false falls through to existing behavior', async () => {
    // Case A: opt absent — same shape as the first test in this suite,
    // re-asserted to lock the "opt absent ⇒ default branch" contract.
    const requestsA: Array<{ method: string; params: unknown }> = [];
    const clientA = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requestsA.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const dfA = createDriveForward({
      client: clientA,
      activeThreadBinding: activeThread('p'),
      isTerminal: () => false,
      composeActiveStateNudge: () => 'nudge',
      onShutdown: () => {},
    });
    await dfA.onTurnCompleted();
    expect(requestsA).toEqual([
      { method: 'turn/start', params: { threadId: 'p', input: [{ type: 'text', text: 'nudge' }] } },
    ]);

    // Case B: opt defined but returns false — same default-branch path.
    const requestsB: Array<{ method: string; params: unknown }> = [];
    const clientB = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requestsB.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const dfB = createDriveForward({
      client: clientB,
      activeThreadBinding: activeThread('p'),
      isTerminal: () => false,
      composeActiveStateNudge: () => 'nudge',
      onShutdown: () => {},
      submittedThisTurn: () => false,
    });
    await dfB.onTurnCompleted();
    expect(requestsB).toEqual([
      { method: 'turn/start', params: { threadId: 'p', input: [{ type: 'text', text: 'nudge' }] } },
    ]);
  });

  it('onTurnCompleted: isAwaiting=true AND submittedThisTurn=true → isAwaiting fires first', async () => {
    // When BOTH `isAwaiting` and `submittedThisTurn` would fire,
    // `isAwaiting` short-circuits first — its branch sits strictly
    // BEFORE `submittedThisTurn` in the posture chain. The downstream
    // predicate must not be consulted, and no turn/start may be
    // issued.
    const requests: Array<{ method: string; params: unknown }> = [];
    const submittedThisTurn = vi.fn(() => true);
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isAwaiting returns true');
    });
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'x',
      onShutdown: () => {},
      isAwaiting: () => true,
      submittedThisTurn,
    });

    await driveForward.onTurnCompleted();

    expect(submittedThisTurn).not.toHaveBeenCalled();
    expect(isTerminal).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});

describe('drive-forward salvageAfterDanceFailure (F1)', () => {
  it('issues turn/start with the active state nudge in the default branch', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal: () => false,
      composeActiveStateNudge: () => 'salvage nudge',
      onShutdown: () => {
        throw new Error('should not be reached');
      },
    });
    await driveForward.salvageAfterDanceFailure();
    // Same wire shape as onTurnCompleted's default branch — the shared
    // `issueDefaultTurnStart` helper is the single locus.
    expect(requests).toEqual([
      {
        method: 'turn/start',
        params: { threadId: 'p', input: [{ type: 'text', text: 'salvage nudge' }] },
      },
    ]);
  });

  it('fires onShutdown when isTerminal returns true', async () => {
    const shutdown = vi.fn();
    const driveForward = createDriveForward({
      client: makeStubClient(),
      activeThreadBinding: activeThread('p'),
      isTerminal: () => true,
      composeActiveStateNudge: () => 'unused',
      onShutdown: shutdown,
    });
    await driveForward.salvageAfterDanceFailure();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('salvageAfterDanceFailure: isAwaiting=true short-circuits before isTerminal check', async () => {
    // Parity with `onTurnCompleted`. If the dance fails while a
    // request_user_input ServerRequest is parked, salvage returns without
    // issuing a recovery turn/start (which would race the parked tool reply)
    // and without invoking onShutdown.
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isAwaiting returns true');
    });
    const onShutdown = vi.fn();
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'unused',
      onShutdown,
      isAwaiting: () => true,
    });

    await driveForward.salvageAfterDanceFailure();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('salvageAfterDanceFailure returns without issuing turn/start when isOpen returns true', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isOpen returns true');
    });
    const onShutdown = vi.fn();
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'x',
      onShutdown,
      isOpen: () => true,
    });

    await driveForward.salvageAfterDanceFailure();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('salvageAfterDanceFailure returns without issuing turn/start when isChoice returns true', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const isTerminal = vi.fn(() => {
      throw new Error('isTerminal must not be called when isChoice returns true');
    });
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal,
      composeActiveStateNudge: () => 'unused',
      onShutdown: () => {},
      isChoice: () => true,
    });

    await driveForward.salvageAfterDanceFailure();

    expect(isTerminal).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('returns without issuing turn/start when submittedThisTurn returns true (benign predicate)', async () => {
    // The dance's outer catch clears submittedThisTurn BEFORE invoking
    // salvage; this case should not occur in production. The predicate
    // is kept in the chain as defense-in-depth, so assert it short-
    // circuits the default branch rather than racing a second
    // turn/start.
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = makeStubClient({
      request: (async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request'],
    });
    const onShutdown = vi.fn();
    const driveForward = createDriveForward({
      client,
      activeThreadBinding: activeThread('p'),
      isTerminal: () => {
        throw new Error('isTerminal must not be called when submittedThisTurn returns true');
      },
      composeActiveStateNudge: () => 'unused',
      onShutdown,
      submittedThisTurn: () => true,
    });

    await driveForward.salvageAfterDanceFailure();

    expect(onShutdown).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
