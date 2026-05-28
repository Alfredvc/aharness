import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { launchBrowser, type BrowserLauncherSpawn } from '../src/ui/browserLauncher.js';

function makeSpawn() {
  const child = Object.assign(new EventEmitter(), {
    unref: vi.fn(),
  });
  const spawn = vi.fn(() => child) as unknown as BrowserLauncherSpawn & {
    mock: { calls: unknown[][] };
  };
  return { child, spawn };
}

describe('launchBrowser', () => {
  it.each([
    ['darwin', 'open', ['http://127.0.0.1:3000/']],
    ['win32', 'cmd', ['/c', 'start', '', 'http://127.0.0.1:3000/']],
    ['linux', 'xdg-open', ['http://127.0.0.1:3000/']],
    ['freebsd', 'xdg-open', ['http://127.0.0.1:3000/']],
  ] as const)('selects the platform opener for %s', (platform, command, args) => {
    const { spawn } = makeSpawn();

    const result = launchBrowser('http://127.0.0.1:3000/', { platform, spawn });

    expect(result).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(command, args, {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('uses detached ignored stdio and unreferences the opener process', () => {
    const { child, spawn } = makeSpawn();

    const result = launchBrowser('https://example.test/ui', { platform: 'darwin', spawn });

    expect(result).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith('open', ['https://example.test/ui'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it.each(['file:///tmp/index.html', 'ftp://example.test/', 'javascript:alert(1)', 'not a url'])(
    'rejects unsupported URL schemes before spawning: %s',
    (url) => {
      const { spawn } = makeSpawn();

      const result = launchBrowser(url, { platform: 'linux', spawn });

      expect(result).toMatchObject({
        ok: false,
        reason: 'invalid-url',
      });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('returns a structured failure when spawn throws', () => {
    const spawn = vi.fn(() => {
      throw new Error('no opener');
    }) as unknown as BrowserLauncherSpawn;

    const result = launchBrowser('http://127.0.0.1:3000/', {
      platform: 'linux',
      spawn,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'spawn-failed',
      message: 'no opener',
    });
  });

  it('swallows asynchronous opener error events after spawn succeeds', () => {
    const { child, spawn } = makeSpawn();

    const result = launchBrowser('http://127.0.0.1:3000/', {
      platform: 'linux',
      spawn,
    });

    expect(result).toEqual({ ok: true });
    expect(() => child.emit('error', new Error('xdg-open missing'))).not.toThrow();
    expect(child.listenerCount('error')).toBe(0);
  });
});
