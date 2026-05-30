import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exit, aharness, state, terminal } from '../src/index.js';
import { runVisualizeCliForTest, type RunVisualizeCliTestHooks } from '../src/cli/visualizeCli.js';
import type { StartUiServerOptions } from '../src/ui/server.js';
import type { UiSnapshot } from '../src/ui/events.js';

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
      fsmPath,
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
      fsmPath,
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
});
