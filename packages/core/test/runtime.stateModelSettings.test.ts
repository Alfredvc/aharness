import { describe, expect, it, vi } from 'vitest';

import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';
import { createStateModelSettings } from '../src/runtime/stateModelSettings.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type { JsonRpcClient } from '../src/jsonrpc/client.js';

describe('state model settings gate', () => {
  it('can register a pending gate before the outbound settings request starts', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let resolveRequest!: () => void;
    const client = {
      request: async (method: string, params: unknown): Promise<unknown> => {
        requests.push({ method, params });
        return new Promise((resolve) => {
          resolveRequest = () => resolve({});
        });
      },
    } as unknown as Pick<JsonRpcClient, 'request'>;

    const settings = createStateModelSettings({
      client,
      activeThreadBinding: createActiveThreadBinding('thread-1'),
    });

    const pending = settings.prepareApplyForActiveState({
      stateId: 'b',
      model: 'gpt-5.1-codex',
    });
    let settled = false;
    const waitPromise = settings.waitForSettled().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(requests).toEqual([]);
    expect(settled).toBe(false);

    const applyPromise = pending.apply();
    await Promise.resolve();
    expect(requests).toEqual([
      {
        method: METHOD.threadSettingsUpdate,
        params: { threadId: 'thread-1', model: 'gpt-5.1-codex' },
      },
    ]);
    expect(settled).toBe(false);

    resolveRequest();
    await applyPromise;
    await waitPromise;
    expect(settled).toBe(true);
  });

  it('reports a prepared settings update failure once and keeps the gate rejected', async () => {
    const onFatal = vi.fn();
    const settings = createStateModelSettings({
      client: {
        request: async () => {
          throw new Error('settings rejected');
        },
      } as unknown as Pick<JsonRpcClient, 'request'>,
      activeThreadBinding: createActiveThreadBinding('thread-1'),
      onFatal,
    });

    const pending = settings.prepareApplyForActiveState({
      stateId: 'b',
      effort: 'high',
    });

    await expect(pending.apply()).rejects.toThrow('settings rejected');
    await expect(settings.waitForSettled()).rejects.toThrow('settings rejected');
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});
