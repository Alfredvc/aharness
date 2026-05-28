/**
 * Unit tests for `spawnAppServer` argv construction.
 *
 * Mocks `node:child_process.spawn` so we can capture the argv passed to
 * `codex app-server` without booting a real binary. Lives in its own file
 * to keep the module-level `vi.mock` from disturbing the e2e branch in
 * `appServer.spawn.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

const spawnMock = vi.fn();

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('../src/appServer/port.js', () => ({
  pickEphemeralPort: vi.fn(async () => 65500),
}));

vi.mock('../src/appServer/spawn.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/appServer/spawn.js')>();
  return actual;
});

interface FakeChild extends EventEmitter {
  stderr: EventEmitter & { setEncoding(enc: string): void };
  kill(signal: string): boolean;
}

function makeFakeChild(): FakeChild {
  const e = new EventEmitter() as FakeChild;
  const stderr = new EventEmitter() as FakeChild['stderr'];
  stderr.setEncoding = (): void => {};
  e.stderr = stderr;
  e.kill = (): boolean => true;
  return e;
}

describe('spawnAppServer argv construction', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds: app-server --listen <ws://...> with no -c or --enable when no overrides', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { spawnAppServer } = await import('../src/appServer/spawn.js');
    const promise = spawnAppServer({ host: '127.0.0.1' });

    // Make waitForWs fail-fast so the call rejects quickly. We only care
    // about the argv that was captured at spawn time.
    queueMicrotask(() => child.emit('exit', 1));
    await expect(promise).rejects.toBeDefined();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const callArgs = spawnMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('codex');
    const argv = callArgs[1] as string[];
    expect(argv).toEqual(['app-server', '--listen', 'ws://127.0.0.1:65500']);
  });

  it('appends --enable flags in declaration order, then -c flags in declaration order', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { spawnAppServer } = await import('../src/appServer/spawn.js');
    const promise = spawnAppServer({
      host: '127.0.0.1',
      cliOverrides: [
        ['foo.bar', 'true'],
        ['baz', '"quux"'],
      ],
      enabledFeatures: ['alpha', 'beta'],
    });

    queueMicrotask(() => child.emit('exit', 1));
    await expect(promise).rejects.toBeDefined();

    const callArgs = spawnMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('codex');
    const argv = callArgs[1] as string[];
    expect(argv).toEqual([
      'app-server',
      '--listen',
      'ws://127.0.0.1:65500',
      '--enable',
      'alpha',
      '--enable',
      'beta',
      '-c',
      'foo.bar=true',
      '-c',
      'baz="quux"',
    ]);
  });

  it('renders the source-verified approval_policy override as a generic -c config entry', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { spawnAppServer } = await import('../src/appServer/spawn.js');
    const promise = spawnAppServer({
      host: '127.0.0.1',
      cliOverrides: [['approval_policy', '"on-request"']],
      enabledFeatures: ['default_mode_request_user_input'],
    });

    queueMicrotask(() => child.emit('exit', 1));
    await expect(promise).rejects.toBeDefined();

    const callArgs = spawnMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('codex');
    const argv = callArgs[1] as string[];
    expect(argv).toEqual([
      'app-server',
      '--listen',
      'ws://127.0.0.1:65500',
      '--enable',
      'default_mode_request_user_input',
      '-c',
      'approval_policy="on-request"',
    ]);
  });

  it('does NOT set CODEX_HOME in env; merges process.env + extraEnv only', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { spawnAppServer } = await import('../src/appServer/spawn.js');
    const promise = spawnAppServer({
      host: '127.0.0.1',
      extraEnv: { HARNESS_TEST_ARGV_MARKER: '1' },
    });

    queueMicrotask(() => child.emit('exit', 1));
    await expect(promise).rejects.toBeDefined();

    const opts = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env['HARNESS_TEST_ARGV_MARKER']).toBe('1');
    // CODEX_HOME must not be injected by spawnAppServer; it inherits from
    // process.env if (and only if) the parent had it set.
    if (process.env['CODEX_HOME'] === undefined) {
      expect(opts.env['CODEX_HOME']).toBeUndefined();
    } else {
      expect(opts.env['CODEX_HOME']).toBe(process.env['CODEX_HOME']);
    }
  });
});

describe('spawnAppServer unix transport', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes --listen unix://<sockPath> when sockPath is supplied', async () => {
    const { spawnAppServerForTest } = await import('../src/appServer/spawn.js');

    const captured: { args?: string[] } = {};
    const fakeSpawn: typeof spawn = ((_cmd: string, args: string[]) => {
      captured.args = args.slice();
      return makeFakeChild();
    }) as unknown as typeof spawn;

    // Passing both `sockPath` and `host` is a usage error: spawn must
    // throw synchronously with a clear message before exec.
    await expect(
      spawnAppServerForTest({
        sockPath: '/tmp/harness/run-x/app-server.sock',
        host: '127.0.0.1',
        spawn: fakeSpawn,
        waitForReady: async () => undefined,
      }),
    ).rejects.toThrow(/exactly one of `sockPath` or `host`/);

    // With only `sockPath`, the argv must list `--listen unix://<path>`.
    await spawnAppServerForTest({
      sockPath: '/tmp/harness/run-x/app-server.sock',
      spawn: fakeSpawn,
      waitForReady: async () => undefined,
    });
    expect(captured.args).toEqual([
      'app-server',
      '--listen',
      'unix:///tmp/harness/run-x/app-server.sock',
    ]);
  });
});
