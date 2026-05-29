/**
 * Tests for the `aharness` CLI dispatcher (Task 41).
 *
 * Drive `dispatch(argv, stubs)` and assert that argv parsing routes to
 * the right handler with the right arguments. No production handlers
 * are exercised — those live in their own test files.
 *
 * Phase 1b note: the `daemon-internal` and `mcp-internal` subcommands
 * were retired in T14a — the headless Phase 1 boot runs the daemon
 * in-process and codex's `dynamic_tools` channel replaces the MCP
 * child. Cases that exercised those subcommands have been removed.
 */
import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';

import { dispatch } from '../src/cli/main.js';
import { RESERVED_CLI_FLAGS } from '../src/cli/reservedFlags.js';

function buildStubs() {
  return {
    runVerify: vi.fn(async ({ fsmPath }: { fsmPath: string }) => {
      void fsmPath;
      return { exitCode: 0 };
    }),
    runDoctor: vi.fn(async () => ({ exitCode: 0 })),
    runDefault: vi.fn(async (o: { fsmPath: string; inputArgs: ReadonlyArray<string> }) => {
      void o;
      return { exitCode: 0 };
    }),
    runVisualize: vi.fn(async (o: { fsmPath: string; inputArgs: ReadonlyArray<string> }) => {
      void o;
      return { exitCode: 0 };
    }),
    runInit: vi.fn(
      async (o: {
        dir: string;
        force: boolean;
        git: boolean;
        install: boolean;
        pm?: 'npm' | 'pnpm' | 'yarn' | 'bun';
      }) => {
        void o;
        return { exitCode: 0 };
      },
    ),
    runInstall: vi.fn(async (o: { source: string }) => {
      void o;
      return { exitCode: 0 };
    }),
    runInstalled: vi.fn(async (o: { command: string; inputArgs: ReadonlyArray<string> }) => {
      void o;
      return { exitCode: 0 };
    }),
    runListInstalled: vi.fn(async () => ({ exitCode: 0 })),
    runVerifyInstalled: vi.fn(async (o: { target: string }) => {
      void o;
      return { exitCode: 0 };
    }),
    runUninstall: vi.fn(async (o: { packageName: string }) => {
      void o;
      return { exitCode: 0 };
    }),
  };
}

