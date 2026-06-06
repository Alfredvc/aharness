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
import type { RunPermissionMode } from '../src/cli/runCli.js';

function buildStubs() {
  return {
    runVerifyTarget: vi.fn(async (o: { target: string }) => {
      void o;
      return { exitCode: 0 };
    }),
    runDoctor: vi.fn(async () => ({ exitCode: 0 })),
    runVisualize: vi.fn(async (o: { fsmPath: string; inputArgs: ReadonlyArray<string> }) => {
      void o;
      return { exitCode: 0 };
    }),
    runView: vi.fn(async (o: { runId?: string }) => {
      void o;
      return { exitCode: 0 };
    }),
    runCompletionInstall: vi.fn(
      async (o: { name?: string; completer?: string; shell?: 'bash' | 'zsh' | 'fish' }) => {
        void o;
        return { exitCode: 0 };
      },
    ),
    runCompletionUninstall: vi.fn(async (o: { name?: string }) => {
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
    runTarget: vi.fn(
      async (o: {
        target: string;
        inputArgs: ReadonlyArray<string>;
        permissionMode?: RunPermissionMode;
        noOpen?: boolean;
      }) => {
        void o;
        return { exitCode: 0 };
      },
    ),
    runTargetInputHelp: vi.fn(async (o: { target: string }) => {
      void o;
      return { exitCode: 0 };
    }),
    runListInstalled: vi.fn(async () => ({ exitCode: 0 })),
    runUninstall: vi.fn(async (o: { packageName: string }) => {
      void o;
      return { exitCode: 0 };
    }),
  };
}

type DispatcherStubs = ReturnType<typeof buildStubs>;

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

function expectNoHandlersCalled(s: DispatcherStubs): void {
  expect(s.runVerifyTarget).not.toHaveBeenCalled();
  expect(s.runDoctor).not.toHaveBeenCalled();
  expect(s.runVisualize).not.toHaveBeenCalled();
  expect(s.runView).not.toHaveBeenCalled();
  expect(s.runCompletionInstall).not.toHaveBeenCalled();
  expect(s.runCompletionUninstall).not.toHaveBeenCalled();
  expect(s.runInit).not.toHaveBeenCalled();
  expect(s.runInstall).not.toHaveBeenCalled();
  expect(s.runTarget).not.toHaveBeenCalled();
  expect(s.runTargetInputHelp).not.toHaveBeenCalled();
  expect(s.runListInstalled).not.toHaveBeenCalled();
  expect(s.runUninstall).not.toHaveBeenCalled();
}

async function expectUsageOnly(argv: ReadonlyArray<string>): Promise<string> {
  const s = buildStubs();
  const cap = captureStderr();
  const r = await dispatch(argv, { ...s, stderr: cap.stream });

  expect(r).toEqual({ exitCode: 2 });
  expectNoHandlersCalled(s);
  expect(cap.text()).toContain('usage:');
  expect(cap.text()).not.toContain('aharness [--ask|--yolo] <file.fsm.ts> [--<flag> <value>]...');

  return cap.text();
}

describe('dispatch', () => {
  it('routes "verify <target>" to target verification with the target token', async () => {
    const s = buildStubs();
    const r = await dispatch(['verify', 'foo.fsm.ts'], s);
    expect(r).toEqual({ exitCode: 0 });
    expect(s.runVerifyTarget).toHaveBeenCalledWith({ target: 'foo.fsm.ts' });
    expect(s.runDoctor).not.toHaveBeenCalled();
  });

  it('routes "doctor" to runDoctor', async () => {
    const s = buildStubs();
    await dispatch(['doctor'], s);
    expect(s.runDoctor).toHaveBeenCalledTimes(1);
    expect(s.runVerifyTarget).not.toHaveBeenCalled();
  });

  it('routes "visualize <file>" to runVisualize with author input flags', async () => {
    const s = buildStubs();
    const r = await dispatch(['visualize', 'workflow.fsm.ts', '--topic', 'auth', '--dry-run'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runVisualize).toHaveBeenCalledWith({
      fsmPath: 'workflow.fsm.ts',
      inputArgs: ['--topic', 'auth', '--dry-run'],
    });
  });

  it('returns usage for exact direct local FSM help without routing handlers', async () => {
    await expectUsageOnly(['workflow.fsm.ts', '--help']);
  });

  it('returns usage for visualize with --yolo instead of treating it as author input', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['visualize', '/a.fsm.ts', '--yolo'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runVisualize).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('returns usage for visualize with --ask instead of treating it as author input', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['visualize', '/a.fsm.ts', '--ask'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runVisualize).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('returns usage for visualize with --no-open instead of treating it as author input', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['visualize', '/a.fsm.ts', '--no-open'], {
      ...s,
      stderr: cap.stream,
    });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runVisualize).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
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

  it('returns usage for package-like root invocations without generated package hints', async () => {
    const text = await expectUsageOnly(['package']);
    expect(text).not.toContain('aharness package build');
  });

  it('returns usage for old generated package subcommands', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['package', 'build'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expectNoHandlersCalled(s);
    expect(cap.text()).toContain('usage:');
    expect(cap.text()).not.toContain('aharness package build');
  });

  it('routes "install <source>" to the install CLI handler', async () => {
    const s = buildStubs();
    const r = await dispatch(['install', '@scope/tools@latest'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runInstall).toHaveBeenCalledWith({ source: '@scope/tools@latest' });
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

  it('returns usage for explicit install-like root direct invocations', async () => {
    await expectUsageOnly(['./install']);
    await expectUsageOnly(['install.fsm.ts']);
  });

  it('routes "run <command>" to target execution with author input flags', async () => {
    const s = buildStubs();
    const r = await dispatch(['run', '@scope/tools/build', '--topic', 'auth'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runTarget).toHaveBeenCalledWith({
      target: '@scope/tools/build',
      inputArgs: ['--topic', 'auth'],
    });
  });

  it('routes exact run-target help before normal run routing', async () => {
    const s = buildStubs();
    const r = await dispatch(['run', './workflow.fsm.ts', '--help'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runTargetInputHelp).toHaveBeenCalledWith({ target: './workflow.fsm.ts' });
    expect(s.runTarget).not.toHaveBeenCalled();
  });

  it('routes "run --ask <target>" with ask mode and clean input args', async () => {
    const s = buildStubs();
    const r = await dispatch(['run', '--ask', './workflow.fsm.ts', '--topic', 'auth'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runTarget).toHaveBeenCalledWith({
      target: './workflow.fsm.ts',
      inputArgs: ['--topic', 'auth'],
      permissionMode: 'ask',
    });
  });

  it('routes "run --yolo <target>" with yolo mode and clean input args', async () => {
    const s = buildStubs();
    const r = await dispatch(['run', '--yolo', './workflow.fsm.ts', '--topic', 'auth'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runTarget).toHaveBeenCalledWith({
      target: './workflow.fsm.ts',
      inputArgs: ['--topic', 'auth'],
      permissionMode: 'yolo',
    });
  });

  it('routes "run --no-open <target>" with browser auto-open disabled', async () => {
    const s = buildStubs();
    const r = await dispatch(['run', '--no-open', './workflow.fsm.ts', '--topic', 'auth'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runTarget).toHaveBeenCalledWith({
      target: './workflow.fsm.ts',
      inputArgs: ['--topic', 'auth'],
      noOpen: true,
    });
  });

  it('routes composable leading run runtime flags before the target', async () => {
    const s = buildStubs();
    const r = await dispatch(
      ['run', '--no-open', '--ask', './workflow.fsm.ts', '--topic', 'auth'],
      s,
    );

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runTarget).toHaveBeenCalledWith({
      target: './workflow.fsm.ts',
      inputArgs: ['--topic', 'auth'],
      permissionMode: 'ask',
      noOpen: true,
    });
  });

  it('returns usage when run input flags appear before the target', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['run', '--topic', 'auth', './workflow.fsm.ts'], {
      ...s,
      stderr: cap.stream,
    });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain(
      'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
    );
  });

  it('returns usage for unsupported run help-like forms without normal run routing', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['run', '--ask', './workflow.fsm.ts', '--help'],
      ['run', './workflow.fsm.ts', '--topic', 'auth', '--help'],
      ['run', './workflow.fsm.ts', '--help', '--topic', 'auth'],
    ];

    for (const argv of cases) {
      const s = buildStubs();
      const cap = captureStderr();
      const r = await dispatch(argv, { ...s, stderr: cap.stream });

      expect(r).toEqual({ exitCode: 2 });
      expect(s.runTarget).not.toHaveBeenCalled();
      expect(s.runTargetInputHelp).not.toHaveBeenCalled();
      expect(cap.text()).toContain('usage:');
    }
  });

  it('returns usage when run --ask appears after the target', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['run', './workflow.fsm.ts', '--ask'], {
      ...s,
      stderr: cap.stream,
    });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain(
      'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
    );
  });

  it('returns usage when run --yolo appears after the target', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['run', './workflow.fsm.ts', '--yolo'], {
      ...s,
      stderr: cap.stream,
    });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain(
      'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
    );
  });

  it('returns usage when run --no-open appears after the target', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['run', './workflow.fsm.ts', '--no-open'], {
      ...s,
      stderr: cap.stream,
    });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain(
      'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
    );
  });

  it('returns usage when run mixes --ask and --yolo', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['run', '--ask', '--yolo', './workflow.fsm.ts'],
      ['run', '--yolo', '--ask', './workflow.fsm.ts'],
      ['run', '--ask', './workflow.fsm.ts', '--yolo'],
      ['run', '--yolo', './workflow.fsm.ts', '--ask'],
    ];

    for (const argv of cases) {
      const s = buildStubs();
      const cap = captureStderr();
      const r = await dispatch(argv, { ...s, stderr: cap.stream });

      expect(r).toEqual({ exitCode: 2 });
      expect(s.runTarget).not.toHaveBeenCalled();
      expect(cap.text()).toContain('usage:');
    }
  });

  it('returns usage when run repeats --no-open', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['run', '--no-open', '--no-open', './workflow.fsm.ts'], {
      ...s,
      stderr: cap.stream,
    });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('returns usage for unknown run framework flags before the target', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['run', '-x', 'build'], { ...s, stderr: cap.stream });

    expect(r).toEqual({ exitCode: 2 });
    expect(s.runTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain(
      'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
    );
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
      expect(s.runTarget).not.toHaveBeenCalled();
      expect(cap.text()).toContain(
        'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
      );
    }
  });

  it('routes top-level list to installed package listing', async () => {
    const s = buildStubs();
    const r = await dispatch(['list'], s);

    expect(r).toEqual({ exitCode: 0 });
    expect(s.runListInstalled).toHaveBeenCalledWith({});
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

  it('routes verify targets through the unified target handler', async () => {
    const s = buildStubs();

    await dispatch(['verify', 'workflow.fsm.ts'], s);
    await dispatch(['verify', './workflows/main.fsm.ts'], s);
    await dispatch(['verify', 'build'], s);
    await dispatch(['verify', '@scope/tools'], s);
    await dispatch(['verify', '@scope/tools/build'], s);
    await dispatch(['verify', 'tools/build'], s);

    expect(s.runVerifyTarget).toHaveBeenNthCalledWith(1, { target: 'workflow.fsm.ts' });
    expect(s.runVerifyTarget).toHaveBeenNthCalledWith(2, {
      target: './workflows/main.fsm.ts',
    });
    expect(s.runVerifyTarget).toHaveBeenNthCalledWith(3, { target: 'build' });
    expect(s.runVerifyTarget).toHaveBeenNthCalledWith(4, { target: '@scope/tools' });
    expect(s.runVerifyTarget).toHaveBeenNthCalledWith(5, { target: '@scope/tools/build' });
    expect(s.runVerifyTarget).toHaveBeenNthCalledWith(6, { target: 'tools/build' });
  });

  it('returns usage for explicit run/list/verify-like root direct invocations', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['./run'],
      ['run.fsm.ts'],
      ['./list'],
      ['list.fsm.ts'],
      ['./verify'],
      ['verify.fsm.ts'],
      ['./uninstall'],
      ['uninstall.fsm.ts'],
    ];

    for (const argv of cases) {
      await expectUsageOnly(argv);
    }
  });

  it('does not route replay helper names as public CLI subcommands', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['replay', 'events.jsonl', '1'],
      ['replay-prefix', 'events.jsonl', '1'],
    ];

    for (const argv of cases) {
      await expectUsageOnly(argv);
    }
  });

  it('returns usage for an explicit ./package root direct invocation', async () => {
    const text = await expectUsageOnly(['./package']);
    expect(text).not.toContain('aharness package build');
  });

  it('returns usage for bare and path-like root direct FSM paths without routing handlers', async () => {
    await expectUsageOnly(['my.fsm.ts']);
    await expectUsageOnly(['./x.fsm.ts']);
  });

  it('returns usage for unsupported direct help-like forms without routing handlers', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['--help'],
      ['help'],
      ['workflow.fsm.ts', '--topic', 'auth', '--help'],
      ['workflow.fsm.ts', '--help', '--topic', 'auth'],
      ['--ask', 'workflow.fsm.ts', '--help'],
      ['workflow', '--help'],
      ['visualize', 'workflow.fsm.ts', '--help'],
      ['verify', 'workflow.fsm.ts', '--help'],
      ['doctor', '--help'],
      ['completion', 'install', '--help'],
    ];

    for (const argv of cases) {
      await expectUsageOnly(argv);
    }
  });

  it('returns usage for "--ask <file>" root direct invocations', async () => {
    await expectUsageOnly(['--ask', '/a.fsm.ts', '--topic', 'auth']);
  });

  it('returns usage for "<file> --ask" root direct invocations', async () => {
    await expectUsageOnly(['/a.fsm.ts', '--ask', '--topic', 'auth']);
  });

  it('returns usage for "--yolo <file>" root direct invocations', async () => {
    await expectUsageOnly(['--yolo', '/a.fsm.ts', '--topic', 'auth']);
  });

  it('returns usage for "<file> --yolo" root direct invocations', async () => {
    await expectUsageOnly(['/a.fsm.ts', '--yolo', '--topic', 'auth']);
  });

  it('returns usage for "--no-open <file>" root direct invocations', async () => {
    await expectUsageOnly(['--no-open', '/a.fsm.ts', '--topic', 'auth']);
  });

  it('returns usage for "<file> --no-open" root direct invocations', async () => {
    await expectUsageOnly(['/a.fsm.ts', '--no-open', '--topic', 'auth']);
  });

  it('returns usage when root direct invocations mix --ask and --yolo', async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ['--ask', '--yolo', '/a.fsm.ts'],
      ['--yolo', '/a.fsm.ts', '--ask'],
    ];

    for (const argv of cases) {
      await expectUsageOnly(argv);
    }
  });

  it('returns usage for "<file> --resume" root direct invocations', async () => {
    await expectUsageOnly(['my.fsm.ts', '--resume']);
  });

  it('returns usage for "--resume <file>" root direct invocations', async () => {
    await expectUsageOnly(['--resume', 'my.fsm.ts']);
  });

  it('returns 2 when root direct flags have no file path', async () => {
    await expectUsageOnly(['--resume']);
  });

  it('returns 2 when "verify" is called without a path', async () => {
    const s = buildStubs();
    const cap = captureStderr();
    const r = await dispatch(['verify'], { ...s, stderr: cap.stream });
    expect(r).toEqual({ exitCode: 2 });
    expect(s.runVerifyTarget).not.toHaveBeenCalled();
    expect(cap.text()).toContain('usage:');
  });

  it('returns 2 when no argv is given', async () => {
    const text = await expectUsageOnly([]);
    expect(text).not.toContain('aharness package init');
    expect(text).not.toContain('aharness package build');
    expect(text).not.toContain('aharness package verify');
    expect(text).toContain('aharness install <source>');
    expect(text).not.toContain('aharness [--ask|--yolo] <file.fsm.ts> [--<flag> <value>]...');
    expect(text).toContain(
      'aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<flag> <value>]...',
    );
    expect(text).toContain('aharness list');
    expect(text).toContain('aharness uninstall <package-name>');
    expect(text).toContain('aharness verify <command>');
    expect(text).toContain('aharness verify <package>/<command>');
    expect(text).not.toContain('aharness verify <package-name>');
    expect(text).toContain('aharness view [run-id]');
    expect(text).not.toContain('[--resume]');
  });

  it('returns usage for bare completion without install or uninstall', async () => {
    await expectUsageOnly(['completion']);
  });

  it('returns usage for hidden completion traffic on the public dispatcher', async () => {
    await expectUsageOnly(['completion-server', '--', 'aharness', 'visualize']);
  });
});

