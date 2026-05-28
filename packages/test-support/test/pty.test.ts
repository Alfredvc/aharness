import { describe, expect, it } from 'vitest';

import { spawnPty } from '../src/index.js';

describe('spawnPty', () => {
  it('round-trips stdin write and stdout read', async () => {
    const handle = spawnPty({
      command: '/bin/sh',
      args: ['-c', 'printf hi:; read x; printf got=$x\\n; exit 0'],
      cwd: '/tmp',
      env: { ...process.env } as Record<string, string>,
    });
    let buf = '';
    handle.onData((c) => {
      buf += c;
    });
    await new Promise<void>((res) => {
      const stop = handle.onData((c) => {
        if ((buf + c).includes('hi:')) {
          stop();
          res();
        }
      });
    });
    handle.write('world\r');
    const exit = await handle.exit;
    expect(exit.code).toBe(0);
    expect(buf).toContain('got=world');
  });
});
