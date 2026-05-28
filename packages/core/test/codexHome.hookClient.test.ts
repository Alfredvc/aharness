import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeFramed, parseFramedRequest } from '../src/protocol/wireFraming.js';
import { resolveHookClientPath } from '../src/codexHome/materialize.js';

const HOOK_CLIENT = resolveHookClientPath();

function tempSock(): string {
  return join(mkdtempSync(join(tmpdir(), 'hcclient-')), 's');
}

describe('hookClient.cjs', () => {
  it('frames stdin with the explicit hook tag and prints reply body to stdout', async () => {
    const path = tempSock();
    let received: Buffer = Buffer.alloc(0);
    const server = createServer({ allowHalfOpen: true }, (c) => {
      c.on('data', (d) => {
        received = Buffer.concat([received, d]);
      });
      c.on('end', () => {
        c.write(encodeFramed('OK', JSON.stringify({ decision: 'block', reason: 'go on' })));
        c.end();
      });
    });
    await new Promise<void>((r) => server.listen(path, r));

    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', x: 1 });
    const child = spawn('node', [HOOK_CLIENT, 'PRE_TOOL_USE', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s: string) => {
      stdout += s;
    });
    child.stdin.write(stdin);
    child.stdin.end();
    const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? 0)));
    expect(code).toBe(0);

    const parsed = parseFramedRequest(received);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.type).toBe('PRE_TOOL_USE');
      expect(JSON.parse(parsed.value.body)).toEqual({ hook_event_name: 'PreToolUse', x: 1 });
    }
    expect(JSON.parse(stdout)).toEqual({ decision: 'block', reason: 'go on' });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('exits 1 with diagnostic when stdin stays idle past the watchdog timeout', async () => {
    // Defensive: codex's hook timeout is 30 s; if codex spawns the
    // hook but never closes stdin, we must surface a clean error
    // before codex SIGKILLs the script (at which point the daemon
    // never observes the hook fire). HARNESS_HOOK_STDIN_TIMEOUT_MS
    // overrides the default 28 s for fast tests.
    const path = tempSock();
    // Spin up an idle UDS server so connect() won't fail before the
    // watchdog has a chance to fire — though in this test the script
    // should never reach the connect path because stdin never ends.
    const server = createServer(() => {
      /* never accept; we won't get here */
    });
    await new Promise<void>((r) => server.listen(path, r));

    const TIMEOUT_MS = 200;
    const child = spawn('node', [HOOK_CLIENT, 'PRE_TOOL_USE', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HARNESS_HOOK_STDIN_TIMEOUT_MS: String(TIMEOUT_MS) },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s: string) => {
      stderr += s;
    });
    // Deliberately do NOT close stdin. Keep the writable side open so
    // the script can't observe 'end' and is forced to wait on the
    // watchdog.

    const t0 = Date.now();
    const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? 0)));
    const elapsed = Date.now() - t0;

    expect(code).toBe(1);
    expect(stderr).toMatch(/stdin inactivity timeout/);
    // Watchdog should fire near TIMEOUT_MS, not at the 28 s default.
    // Allow generous slack for spawn/exit overhead but bound it well
    // under the production default.
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);

    // Ensure we close the writable side now to release the child's
    // pipe — the child has exited so this is just resource hygiene.
    child.stdin.end();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('exits 1 with stderr if the daemon replies ERROR', async () => {
    const path = tempSock();
    const server = createServer({ allowHalfOpen: true }, (c) => {
      // Resume the stream so 'end' fires after the client FINs. Without a
      // 'data' listener (or resume), Node leaves the readable side paused
      // and never reaches 'end'.
      c.resume();
      c.on('end', () => {
        c.write(encodeFramed('ERROR', JSON.stringify({ message: 'oops' })));
        c.end();
      });
    });
    await new Promise<void>((r) => server.listen(path, r));

    const child = spawn('node', [HOOK_CLIENT, 'PRE_TOOL_USE', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s: string) => {
      stderr += s;
    });
    child.stdin.write('{}');
    child.stdin.end();
    const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? 0)));
    expect(code).toBe(1);
    expect(stderr).toMatch(/oops/);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('hookClient.cjs — tag argument', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) c();
  });

  function startServer(): Promise<{ path: string; framedRequests: string[] }> {
    return new Promise((res) => {
      const root = mkdtempSync(join(tmpdir(), 'h-hc-'));
      const sockPath = join(root, 'hook.sock');
      const framedRequests: string[] = [];
      const server = createServer({ allowHalfOpen: true }, (c) => {
        const chunks: Buffer[] = [];
        c.on('data', (d) => chunks.push(d));
        c.on('end', () => {
          framedRequests.push(Buffer.concat(chunks).toString('utf8'));
          const body = '{}';
          c.write(`OK ${Buffer.byteLength(body, 'utf8')}\n${body}`);
          c.end();
        });
      });
      cleanup.push(() => server.close());
      server.listen(sockPath, () => res({ path: sockPath, framedRequests }));
    });
  }

  it.each([['PRE_TOOL_USE'], ['POST_TOOL_USE'], ['USER_PROMPT_SUBMIT']] as const)(
    'forwards stdin with the %s tag',
    async (tag) => {
      const { path, framedRequests } = await startServer();
      const child = spawn(process.execPath, [HOOK_CLIENT, tag, path], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HARNESS_HOOK_STDIN_TIMEOUT_MS: '500' },
      });
      child.stdin.write('{"hook_event_name":"X"}');
      child.stdin.end();
      const code: number = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));
      expect(code).toBe(0);
      expect(framedRequests).toHaveLength(1);
      expect(framedRequests[0]).toMatch(new RegExp(`^${tag} `));
    },
  );

  it('requires an explicit framing tag argument', async () => {
    const { path, framedRequests } = await startServer();
    const child = spawn(process.execPath, [HOOK_CLIENT, path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HARNESS_HOOK_STDIN_TIMEOUT_MS: '500' },
    });
    child.stdin.write('{}');
    child.stdin.end();
    const code: number = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));
    expect(code).toBe(2);
    expect(framedRequests).toHaveLength(0);
  });

  it.each([['BOGUS'], ['STOP_HOOK'], ['MCP_SUBMIT']] as const)(
    'exits 2 with diagnostic on unsupported tag %s',
    async (tag) => {
      const { path } = await startServer();
      const child = spawn(process.execPath, [HOOK_CLIENT, tag, path], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => (stderr += d));
      const code: number = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));
      expect(code).toBe(2);
      expect(stderr).toMatch(/unknown framing tag/);
    },
  );
});