describe('dispatch — retired direct input passthrough', () => {
  it('returns usage for root direct unknown --flag <value> tokens', async () => {
    await expectUsageOnly(['/a/b/c.fsm.ts', '--ideafile-path', 'i.md', '--topic', 'x']);
  });

  it('returns usage for root direct bare boolean-style flags', async () => {
    await expectUsageOnly(['/a.fsm.ts', '--flag']);
  });

  it('returns usage for root direct --approval-policy with an FSM path', async () => {
    await expectUsageOnly(['/a.fsm.ts', '--approval-policy', 'on-request']);
  });

  it('returns usage for --approval-policy without an FSM path', async () => {
    await expectUsageOnly(['--approval-policy', 'on-request']);
  });

  it('does not reserve approval-policy as a framework runtime flag', () => {
    expect(RESERVED_CLI_FLAGS.has('approval-policy')).toBe(false);
  });

  it('reserves ask as a framework runtime flag', () => {
    expect(RESERVED_CLI_FLAGS.has('ask')).toBe(true);
  });

  it('reserves no-open as a framework runtime flag', () => {
    expect(RESERVED_CLI_FLAGS.has('no-open')).toBe(true);
  });

  it('does not reserve resume as a framework runtime flag', () => {
    expect(RESERVED_CLI_FLAGS.has('resume')).toBe(false);
  });

  it('reserves yolo as a framework runtime flag', () => {
    expect(RESERVED_CLI_FLAGS.has('yolo')).toBe(true);
  });

  it('returns usage for root direct --resume combined with any --input flag', async () => {
    await expectUsageOnly(['/a.fsm.ts', '--resume', '--topic', 'auth']);
  });
});
