/**
 * Tests for the Task 14 fixtures.
 *
 * - `startApp` is exercised end-to-end against a real codex `app-server` and
 *   skips when `codex` is not on PATH.
 * - `waitForState` is unit-runnable: happy-path resolution and timeout
 *   reporting cover the R17 helper.
 * - The phase-4 stubs (`waitForTransition`, `currentState`, `lastSnapshot`)
 *   are asserted to throw with a stable message so a future phase-4 wiring
 *   change is loud rather than silent.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  currentState,
  lastSnapshot,
  startApp,
  startMockModel,
  waitForState,
  waitForTransition,
  type AppHandle,
} from '../src/index.js';

const hasCodex = (() => {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasCodex)('startApp', () => {
  it('boots, accepts the JSON-RPC handshake, then closes cleanly', async () => {
    const model = await startMockModel();
    let handle: AppHandle | undefined;
    try {
      handle = await startApp({ modelBaseUrl: model.baseUrl });
      expect(handle.threadId).toMatch(/.+/);
    } finally {
      if (handle !== undefined) await handle.close();
      await model.close();
    }
  });
});

describe('waitForState', () => {
  it('resolves with the first state matching the predicate', async () => {
    let s = 'init';
    setTimeout(() => {
      s = 'ready';
    }, 30);
    const got = await waitForState(
      () => s,
      (x) => x === 'ready',
      500,
    );
    expect(got).toBe('ready');
  });

  it('throws including the last observed state on timeout', async () => {
    await expect(
      waitForState(
        () => 'stuck',
        (x) => x === 'never',
        50,
      ),
    ).rejects.toThrow(/timed out, last state=stuck/);
  });
});

describe('phase-4 stubs', () => {
  // Cast through `unknown` because the stubs throw before reading the handle;
  // the test only verifies the surface is callable and emits a stable error.
  const fakeHandle = {} as unknown as AppHandle;

  it('waitForTransition throws phase-4 wiring error', async () => {
    await expect(waitForTransition(fakeHandle, () => true)).rejects.toThrow(
      /phase-4 daemon wiring/,
    );
  });

  it('currentState throws phase-4 wiring error', () => {
    expect(() => currentState(fakeHandle)).toThrow(/phase-4 daemon wiring/);
  });

  it('lastSnapshot throws phase-4 wiring error', () => {
    expect(() => lastSnapshot(fakeHandle)).toThrow(/phase-4 daemon wiring/);
  });
});
