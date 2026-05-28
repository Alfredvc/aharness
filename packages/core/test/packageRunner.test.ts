import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { runPackagedFsmCli } from '@aharness/core/package-runner';
import {
  discoverValidatedPackageCommands,
  loadValidatedPackageConfig,
} from '../src/fsmPackage/context.js';
import { runPackagedFsmCliForTest } from '../src/fsmPackage/runner.js';
import type { LoadFsmResult } from '../src/loader/index.js';

function tmpPackage(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'harness-package-runner-'));
}

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function packageRootUrl(root: string): URL {
  return pathToFileURL(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

async function writePackage(
  root: string,
  opts: {
    readonly commands: readonly string[];
    readonly files?: readonly string[];
    readonly metadata?: Record<string, { readonly target?: string; readonly description?: string }>;
  },
): Promise<void> {
  await mkdir(path.join(root, 'fsms'), { recursive: true });
  for (const command of opts.commands) {
    await writeFile(path.join(root, 'fsms', `${command}.fsm.ts`), 'export default {};\n');
  }

  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: '@aharness/example',
        version: '1.2.3',
        bin: {
          'ah-example': './bin/ah-example.mjs',
        },
        files: opts.files ?? ['bin', 'fsms', 'skills'],
        dependencies: {
          '@aharness/core': '^0.1.0',
        },
        harness: {
          package: {
            bin: 'ah-example',
            fsmsDir: 'fsms',
            ...(opts.metadata ? { commands: opts.metadata } : {}),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runRunner(
  root: string,
  argv: ReadonlyArray<string>,
  deps: Parameters<typeof runPackagedFsmCliForTest>[1] = {},
  cwd = root,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runPackagedFsmCliForTest(
    {
      packageRootUrl: packageRootUrl(root),
      argv,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
    },
    deps,
  );
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function loadedFsmWithInput(): LoadFsmResult {
  return {
    machine: {} as LoadFsmResult['machine'],
    sidecar: {},
    modulePath: '/tmp/fsm.mjs',
    issues: [],
    cacheHit: false,
    hash: 'hash',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        dryRun: { type: 'boolean' },
        rounds: { type: 'integer' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    inputFlags: {
      topic: { description: 'Project topic' },
      dryRun: { description: 'Do not execute', default: false },
      rounds: { default: 3 },
    },
  };
}

describe('@aharness/core/package-runner', () => {
  it('is importable through the public Vitest alias and prints package version', async () => {
    const root = tmpPackage();
    await writePackage(root, { commands: ['writing-plans'] });
    const stdout = captureStream();
    const stderr = captureStream();

    const exitCode = await runPackagedFsmCli({
      packageRootUrl: packageRootUrl(root),
      argv: ['version'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe('@aharness/example 1.2.3\n');
    expect(stderr.text()).toBe('');
  });

  it('lists commands sorted by displayed name and renders aliases to their targets', async () => {
    const root = tmpPackage();
    await writePackage(root, {
      commands: ['writing-plans', 'reviewing-code'],
      metadata: {
        'writing-plans': { description: 'Write an implementation plan' },
        'reviewing-code': { description: 'Review code changes' },
        plan: { target: 'writing-plans', description: 'Alias for writing-plans' },
      },
    });

    const result = await runRunner(root, ['list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([
      'plan            Alias for writing-plans -> writing-plans',
      'reviewing-code  Review code changes',
      'writing-plans   Write an implementation plan',
    ]);
  });

  it('prints package usage and command input flags without executing the FSM', async () => {
    const root = tmpPackage();
    const callerRoot = tmpPackage();
    await writePackage(root, { commands: ['writing-plans'] });
    const loadFsmImpl = vi.fn(async () => loadedFsmWithInput());
    const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runRunner(
      root,
      ['help', 'writing-plans'],
      { loadFsm: loadFsmImpl, runCli: runCliImpl },
      callerRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(runCliImpl).not.toHaveBeenCalled();
    expect(loadFsmImpl).toHaveBeenCalledWith({
      filePath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
      repoRoot: callerRoot,
    });
    expect(result.stdout).toContain('usage:\n  ah-example writing-plans [--<flag> <value>]...');
    expect(result.stdout).toContain('--dry-run           Do not execute; default: false');
    expect(result.stdout).toContain('--rounds <integer>  default: 3');
    expect(result.stdout).toContain('--topic <string>    Project topic');
  });

  it('verifies every FSM or only one resolved alias target', async () => {
    const root = tmpPackage();
    const callerRoot = tmpPackage();
    await writePackage(root, {
      commands: ['writing-plans', 'reviewing-code'],
      metadata: {
        plan: { target: 'writing-plans' },
      },
    });
    const verifyAll = vi.fn(async () => ({ exitCode: 0 }));

    const allResult = await runRunner(root, ['verify'], { runVerifyCli: verifyAll }, callerRoot);

    expect(allResult.exitCode).toBe(0);
    expect(verifyAll).toHaveBeenCalledTimes(2);
    expect(verifyAll).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fsmPath: path.join(root, 'fsms', 'reviewing-code.fsm.ts'),
        repoRoot: callerRoot,
      }),
    );
    expect(verifyAll).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fsmPath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
        repoRoot: callerRoot,
      }),
    );

    const verifyAlias = vi.fn(async () => ({ exitCode: 0 }));
    const aliasResult = await runRunner(
      root,
      ['verify', 'plan'],
      { runVerifyCli: verifyAlias },
      callerRoot,
    );

    expect(aliasResult.exitCode).toBe(0);
    expect(verifyAlias).toHaveBeenCalledTimes(1);
    expect(verifyAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        fsmPath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
        repoRoot: callerRoot,
      }),
    );

    const verifyFailure = vi.fn(async () => ({ exitCode: 1 }));
    const failureResult = await runRunner(
      root,
      ['verify', 'writing-plans'],
      { runVerifyCli: verifyFailure },
      callerRoot,
    );

    expect(failureResult.exitCode).toBe(1);
  });

  it('runs a command by forwarding the resolved FSM path, caller cwd, streams, and input args', async () => {
    const root = tmpPackage();
    const callerRoot = tmpPackage();
    await writePackage(root, { commands: ['writing-plans'] });
    const runCliImpl = vi.fn(async () => ({ exitCode: 7 }));

    const result = await runRunner(
      root,
      ['writing-plans', '--topic', 'auth'],
      { runCli: runCliImpl },
      callerRoot,
    );

    expect(result.exitCode).toBe(7);
    expect(runCliImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        fsmPath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
        cwd: callerRoot,
        inputArgs: ['--topic', 'auth'],
      }),
    );
  });

  it('maps command runner loader failures to exit code 2', async () => {
    const root = tmpPackage();
    await writePackage(root, { commands: ['writing-plans'] });
    const runCliImpl = vi.fn(async () => {
      throw new Error('load exploded');
    });

    const result = await runRunner(root, ['writing-plans'], { runCli: runCliImpl });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ah-example: failed to run FSM command 'writing-plans'");
    expect(result.stderr).toContain('load exploded');
  });

  it('returns usage errors with nearest-name suggestions for unknown commands', async () => {
    const root = tmpPackage();
    await writePackage(root, { commands: ['writing-plans'] });

    const result = await runRunner(root, ['writng-plans']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ah-example: unknown command 'writng-plans'");
    expect(result.stderr).toContain("ah-example: did you mean 'writing-plans'?");
    expect(result.stderr).toContain('usage:');
  });

  it('maps verifier loader failures to exit code 2 before verifier diagnostics exist', async () => {
    const root = tmpPackage();
    await writePackage(root, { commands: ['writing-plans'] });
    const runVerifyCliImpl = vi.fn(async () => {
      throw new Error('load exploded');
    });

    const result = await runRunner(root, ['verify'], { runVerifyCli: runVerifyCliImpl });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('[fsm-load-failed]');
    expect(result.stderr).toContain('load exploded');
  });

  it('maps empty packages to commands-missing without author-only publish checks', async () => {
    const root = tmpPackage();
    await writePackage(root, { commands: [], files: ['bin', 'fsms'] });

    const config = await loadValidatedPackageConfig({ packageRoot: root });
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const discovery = await discoverValidatedPackageCommands({ config: config.value });
    expect(discovery.ok).toBe(false);
    if (!discovery.ok) {
      expect(discovery.diagnostics).toEqual([
        expect.objectContaining({
          code: 'commands-missing',
          field: 'harness.package.fsmsDir',
          path: 'fsms',
          message: 'FSM packages must contain at least one direct child .fsm.ts command',
        }),
      ]);
    }

    const result = await runRunner(root, ['list']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('package runner failed:');
    expect(result.stderr).toContain(
      'harness.package.fsmsDir: [commands-missing] FSM packages must contain at least one direct child .fsm.ts command',
    );
    expect(result.stderr).toContain('fsms');
    expect(result.stderr).not.toContain('[files-missing-entry]');
  });
});
