import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exit, aharness, state, terminal } from '../src/index.js';
import { runVisualizeCliForTest, type RunVisualizeCliTestHooks } from '../src/cli/visualizeCli.js';
import type { StartUiServerOptions } from '../src/ui/server.js';
import type { UiSnapshot } from '../src/ui/events.js';
import { fsmHash6 } from '../src/run.js';
import type {
  InstallStoreResult,
  InstalledRuntimeSnapshot,
  TrustedCommandIndexEntry,
  TrustedCommandsFile,
  TrustedInstallRecord,
} from '../src/installStore/index.js';
import type { LoadInstalledFsmOptions } from '../src/loader/index.js';
import type { VerifyResult } from '../src/verify/index.js';

function makeWritableBuffer(): {
  readonly sink: NodeJS.WritableStream;
  text(): string;
} {
  const chunks: string[] = [];
  return {
    sink: {
      write(chunk: string | Uint8Array): boolean {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

function makeLoadFsmResult() {
  const machine = aharness.machine({
    id: 'visualize-demo',
    initial: 'plan',
    states: {
      plan: state({
        entryPrompt: 'Plan the implementation and call submitPlan.',
        clearOnEntry: true,
        exits: {
          submitPlan: exit<{ plan: string }>({ to: 'done' }),
        },
      }),
      done: terminal('success'),
    },
  });

  return {
    machine,
    sidecar: {},
    modulePath: '/tmp/visualize-demo.mjs',
    issues: [],
    skillOriginManifest: {
      rootSourceDir: '/store/packages/node_modules/@scope/tools/fsms',
      sourceDirPrefixes: [],
      availableSkills: [],
    },
    cacheHit: false,
    hash: 'visualize-demo',
  };
}

describe('runVisualizeCliForTest', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'aharness-visualize-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('serves an inspect-mode run-scoped bootstrap without starting a Codex run', async () => {
    const fsmPath = join(repoRoot, 'visualize-demo.fsm.ts');
    writeFileSync(fsmPath, '// loaded through test hook\n');
    let capturedSnapshot: UiSnapshot | undefined;
    let capturedRunScoped: StartUiServerOptions['runScoped'] | undefined;
    const close = vi.fn(async () => undefined);
    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      capturedSnapshot = options.eventLog.snapshot();
      capturedRunScoped = options.runScoped;
      return {
        url: 'http://127.0.0.1:56789',
        close,
      };
    });
    const launchBrowserImpl = vi.fn(() => ({ ok: true as const }));
    const waitForExit = vi.fn(async () => null);
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: fsmPath,
      stdout: stdout.sink,
      stderr: stderr.sink,
      verify: async () => ({ exitCode: 0 }),
      loadFsmImpl: (async () =>
        makeLoadFsmResult()) as unknown as RunVisualizeCliTestHooks['loadFsmImpl'],
      startUiServerImpl,
      launchBrowserImpl,
      waitForExit,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('aharness: FSM visualization available at');
    expect(startUiServerImpl).toHaveBeenCalledOnce();
    const launchedUrl = new URL(launchBrowserImpl.mock.calls[0]?.[0] ?? '');
    expect(stdout.text()).toContain('token=');
    expect(stdout.text()).toContain('mode=inspect');
    expect(stdout.text()).toContain(`runId=inspect-`);
    expect(launchedUrl.searchParams.get('token')).toBeTruthy();
    expect(launchedUrl.searchParams.get('runId')).toMatch(/^inspect-[a-f0-9]{6}$/);
    expect(launchedUrl.searchParams.get('mode')).toBe('inspect');
    expect(capturedRunScoped?.activeRunId).toBe(launchedUrl.searchParams.get('runId'));
    expect(capturedRunScoped?.service.runId).toBe(launchedUrl.searchParams.get('runId'));
    const bootstrap = capturedRunScoped?.service.getBootstrap({
      getRunMeta: () => capturedSnapshot?.state.run ?? {},
      topology: capturedSnapshot?.state.topology,
    });
    expect(bootstrap).toMatchObject({
      ok: true,
      bootstrap: {
        mode: 'inspect',
        run: expect.objectContaining({
          codexPin: 'not started',
          threadId: '',
        }),
        currentState: expect.objectContaining({
          path: 'plan',
          leaf: 'plan',
          kind: 'stateful',
        }),
        recentRows: [expect.objectContaining({ summary: 'Inspecting plan' })],
        aggregateStats: { turnCount: 0 },
        pending: [],
        diagnostics: [],
      },
    });
    expect(waitForExit).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(capturedSnapshot?.state.mode).toBe('inspect');
    expect(capturedSnapshot?.state.currentState).toMatchObject({
      path: 'plan',
      leaf: 'plan',
      kind: 'stateful',
      entryPrompt: 'Plan the implementation and call submitPlan.',
    });
    expect(capturedSnapshot?.state.topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plan',
          detail: expect.objectContaining({
            clearOnEntry: true,
            entryPrompt: {
              kind: 'static',
              text: 'Plan the implementation and call submitPlan.',
            },
          }),
        }),
      ]),
    );
    expect(capturedSnapshot?.state.run?.threadId).toBe('');
  });

  it('does not require runtime input flags when visualizing a required-input FSM', async () => {
    const fsmPath = join(repoRoot, 'visualize-demo.fsm.ts');
    writeFileSync(fsmPath, '// loaded through test hook\n');
    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      return {
        url: 'http://127.0.0.1:56789',
        close: vi.fn(async () => undefined),
      };
    });
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: fsmPath,
      stdout: stdout.sink,
      stderr: stderr.sink,
      verify: async () => ({ exitCode: 0 }),
      loadFsmImpl: (async () => ({
        ...makeLoadFsmResult(),
        inputSchema: {
          type: 'object',
          properties: { recipePath: { type: 'string' } },
          required: ['recipePath'],
          additionalProperties: false,
        },
        inputFlags: { recipePath: { description: 'Recipe file' } },
      })) as unknown as RunVisualizeCliTestHooks['loadFsmImpl'],
      startUiServerImpl,
      launchBrowserImpl: undefined,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('aharness: FSM visualization available at');
    expect(startUiServerImpl).toHaveBeenCalledOnce();
  });

  it('rejects explicit local non-FSM targets before verify, load, UI, or browser work', async () => {
    const verify = vi.fn(async () => ({ exitCode: 0 }));
    const loadFsmImpl = vi.fn(async () => makeLoadFsmResult());
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:56789',
      close: vi.fn(async () => undefined),
    }));
    const launchBrowserImpl = vi.fn(() => ({ ok: true as const }));
    const readSnapshotImpl = vi.fn(
      async (): Promise<InstallStoreResult<InstalledRuntimeSnapshot>> => ({
        ok: false,
        diagnostics: [
          {
            code: 'trusted-json-read-failed',
            message: 'snapshot should not be read',
          },
        ],
      }),
    );
    const checkLockFingerprintImpl = vi.fn();
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: './workflow',
      stdout: stdout.sink,
      stderr: stderr.sink,
      verify,
      loadFsmImpl: loadFsmImpl as unknown as RunVisualizeCliTestHooks['loadFsmImpl'],
      startUiServerImpl,
      launchBrowserImpl,
      waitForExit: vi.fn(async () => null),
      env: { AHARNESS_HOME: join(repoRoot, '.aharness') },
      homeDir: repoRoot,
      readSnapshotImpl,
      checkLockFingerprintImpl,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain('aharness visualize failed:');
    expect(stderr.text()).toContain("[fsm-target-invalid-local] local FSM target './workflow'");
    expect(verify).not.toHaveBeenCalled();
    expect(loadFsmImpl).not.toHaveBeenCalled();
    expect(startUiServerImpl).not.toHaveBeenCalled();
    expect(launchBrowserImpl).not.toHaveBeenCalled();
    expect(readSnapshotImpl).not.toHaveBeenCalled();
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
  });

  it('passes resolver seam options when resolving installed-looking visualize targets', async () => {
    const diagnostics = [
      {
        code: 'command-not-found',
        commandName: 'build',
        message: "command 'build' is not installed",
      },
    ];
    const readSnapshotImpl = vi.fn(
      async (): Promise<InstallStoreResult<InstalledRuntimeSnapshot>> => ({
        ok: false,
        diagnostics,
      }),
    );
    const checkLockFingerprintImpl = vi.fn();
    const verify = vi.fn(async () => ({ exitCode: 0 }));
    const loadFsmImpl = vi.fn(async () => makeLoadFsmResult());
    const startUiServerImpl = vi.fn();
    const launchBrowserImpl = vi.fn();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: makeWritableBuffer().sink,
      stderr: stderr.sink,
      verify,
      loadFsmImpl: loadFsmImpl as unknown as RunVisualizeCliTestHooks['loadFsmImpl'],
      startUiServerImpl,
      launchBrowserImpl,
      env: { AHARNESS_HOME: join(repoRoot, '.aharness') },
      homeDir: repoRoot,
      readSnapshotImpl,
      checkLockFingerprintImpl,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text()).toContain('aharness visualize failed:');
    expect(readSnapshotImpl).toHaveBeenCalledWith({
      env: { AHARNESS_HOME: join(repoRoot, '.aharness') },
      homeDir: repoRoot,
    });
    expect(checkLockFingerprintImpl).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(loadFsmImpl).not.toHaveBeenCalled();
    expect(startUiServerImpl).not.toHaveBeenCalled();
    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });

  it('verifies and loads installed bare commands with resolver snapshot paths', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const readSnapshotImpl = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const checkLockFingerprintImpl = vi.fn(async () => ({
      ok: true as const,
      value: 'verified-lock',
    }));
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadFsmResult());
    const verifyImpl = vi.fn(
      (): VerifyResult => ({
        ok: true,
        errors: [],
        warnings: [],
        issues: [],
      }),
    );
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:56789',
      close: vi.fn(async () => undefined),
    }));
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: stdout.sink,
      stderr: stderr.sink,
      readSnapshotImpl,
      checkLockFingerprintImpl,
      loadInstalledFsmImpl,
      verifyImpl,
      startUiServerImpl,
      launchBrowserImpl: undefined,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(0);
    expect(readSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(checkLockFingerprintImpl).toHaveBeenCalledTimes(1);
    expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(2);
    const expectedLoad: LoadInstalledFsmOptions = {
      entryFile: '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts',
      packageName: '@scope/tools',
      commandName: 'build',
      packageRoot: '/store/packages/node_modules/@scope/tools',
      managedProjectRoot: '/store/packages',
      storeRoot: '/store',
      lockFingerprint: 'verified-lock',
    };
    expect(loadInstalledFsmImpl).toHaveBeenNthCalledWith(1, expectedLoad);
    expect(loadInstalledFsmImpl).toHaveBeenNthCalledWith(2, expectedLoad);
    expect(verifyImpl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        skillEnv: {
          fsmFileDir: '/store/packages/node_modules/@scope/tools/fsms',
          repoRoot: '/store/packages/node_modules/@scope/tools',
        },
        skillOriginManifest: expect.anything(),
        sourceLocations: undefined,
      }),
    );
    expect(stdout.text()).toContain('verify: ok (@scope/tools/build, 0 warnings)');
    expect(stdout.text()).toContain('aharness: FSM visualization available at');
    expect(stdout.text().indexOf('verify: ok')).toBeLessThan(
      stdout.text().indexOf('aharness: FSM visualization available at'),
    );
    expect(stderr.text()).toBe('');
    expect(startUiServerImpl).toHaveBeenCalledOnce();
  });

  it('accepts fully qualified installed command identities', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadFsmResult());
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:56789',
      close: vi.fn(async () => undefined),
    }));
    const stdout = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: '@scope/tools/build',
      stdout: stdout.sink,
      stderr: makeWritableBuffer().sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: true as const,
        value: 'verified-lock',
      })),
      loadInstalledFsmImpl,
      verifyImpl: vi.fn(() => okVerifyResult()),
      startUiServerImpl,
      launchBrowserImpl: undefined,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(0);
    expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(2);
    expect(stdout.text()).toContain('verify: ok (@scope/tools/build, 0 warnings)');
    expect(startUiServerImpl).toHaveBeenCalledOnce();
  });

  it('serves installed inspect bootstrap with entry-file metadata and no live runtime state', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const entryFile = '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts';
    let capturedSnapshot: UiSnapshot | undefined;
    let capturedRunScoped: StartUiServerOptions['runScoped'] | undefined;
    const startUiServerImpl = vi.fn(async (options: StartUiServerOptions) => {
      capturedSnapshot = options.eventLog.snapshot();
      capturedRunScoped = options.runScoped;
      return {
        url: 'http://127.0.0.1:56789',
        close: vi.fn(async () => undefined),
      };
    });
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: stdout.sink,
      stderr: stderr.sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: true as const,
        value: 'verified-lock',
      })),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadFsmResult()),
      verifyImpl: vi.fn(() => okVerifyResult()),
      startUiServerImpl,
      launchBrowserImpl: undefined,
      waitForExit: vi.fn(async () => null),
    });

    const expectedRunId = `inspect-${fsmHash6(entryFile)}`;
    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('token=');
    expect(stdout.text()).toContain(`runId=${expectedRunId}`);
    expect(stdout.text()).toContain('mode=inspect');
    expect(capturedSnapshot?.state.mode).toBe('inspect');
    expect(capturedSnapshot?.state.run).toMatchObject({
      runId: expectedRunId,
      threadId: '',
      repoRoot: '/store/packages/node_modules/@scope/tools',
      fsmFile: entryFile,
      fsmHash6: fsmHash6(entryFile),
      codexPin: 'not started',
    });
    expect(capturedRunScoped?.activeRunId).toBe(expectedRunId);
    const bootstrap = capturedRunScoped?.service.getBootstrap({
      getRunMeta: () => capturedSnapshot?.state.run ?? {},
      topology: capturedSnapshot?.state.topology,
    });
    expect(bootstrap).toMatchObject({
      ok: true,
      bootstrap: {
        mode: 'inspect',
        run: expect.objectContaining({
          runId: expectedRunId,
          fsmFile: entryFile,
          codexPin: 'not started',
          threadId: '',
        }),
        topology: expect.anything(),
        currentState: expect.objectContaining({
          path: 'plan',
          leaf: 'plan',
          kind: 'stateful',
        }),
        recentRows: [expect.objectContaining({ summary: 'Inspecting plan' })],
        aggregateStats: { turnCount: 0 },
        pending: [],
        diagnostics: [],
      },
    });
  });

  it('does not require installed required input flags when visualizing', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const startUiServerImpl = vi.fn(async () => ({
      url: 'http://127.0.0.1:56789',
      close: vi.fn(async () => undefined),
    }));
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: stdout.sink,
      stderr: stderr.sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: true as const,
        value: 'verified-lock',
      })),
      loadInstalledFsmImpl: vi.fn(async () => ({
        ...makeLoadFsmResult(),
        inputSchema: {
          type: 'object',
          properties: { recipePath: { type: 'string' } },
          required: ['recipePath'],
          additionalProperties: false,
        },
        inputFlags: { recipePath: { description: 'Recipe file' } },
      })),
      verifyImpl: vi.fn(() => okVerifyResult()),
      startUiServerImpl,
      launchBrowserImpl: undefined,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('aharness: FSM visualization available at');
    expect(startUiServerImpl).toHaveBeenCalledOnce();
  });

  it('validates installed input flags with the final loaded FSM and stops before UI startup', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const startUiServerImpl = vi.fn();
    const launchBrowserImpl = vi.fn();
    const loadInstalledFsmImpl = vi
      .fn()
      .mockResolvedValueOnce(makeLoadFsmResult())
      .mockResolvedValueOnce({
        ...makeLoadFsmResult(),
        inputSchema: {
          type: 'object',
          properties: { recipePath: { type: 'string' } },
          required: ['recipePath'],
          additionalProperties: false,
        },
        inputFlags: { recipePath: { description: 'Recipe file' } },
      });
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      inputArgs: ['--unknown', 'value'],
      stdout: stdout.sink,
      stderr: stderr.sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: true as const,
        value: 'verified-lock',
      })),
      loadInstalledFsmImpl,
      verifyImpl: vi.fn(() => okVerifyResult()),
      startUiServerImpl,
      launchBrowserImpl,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(2);
    expect(stdout.text()).toContain('verify: ok (@scope/tools/build, 0 warnings)');
    expect(stderr.text()).toContain('aharness visualize: input flags invalid:');
    expect(stderr.text()).toContain('unknown flag --unknown');
    expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(2);
    expect(startUiServerImpl).not.toHaveBeenCalled();
    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });

  it('prints installed verifier warnings before the UI availability line', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const output = makeWritableBuffer();
    const warning: VerifyResult['warnings'][number] = {
      severity: 'warning',
      check: 'skill-must-resolve',
      stateId: 'plan',
      message: 'optional skill is missing',
      location: {
        sourceFile: '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts',
        line: 12,
        column: 9,
      },
    };

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: output.sink,
      stderr: output.sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: true as const,
        value: 'verified-lock',
      })),
      loadInstalledFsmImpl: vi.fn(async () => makeLoadFsmResult()),
      verifyImpl: vi.fn(() => ({
        ok: true,
        errors: [],
        warnings: [warning],
        issues: [warning],
      })),
      startUiServerImpl: vi.fn(async () => ({
        url: 'http://127.0.0.1:56789',
        close: vi.fn(async () => undefined),
      })),
      launchBrowserImpl: undefined,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(0);
    expect(output.text()).toContain(
      '/store/packages/node_modules/@scope/tools/fsms/build.fsm.ts:12:9: [warning] skill-must-resolve (plan): optional skill is missing',
    );
    expect(output.text()).toContain('verify: ok (@scope/tools/build, 1 warnings)');
    expect(output.text().indexOf('[warning] skill-must-resolve')).toBeLessThan(
      output.text().indexOf('aharness: FSM visualization available at'),
    );
  });

  it('returns verifier errors before final installed load, UI startup, or browser launch', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadFsmResult());
    const startUiServerImpl = vi.fn();
    const launchBrowserImpl = vi.fn();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: makeWritableBuffer().sink,
      stderr: stderr.sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: true as const,
        value: 'verified-lock',
      })),
      loadInstalledFsmImpl,
      verifyImpl: vi.fn(() => ({
        ok: false,
        errors: [
          {
            severity: 'error',
            check: 'terminal-reachability',
            stateId: 'plan',
            message: 'cannot reach a terminal state',
          },
        ],
        warnings: [],
        issues: [
          {
            severity: 'error',
            check: 'terminal-reachability',
            stateId: 'plan',
            message: 'cannot reach a terminal state',
          },
        ],
      })),
      startUiServerImpl,
      launchBrowserImpl,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text()).toContain(
      '[error] terminal-reachability (plan): cannot reach a terminal state',
    );
    expect(loadInstalledFsmImpl).toHaveBeenCalledTimes(1);
    expect(startUiServerImpl).not.toHaveBeenCalled();
    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });

  it('stops on installed lock mismatch before verify, load, UI startup, or browser launch', async () => {
    const snapshot = runtimeSnapshot([
      installRecord('@scope/tools', { build: commandMetadata('build') }),
    ]);
    const loadInstalledFsmImpl = vi.fn(async () => makeLoadFsmResult());
    const verifyImpl = vi.fn(() => okVerifyResult());
    const startUiServerImpl = vi.fn();
    const launchBrowserImpl = vi.fn();
    const stderr = makeWritableBuffer();

    const result = await runVisualizeCliForTest({
      cwd: repoRoot,
      target: 'build',
      stdout: makeWritableBuffer().sink,
      stderr: stderr.sink,
      readSnapshotImpl: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      checkLockFingerprintImpl: vi.fn(async () => ({
        ok: false as const,
        diagnostics: [
          {
            code: 'installed-lock-fingerprint-mismatch',
            field: 'lockFingerprint',
            message: 'package changed; reinstall it',
          },
        ],
      })),
      loadInstalledFsmImpl,
      verifyImpl,
      startUiServerImpl,
      launchBrowserImpl,
      waitForExit: vi.fn(async () => null),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text()).toContain('aharness visualize failed:');
    expect(stderr.text()).toContain('installed-lock-fingerprint-mismatch');
    expect(loadInstalledFsmImpl).not.toHaveBeenCalled();
    expect(verifyImpl).not.toHaveBeenCalled();
    expect(startUiServerImpl).not.toHaveBeenCalled();
    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });
});

