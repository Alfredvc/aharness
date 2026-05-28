import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

import { runShutdown } from '../src/cli/shutdown.js';

describe('cli/shutdown sequence (Phase 1)', () => {
  it('closes WS before SIGTERMing the app-server, then reaps sockets', async () => {
    const order: string[] = [];
    const appServer = {
      close: vi.fn(async () => {
        order.push('app-close');
      }),
    };
    const client = {
      close: vi.fn(async () => {
        order.push('ws-close');
      }),
    };
    await runShutdown({
      appServer: appServer as any,
      client: client as any,
      runDir: { root: '/tmp/none', snapshotPath: '/tmp/none/snap.json' } as any,
    });
    expect(order).toEqual(['ws-close', 'app-close']);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(appServer.close).toHaveBeenCalledTimes(1);
  });

  it('still SIGTERMs the app-server when the WS close throws', async () => {
    const order: string[] = [];
    const appServer = {
      close: vi.fn(async () => {
        order.push('app-close');
      }),
    };
    const client = {
      close: vi.fn(async () => {
        order.push('ws-close-throw');
        throw new Error('ws already gone');
      }),
    };
    await runShutdown({
      appServer: appServer as any,
      client: client as any,
      runDir: { root: '/tmp/none', snapshotPath: '/tmp/none/snap.json' } as any,
    });
    expect(order).toEqual(['ws-close-throw', 'app-close']);
    expect(appServer.close).toHaveBeenCalledTimes(1);
  });

  it('reaps app-server.sock and hook.sock from runDir.root after the children are down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aharness-shutdown-'));
    try {
      const appSock = join(root, 'app-server.sock');
      const hookSock = join(root, 'hook.sock');
      writeFileSync(appSock, '');
      writeFileSync(hookSock, '');
      expect(existsSync(appSock)).toBe(true);
      expect(existsSync(hookSock)).toBe(true);

      await runShutdown({
        appServer: { close: vi.fn(async () => undefined) } as any,
        client: { close: vi.fn(async () => undefined) } as any,
        runDir: { root, snapshotPath: join(root, 'snap.json') } as any,
      });

      expect(existsSync(appSock)).toBe(false);
      expect(existsSync(hookSock)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not throw when the per-run sockets are already gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aharness-shutdown-'));
    try {
      // Sockets intentionally absent — runShutdown must be a no-op for reap.
      await expect(
        runShutdown({
          appServer: { close: vi.fn(async () => undefined) } as any,
          client: { close: vi.fn(async () => undefined) } as any,
          runDir: { root, snapshotPath: join(root, 'snap.json') } as any,
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
