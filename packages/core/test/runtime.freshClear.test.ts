import { describe, expect, it, vi } from 'vitest';

import { METHOD } from '../src/protocol/methodNames.js';
import type { DynamicToolDef } from '../src/protocol/types.js';
import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import { performFreshClear } from '../src/runtime/freshClear.js';

const dynamicTools: DynamicToolDef[] = [
  {
    name: 'aharness_submit',
    description: 'submit',
    inputSchema: { type: 'object' },
    readOnlyHint: true,
  },
];

function createClient(handler?: (method: string, params: unknown) => unknown): {
  readonly calls: Array<{ method: string; params: unknown }>;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (handler) return handler(method, params);
      if (method === METHOD.threadStart) {
        return { thread: { id: 'thread-new', ephemeral: false } };
      }
      if (method === METHOD.turnStart) {
        return { turn: { id: 'turn-new' } };
      }
      return {};
    },
  };
}

describe('performFreshClear', () => {
  it('classifies the old thread as abandoned before cleanup requests run', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const abandonedDuringCleanup: boolean[] = [];
    const client = createClient((method) => {
      if (method === METHOD.turnInterrupt || method === METHOD.threadUnsubscribe) {
        abandonedDuringCleanup.push(binding.isAbandoned('thread-old'));
      }
      if (method === METHOD.threadStart) {
        return { thread: { id: 'thread-new', ephemeral: false } };
      }
      if (method === METHOD.turnStart) {
        return { turn: { id: 'turn-new' } };
      }
      return {};
    });

    await performFreshClear({
      client,
      activeThreadBinding: binding,
      oldTurnId: 'turn-old',
      cwd: '/repo',
      dynamicTools,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: vi.fn(),
    });

    expect(abandonedDuringCleanup).toEqual([true, true]);
  });

  it('waits for pending model settings update before thread/start orientation', async () => {
    const binding = createActiveThreadBinding('thread-old');
    let release: (() => void) | null = null;
    const waitForSettled = async (): Promise<void> =>
      new Promise((resolve) => {
        release = resolve;
      });

    const client = createClient((method) => {
      if (method === METHOD.threadStart) return { thread: { id: 'thread-new', ephemeral: false } };
      if (method === METHOD.turnStart) return { turn: { id: 'turn-new' } };
      return {};
    });

    const clearPromise = performFreshClear({
      client,
      activeThreadBinding: binding,
      oldTurnId: 'turn-old',
      cwd: '/repo',
      dynamicTools,
      waitForSettled,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: vi.fn(),
    });

    // Let the function progress through cleanup and thread replacement;
    // no `turn/start` should happen until `waitForSettled` resolves.
    await Promise.resolve();
    await Promise.resolve();
    const methodsBeforeSettle = client.calls.map((call) => call.method);
    expect(methodsBeforeSettle).toEqual([
      METHOD.turnInterrupt,
      METHOD.threadUnsubscribe,
      METHOD.threadStart,
    ]);
    expect(client.calls.filter((call) => call.method === METHOD.turnStart)).toEqual([]);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(release).not.toBeUndefined();
    release?.();
    await clearPromise;
    expect(client.calls).toEqual([
      {
        method: METHOD.turnInterrupt,
        params: { threadId: 'thread-old', turnId: 'turn-old' },
      },
      { method: METHOD.threadUnsubscribe, params: { threadId: 'thread-old' } },
      {
        method: METHOD.threadStart,
        params: {
          cwd: '/repo',
          dynamicTools,
          sessionStartSource: 'clear',
        },
      },
      {
        method: METHOD.turnStart,
        params: {
          threadId: 'thread-new',
          input: [{ type: 'text', text: 'state orientation' }],
        },
      },
    ]);
  });

  it('interrupts and unsubscribes the old thread before starting and orienting a replacement', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const bindingDuringTurnStart: string[] = [];
    const client = createClient((method) => {
      if (method === METHOD.threadStart) {
        return { thread: { id: 'thread-new', ephemeral: false } };
      }
      if (method === METHOD.turnStart) {
        bindingDuringTurnStart.push(binding.require());
        return { turn: { id: 'turn-new' } };
      }
      return {};
    });

    const result = await performFreshClear({
      client,
      activeThreadBinding: binding,
      oldTurnId: 'turn-old',
      cwd: '/repo',
      dynamicTools,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: vi.fn(),
    });

    expect(client.calls).toEqual([
      {
        method: METHOD.turnInterrupt,
        params: { threadId: 'thread-old', turnId: 'turn-old' },
      },
      {
        method: METHOD.threadUnsubscribe,
        params: { threadId: 'thread-old' },
      },
      {
        method: METHOD.threadStart,
        params: {
          cwd: '/repo',
          dynamicTools,
          sessionStartSource: 'clear',
        },
      },
      {
        method: METHOD.turnStart,
        params: {
          threadId: 'thread-new',
          input: [{ type: 'text', text: 'state orientation' }],
        },
      },
    ]);
    expect(binding.current()).toBe('thread-new');
    expect(binding.isAbandoned('thread-old')).toBe(true);
    expect(bindingDuringTurnStart).toEqual(['thread-new']);
    expect(result).toEqual({
      previousThreadId: 'thread-old',
      nextThreadId: 'thread-new',
    });
  });

  it('skips old-turn interrupt when no old turn id is known', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const client = createClient();

    await performFreshClear({
      client,
      activeThreadBinding: binding,
      cwd: '/repo',
      dynamicTools,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: vi.fn(),
    });

    expect(client.calls.map((call) => call.method)).toEqual([
      METHOD.threadUnsubscribe,
      METHOD.threadStart,
      METHOD.turnStart,
    ]);
  });

  it('passes requested model and reasoning effort only on replacement thread/start', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const client = createClient();

    await performFreshClear({
      client,
      activeThreadBinding: binding,
      cwd: '/repo',
      model: 'gpt-5.1-codex',
      reasoningEffort: 'high',
      dynamicTools,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: vi.fn(),
    });

    expect(client.calls).toContainEqual({
      method: METHOD.threadStart,
      params: {
        cwd: '/repo',
        model: 'gpt-5.1-codex',
        config: { model_reasoning_effort: 'high' },
        dynamicTools,
        sessionStartSource: 'clear',
      },
    });
    expect(client.calls).toContainEqual({
      method: METHOD.turnStart,
      params: {
        threadId: 'thread-new',
        input: [{ type: 'text', text: 'state orientation' }],
      },
    });
  });

  it('does not send thread/start config when no reasoning effort is requested', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const client = createClient();

    await performFreshClear({
      client,
      activeThreadBinding: binding,
      cwd: '/repo',
      model: 'gpt-5.1-codex',
      dynamicTools,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: vi.fn(),
    });

    const threadStart = client.calls.find((call) => call.method === METHOD.threadStart);
    expect(threadStart?.params).toEqual({
      cwd: '/repo',
      model: 'gpt-5.1-codex',
      dynamicTools,
      sessionStartSource: 'clear',
    });
  });

  it('logs interrupt and unsubscribe cleanup errors without blocking replacement startup', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const cleanupErrors: string[] = [];
    const client = createClient((method) => {
      if (method === METHOD.turnInterrupt) throw new Error('expected active turn id x');
      if (method === METHOD.threadUnsubscribe) throw new Error('unsubscribe failed');
      if (method === METHOD.threadStart) {
        return { thread: { id: 'thread-new', ephemeral: false } };
      }
      if (method === METHOD.turnStart) {
        return { turn: { id: 'turn-new' } };
      }
      return {};
    });

    await performFreshClear({
      client,
      activeThreadBinding: binding,
      oldTurnId: 'turn-old',
      cwd: '/repo',
      dynamicTools,
      composeActiveStateNudge: () => 'state orientation',
      onCleanupError: (error) => cleanupErrors.push(error.message),
    });

    expect(binding.current()).toBe('thread-new');
    expect(cleanupErrors).toEqual(['unsubscribe failed']);
  });

  it('does not swap the binding when replacement thread/start fails', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const client = createClient((method) => {
      if (method === METHOD.threadStart) throw new Error('start failed');
      return {};
    });

    await expect(
      performFreshClear({
        client,
        activeThreadBinding: binding,
        cwd: '/repo',
        dynamicTools,
        composeActiveStateNudge: () => 'state orientation',
        onCleanupError: vi.fn(),
      }),
    ).rejects.toThrow(/start failed/);

    expect(binding.current()).toBe('thread-old');
    expect(client.calls.map((call) => call.method)).not.toContain(METHOD.turnStart);
  });

  it('does not return success metadata when replacement orientation fails after binding swap', async () => {
    const binding = createActiveThreadBinding('thread-old');
    const client = createClient((method) => {
      if (method === METHOD.threadStart) return { thread: { id: 'thread-new', ephemeral: false } };
      if (method === METHOD.turnStart) throw new Error('orientation failed');
      return {};
    });

    await expect(
      performFreshClear({
        client,
        activeThreadBinding: binding,
        cwd: '/repo',
        dynamicTools,
        composeActiveStateNudge: () => 'state orientation',
        onCleanupError: vi.fn(),
      }),
    ).rejects.toThrow(/orientation failed/);

    expect(binding.current()).toBe('thread-new');
  });
});