function runtimeSnapshot(records: readonly TrustedInstallRecord[]): InstalledRuntimeSnapshot {
  const installs: Record<string, TrustedInstallRecord> = {};
  const commands: Record<string, TrustedCommandIndexEntry> = {};
  for (const record of records) {
    installs[record.packageName] = record;
    for (const command of Object.values(record.commands)) {
      commands[`${record.packageName}/${command.commandName}`] = {
        packageName: record.packageName,
        commandName: command.commandName,
        entry: command.entry,
        packageRoot: record.packageRoot,
        ...(record.packageVersion !== undefined ? { packageVersion: record.packageVersion } : {}),
        lockFingerprint: record.lockFingerprint,
        ...(command.description !== undefined ? { description: command.description } : {}),
      };
    }
  }
  return {
    paths: {
      storeRoot: '/store',
      managedProjectRoot: '/store/packages',
      installsPath: '/store/installs.json',
      commandsPath: '/store/commands.json',
    },
    installs: { schemaVersion: 1, generation: 'gen-1', installs },
    commands: commandsFile({ commands }),
  };
}

function installRecord(
  packageName: string,
  commands: TrustedInstallRecord['commands'],
): TrustedInstallRecord {
  return {
    packageName,
    dependencyKey: packageName,
    requestedSpec: `${packageName}@latest`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    sourceIntentKey: `registry:${packageName}`,
    lockFingerprint: 'verified-lock',
    commands,
  };
}

function commandMetadata(commandName: string): TrustedInstallRecord['commands'][string] {
  return {
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
  };
}

function commandsFile(
  opts: { readonly commands?: Record<string, TrustedCommandIndexEntry> } = {},
): TrustedCommandsFile {
  return {
    schemaVersion: 1,
    generation: 'gen-1',
    commands: opts.commands ?? {},
  };
}

function okVerifyResult(): VerifyResult {
  return {
    ok: true,
    errors: [],
    warnings: [],
    issues: [],
  };
}