function captureStderr(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('dispatch', () => {
  it('routes "verify <file>" to runVerify with the path', async () => {
    const s = buildStubs();
    const r = await dispatch(['verify', 'foo.fsm.ts'], s);
    expect(r).toEqual({ exitCode: 0 });
    expect(s.runVerify).toHaveBeenCalledWith({ fsmPath: 'foo.fsm.ts' });
    expect(s.runDoctor).not.toHaveBeenCalled();
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('routes "doctor" to runDoctor', async () => {
    const s = buildStubs();
    await dispatch(['doctor'], s);
    expect(s.runDoctor).toHaveBeenCalledTimes(1);
    expect(s.runVerify).not.toHaveBeenCalled();
  });

  it('routes "visualize <file>" to runVisualize with author input flags', async () => {
    const s = buildStubs();
    const r = await dispatch(['visualize', 'workflow.fsm.ts', '--topic', 'auth', '--dry-run'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runVisualize).toHaveBeenCalledWith({
      fsmPath: 'workflow.fsm.ts',
      inputArgs: ['--topic', 'auth', '--dry-run'],
    });
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('routes "init --dir x" to runInit with defaults', async () => {
    const s = buildStubs();
    const r = await dispatch(['init', '--dir', 'my-app'], s);
    expect(r).toEqual({ exitCode: 0 });
    expect(s.runInit).toHaveBeenCalledWith({
      dir: 'my-app',
      force: false,
      git: true,
      install: true,
    });
  });

  it('routes "init --dir x --force --no-git --no-install --pm pnpm" with all flags', async () => {
    const s = buildStubs();
    const r = await dispatch(
      ['init', '--dir', 'my-app', '--force', '--no-git', '--no-install', '--pm', 'pnpm'],
      s,
    );
    expect(r).toEqual({ exitCode: 0 });
    expect(s.runInit).toHaveBeenCalledWith({
      dir: 'my-app',
      force: true,
      git: false,
      install: false,
      pm: 'pnpm',
    });
  });

  it('exits 2 when init is invoked without --dir', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['init'], { ...s, stderr: cap.stream });
    expect(r.exitCode).toBe(2);
    expect(s.runInit).not.toHaveBeenCalled();
    expect(cap.text()).toMatch(/usage/);
    // Asserts Step 6 (usage-text update) actually landed:
    expect(cap.text()).toMatch(/aharness init --dir/);
  });

  it('exits 2 when init --pm has an invalid value', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['init', '--dir', 'x', '--pm', 'badmgr'], {
      ...s,
      stderr: cap.stream,
    });
    expect(r.exitCode).toBe(2);
    expect(s.runInit).not.toHaveBeenCalled();
    // Confirm the user gets the usage hint (same path as the missing-`--dir` case).
    expect(cap.text()).toMatch(/usage/);
    expect(cap.text()).toMatch(/aharness init --dir/);
  });

  it('does not reserve "package" as a generated package namespace', async () => {
    const s = buildStubs();
    const r = await dispatch(['package'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runDefault).toHaveBeenCalledWith({
      fsmPath: 'package',
      inputArgs: [],
    });
  });

  it('returns usage for old generated package subcommands', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['package', 'build'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runDefault).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
    expect(cap.text()).not.toContain('aharness package build');
  });

  it('routes "install <source>" to the install CLI handler', async () => {
    const s = buildStubs();
    const r = await dispatch(['install', '@scope/tools@latest'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runInstall).toHaveBeenCalledWith({ source: '@scope/tools@latest' });
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('returns usage for malformed install invocations', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['install'],
      ['install', '@scope/tools', 'extra'],
      ['install', '--ignore-scripts'],
    ];

    for (const argv of cases) {
      const s = buildStubs();
      const cap = captureStderr();
      const r = await dispatch(argv, { ...s, stderr: cap.stream });

      expect(r).toEqual({ exitCode: 2 });
      expect(s.runInstall).not.toHaveBeenCalled();
      expect(cap.text()).toContain('aharness install <source>');
    }
  });

  it('keeps explicit install-like paths runnable through the default runner', async () => {
    const s = buildStubs();
    const dotSlash = await dispatch(['./install'], s);
    const fsmPath = await dispatch(['install.fsm.ts'], s);

    expect(dotSlash).toEqual({ exitCode: 0 });
    expect(fsmPath).toEqual({ exitCode: 0 });
    expect(s.runDefault).toHaveBeenNthCalledWith(1, {
      fsmPath: './install',
      inputArgs: [],
    });
    expect(s.runDefault).toHaveBeenNthCalledWith(2, {
      fsmPath: 'install.fsm.ts',
      inputArgs: [],
    });
    expect(s.runInstall).not.toHaveBeenCalled();
  });

  it('routes "run <command>" to installed command execution with author input flags', async () => {
    const s = buildStubs();
    const r = await dispatch(['run', '@scope/tools/build', '--topic', 'auth', '--dry-run'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runInstalled).toHaveBeenCalledWith({
      command: '@scope/tools/build',
      inputArgs: ['--topic', 'auth', '--dry-run'],
    });
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('returns usage for malformed run invocations', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['run'],
      ['run', 'build', 'extra'],
      ['run', '--topic', 'auth'],
    ];

    for (const argv of cases) {
      const s = buildStubs();
      const cap = captureStderr();
      const r = await dispatch(argv, { ...s, stderr: cap.stream });

      expect(r).toEqual({ exitCode: 2 });
      expect(s.runInstalled).not.toHaveBeenCalled();
      expect(cap.text()).toContain('aharness run <command>');
    }
  });

  it('routes top-level list to installed package listing', async () => {
    const s = buildStubs();
    const r = await dispatch(['list'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runListInstalled).toHaveBeenCalledWith({});
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('returns usage for malformed list invocations', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['list', 'extra'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runListInstalled).not.toHaveBeenCalled();
    expect(cap.text()).toContain('aharness list');
  });

  it('routes "uninstall <package-name>" to installed package removal', async () => {
    const s = buildStubs();
    const scoped = await dispatch(['uninstall', '@scope/tools'], s);
    const unscoped = await dispatch(['uninstall', 'tools'], s);

    expect(scoped).toEqual({ exitCode: 0 });
    expect(unscoped).toEqual({ exitCode: 0 });
    expect(s.runUninstall).toHaveBeenNthCalledWith(1, { packageName: '@scope/tools' });
    expect(s.runUninstall).toHaveBeenNthCalledWith(2, { packageName: 'tools' });
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('returns usage for malformed uninstall invocations', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['uninstall'],
      ['uninstall', 'tools', 'extra'],
      ['uninstall', '--package'],
    ];

    for (const argv of cases) {
      const s = buildStubs();
      const cap = captureStderr();
      const r = await dispatch(argv, { ...s, stderr: cap.stream });

      expect(r).toEqual({ exitCode: 2 });
      expect(s.runUninstall).not.toHaveBeenCalled();
      expect(cap.text()).toContain('aharness uninstall <package-name>');
    }
  });

  it('routes installed verify overloads while preserving direct file verify syntax', async () => {
    const s = buildStubs();

    await dispatch(['verify', 'workflow.fsm.ts'], s);
    await dispatch(['verify', './workflows/main.fsm.ts'], s);
    await dispatch(['verify', '@scope/tools'], s);
    await dispatch(['verify', '@scope/tools/build'], s);
    await dispatch(['verify', 'tools/build'], s);

    expect(s.runVerify).toHaveBeenNthCalledWith(1, { fsmPath: 'workflow.fsm.ts' });
    expect(s.runVerify).toHaveBeenNthCalledWith(2, { fsmPath: './workflows/main.fsm.ts' });
    expect(s.runVerifyInstalled).toHaveBeenNthCalledWith(1, { target: '@scope/tools' });
    expect(s.runVerifyInstalled).toHaveBeenNthCalledWith(2, { target: '@scope/tools/build' });
    expect(s.runVerifyInstalled).toHaveBeenNthCalledWith(3, { target: 'tools/build' });
  });

  it('keeps explicit run/list/verify-like paths runnable through the default runner', async () => {
    const s = buildStubs();

    await dispatch(['./run'], s);
    await dispatch(['run.fsm.ts'], s);
    await dispatch(['./list'], s);
    await dispatch(['list.fsm.ts'], s);
    await dispatch(['./verify'], s);
    await dispatch(['verify.fsm.ts'], s);
    await dispatch(['./uninstall'], s);
    await dispatch(['uninstall.fsm.ts'], s);

    expect(s.runDefault).toHaveBeenNthCalledWith(1, { fsmPath: './run', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(2, { fsmPath: 'run.fsm.ts', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(3, { fsmPath: './list', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(4, { fsmPath: 'list.fsm.ts', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(5, { fsmPath: './verify', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(6, { fsmPath: 'verify.fsm.ts', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(7, { fsmPath: './uninstall', inputArgs: [] });
    expect(s.runDefault).toHaveBeenNthCalledWith(8, { fsmPath: 'uninstall.fsm.ts', inputArgs: [] });
    expect(s.runInstalled).not.toHaveBeenCalled();
    expect(s.runListInstalled).not.toHaveBeenCalled();
    expect(s.runVerifyInstalled).not.toHaveBeenCalled();
    expect(s.runUninstall).not.toHaveBeenCalled();
  });

  it('keeps an explicit ./package path runnable through the default runner', async () => {
    const s = buildStubs();
    const r = await dispatch(['./package'], s);
    expect(r).toEqual({ exitCode: 0 });
    expect(s.runDefault).toHaveBeenCalledWith({
      fsmPath: './package',
      inputArgs: [],
    });
  });

  it('routes "<file>" to runDefault with no input args', async () => {
    const s = buildStubs();
    const r = await dispatch(['my.fsm.ts'], s);
    expect(r).toEqual({ exitCode: 0 });
    expect(s.runDefault).toHaveBeenCalledWith({
      fsmPath: 'my.fsm.ts',
      inputArgs: [],
    });
  });

  it('routes "<file> --resume" to runDefault as an author input flag', async () => {
    const s = buildStubs();
    await dispatch(['my.fsm.ts', '--resume'], s);
    expect(s.runDefault).toHaveBeenCalledWith({
      fsmPath: 'my.fsm.ts',
      inputArgs: ['--resume'],
    });
  });

  it('returns usage when "--resume" before the file path leaves no single FSM path', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['--resume', 'my.fsm.ts'], { ...s, stderr: cap.stream });
    expect(r).toEqual({ exitCode: 2 });
    expect(s.runDefault).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('returns 2 when the default form has no file path', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['--resume'], { ...s, stderr: cap.stream });
    expect(r).toEqual({ exitCode: 2 });
    expect(s.runDefault).not.toHaveBeenCalled();
  });

  it('returns 2 when "verify" is called without a path', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['verify'], { ...s, stderr: cap.stream });
    expect(r).toEqual({ exitCode: 2 });
    expect(s.runVerify).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('returns 2 when no argv is given', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch([], { ...s, stderr: cap.stream });
    expect(r).toEqual({ exitCode: 2 });
    expect(cap.text()).toContain('usage:');
    expect(cap.text()).not.toContain('aharness package init');
    expect(cap.text()).not.toContain('aharness package build');
    expect(cap.text()).not.toContain('aharness package verify');
    expect(cap.text()).toContain('aharness install <source>');
    expect(cap.text()).toContain('aharness run <command>');
    expect(cap.text()).toContain('aharness list');
    expect(cap.text()).toContain('aharness uninstall <package-name>');
    expect(cap.text()).toContain('aharness verify <package-name>');
    expect(cap.text()).not.toContain('[--resume]');
  });

  it('completion dispatcher returns within 600 ms even when the bridge hangs', async () => {
    // The 500 ms watchdog wired in `dispatch` (cli/main.ts) must bound the
    // bridge's wall time so a stuck import or a hanging dynamic-completion
    // callback (Task 21) cannot wedge the user's shell on Tab. Inject a
    // never-resolving bridge stub and assert dispatch returns under the
    // 600 ms guard with exit 0 (silent-error policy).
    const runCompletionBridge = vi.fn(() => new Promise<{ exitCode: number }>(() => {}));
    const start = Date.now();
    const r = await dispatch(['completion'], {
      runVerify: vi.fn(),
      runDoctor: vi.fn(),
      runDefault: vi.fn(),
      runCompletionInstall: vi.fn(),
      runCompletionUninstall: vi.fn(),
      runCompletionBridge,
    } as never);
    const elapsed = Date.now() - start;
    expect(r).toEqual({ exitCode: 0 });
    expect(elapsed).toBeLessThan(600);
    expect(runCompletionBridge).toHaveBeenCalledOnce();
  });
});

describe('dispatch — input flag passthrough', () => {
  it('collects unknown --flag <value> tokens into inputArgs', async () => {
    const runDefault = vi.fn(async () => ({ exitCode: 0 }));
    await dispatch(['/a/b/c.fsm.ts', '--ideafile-path', 'i.md', '--topic', 'x'], {
      runVerify: vi.fn(),
      runDoctor: vi.fn(),
      runDefault,
    } as never);
    expect(runDefault).toHaveBeenCalledWith({
      fsmPath: '/a/b/c.fsm.ts',
      inputArgs: ['--ideafile-path', 'i.md', '--topic', 'x'],
    });
  });

  it('treats bare boolean-style flags by passing the lone token (the parser decides)', async () => {
    const runDefault = vi.fn(async () => ({ exitCode: 0 }));
    await dispatch(['/a.fsm.ts', '--flag'], {
      runVerify: vi.fn(),
      runDoctor: vi.fn(),
      runDefault,
    } as never);
    expect(runDefault).toHaveBeenCalledWith({
      fsmPath: '/a.fsm.ts',
      inputArgs: ['--flag'],
    });
  });

  it('does not special-case --approval-policy when an FSM path is present', async () => {
    const runDefault = vi.fn(async () => ({ exitCode: 0 }));
    await dispatch(['/a.fsm.ts', '--approval-policy', 'on-request'], {
      runVerify: vi.fn(),
      runDoctor: vi.fn(),
      runDefault,
    } as never);

    expect(runDefault).toHaveBeenCalledWith({
      fsmPath: '/a.fsm.ts',
      inputArgs: ['--approval-policy', 'on-request'],
    });
  });

  it('returns usage for --approval-policy without an FSM path', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['--approval-policy', 'on-request'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runDefault).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('keeps approvalPolicy reachable as an author input flag', () => {
    expect(RESERVED_CLI_FLAGS.has('approval-policy')).toBe(false);
  });

  it('keeps resume reachable as an author input flag', () => {
    expect(RESERVED_CLI_FLAGS.has('resume')).toBe(false);
  });

  it('passes --resume combined with any --input flag through to author input parsing', async () => {
    const runDefault = vi.fn(async () => ({ exitCode: 0 }));
    const result = await dispatch(['/a.fsm.ts', '--resume', '--topic', 'auth'], {
      runVerify: vi.fn(),
      runDoctor: vi.fn(),
      runDefault,
    } as never);
    expect(result.exitCode).toBe(0);
    expect(runDefault).toHaveBeenCalledWith({
      fsmPath: '/a.fsm.ts',
      inputArgs: ['--resume', '--topic', 'auth'],
    });
  });
});
