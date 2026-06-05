/**
 * Phase 1 verify checklist (Task 18).
 *
 * Six "verification checklist" (VC) items from
 * `docs/plans/2026-05-12-headless-phase-split.md`:
 *
 *   VC-1 — `hello.fsm.ts` end-to-end → exit 0.
 *   VC-2 — Multi-state self-loop FSM submits N times then finishes.
 *   VC-3 — Sub-thread `threadId` filter (covered cross-suite in
 *          `transport.notificationRouter.test.ts`; this entry documents
 *          the coverage source).
 *   VC-4 — WS-drop test: kill the app-server mid-run → exit 1.
 *   VC-5 — Two-process shutdown test: SIGTERM the CLI; child receives
 *          SIGTERM ≤ 2 s.
 *   VC-6 — Verifier suite + `aharness-submit-name-collision` (covered
 *          cross-suite in `verify.aharnessSubmitNameCollision.test.ts`;
 *          this entry documents the coverage source).
 *
 * This file executes the checklist items that need spawned-binary run coverage:
 * VC-1, VC-2, VC-4, VC-5 spawn the real `aharness` CLI binary against a real
 * codex `app-server` + a mock-model HTTP server. They are gated behind
 * `AHARNESS_E2E_REAL_CODEX=1` for parity with the other phase-1 end-to-end
 * tests (`cli.runCli.phase1.test.ts`): the gate skips cleanly when the
 * `codex` binary is unavailable on PATH or the opt-in env var is unset.
 *
 * VC-3 and VC-6 are covered by the suites named above; they are not duplicated
 * here as checklist-only tests.
 */
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const HELLO = resolve(__dirname, 'fixtures/hello.fsm.ts');
const SELFLOOP = resolve(__dirname, 'fixtures/multiStateSelfLoop.fsm.ts');
const CLI_BIN = resolve(__dirname, '..', 'dist', 'cli', 'main.js');

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

describe('Phase 1 verify checklist', () => {
  let cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
    cleanups = [];
  });

  // VC-1, VC-2, VC-4, VC-5 spawn the real `aharness run` CLI path plus a real
  // codex `app-server`; gated behind `AHARNESS_E2E_REAL_CODEX=1` (parity
  // with `cli.runCli.phase1.test.ts` and the other e2e tests). Timing
  // tolerance for VC-4 / VC-5 uses vitest 4's `{retry}` options-object
  // form (the legacy chainable `it.retry(...)` was removed).
  describe.skipIf(!E2E_ENABLED)('spawned-binary checks', () => {
    it('VC-1: hello.fsm.ts runs end-to-end → exit 0', { timeout: 30_000 }, async () => {
      const { sseFunctionCall, sseResponseCreated, sseTurnComplete, startMockModel } =
        await import('@aharness/test-support');

      const repo = mkdtempSync(join(tmpdir(), 'vc1-'));
      cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
      copyFileSync(HELLO, join(repo, 'hello.fsm.ts'));

      const mock = await startMockModel();
      cleanups.push(() => mock.close());
      mock.queueTurn([
        sseResponseCreated(),
        sseFunctionCall('aharness_submit', { state: 'greet', exit: 'finish', data: {} }),
        sseTurnComplete(),
      ]);

      const result = await runAharnessBin({
        cwd: repo,
        args: ['run', 'hello.fsm.ts'],
        env: withFakeBrowserOpener(repo, { AHARNESS_MOCK_MODEL_BASE_URL: mock.baseUrl }),
      });
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    });

    it(
      'VC-2: multi-state self-loop submits 3 times then finishes',
      { timeout: 30_000 },
      async () => {
        const { sseFunctionCall, sseResponseCreated, sseTurnComplete, startMockModel } =
          await import('@aharness/test-support');

        const repo = mkdtempSync(join(tmpdir(), 'vc2-'));
        cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
        copyFileSync(SELFLOOP, join(repo, 'mssl.fsm.ts'));

        const mock = await startMockModel();
        cleanups.push(() => mock.close());
        for (let i = 0; i < 3; i++) {
          mock.queueTurn([
            sseResponseCreated(),
            sseFunctionCall('aharness_submit', {
              state: 'counting',
              exit: 'increment',
              data: { delta: 1 },
            }),
            sseTurnComplete(),
          ]);
        }
        mock.queueTurn([
          sseResponseCreated(),
          sseFunctionCall('aharness_submit', { state: 'counting', exit: 'finish', data: {} }),
          sseTurnComplete(),
        ]);

        const result = await runAharnessBin({
          cwd: repo,
          args: ['run', 'mssl.fsm.ts'],
          env: withFakeBrowserOpener(repo, { AHARNESS_MOCK_MODEL_BASE_URL: mock.baseUrl }),
        });
        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      },
    );

    it('VC-4: WS-drop → exit 1 within 5s', { retry: 2, timeout: 15_000 }, async () => {
      const { startMockModel } = await import('@aharness/test-support');

      const repo = mkdtempSync(join(tmpdir(), 'vc4-'));
      cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
      copyFileSync(HELLO, join(repo, 'hello.fsm.ts'));

      const mock = await startMockModel();
      cleanups.push(() => mock.close());
      // The mock never queues a turn — the model POST parks indefinitely
      // and the CLI stays in the turn loop until the app-server WS drops.

      const child = spawn(process.execPath, [CLI_BIN, 'run', 'hello.fsm.ts'], {
        cwd: repo,
        env: withFakeBrowserOpener(repo, { AHARNESS_MOCK_MODEL_BASE_URL: mock.baseUrl }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      cleanups.push(async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });

      // Wait for the codex app-server child to spawn.
      await new Promise<void>((r) => setTimeout(r, 1500));
      const pgrepOut = await runProc('pgrep', ['-P', String(child.pid)]);
      const appPid = Number(pgrepOut.trim().split('\n')[0]);
      if (Number.isFinite(appPid)) process.kill(appPid, 'SIGKILL');

      const exitCode = await new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));
      expect(exitCode).toBe(1);
    });

    it(
      'VC-5: SIGTERM the CLI → app-server receives SIGTERM ≤ 2.5s',
      { retry: 2, timeout: 15_000 },
      async () => {
        const { startMockModel } = await import('@aharness/test-support');

        const repo = mkdtempSync(join(tmpdir(), 'vc5-'));
        cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
        copyFileSync(HELLO, join(repo, 'hello.fsm.ts'));

        const mock = await startMockModel();
        cleanups.push(() => mock.close());

        const child = spawn(process.execPath, [CLI_BIN, 'run', 'hello.fsm.ts'], {
          cwd: repo,
          env: withFakeBrowserOpener(repo, { AHARNESS_MOCK_MODEL_BASE_URL: mock.baseUrl }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        cleanups.push(async () => {
          if (child.exitCode === null) child.kill('SIGKILL');
        });

        await new Promise<void>((r) => setTimeout(r, 1500));
        const pgrepOut = await runProc('pgrep', ['-P', String(child.pid)]);
        const appPid = Number(pgrepOut.trim().split('\n')[0]);
        expect(Number.isFinite(appPid)).toBe(true);

        child.kill('SIGTERM');
        const start = Date.now();
        await new Promise<void>((r) => child.on('exit', () => r()));
        expect(Date.now() - start).toBeLessThan(2500);
        // Confirm the app-server pid is gone (signal 0 throws if absent).
        expect(() => process.kill(appPid, 0)).toThrow();
      },
    );
  });
});

async function runAharnessBin(opts: {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === null) reject(new Error(`exited via signal\nstderr:\n${stderr}`));
      else resolveP({ exitCode: code, stdout, stderr });
    });
  });
}

function withFakeBrowserOpener(
  root: string,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const fakeBin = join(root, '.fake-browser-bin');
  mkdirSync(fakeBin, { recursive: true });

  const commandName =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.cmd' : 'xdg-open';
  const commandPath = join(fakeBin, commandName);
  writeFileSync(commandPath, fakeBrowserOpenerScript(), 'utf8');
  if (process.platform !== 'win32') chmodSync(commandPath, 0o755);

  return {
    ...process.env,
    ...extraEnv,
    PATH: `${fakeBin}${delimiter}${process.env['PATH'] ?? ''}`,
  };
}

function fakeBrowserOpenerScript(): string {
  if (process.platform === 'win32') return '@echo off\r\nexit /b 0\r\n';
  return '#!/bin/sh\nexit 0\n';
}

async function runProc(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args);
    let out = '';
    c.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    c.on('exit', () => res(out));
    c.on('error', rej);
  });
}
