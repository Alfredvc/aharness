/**
 * Tests for the Task 14 fixtures.
 *
 * - `startApp` is exercised end-to-end against a real codex `app-server` and
 *   skips when `codex` is not on PATH.
 * - `waitForState` is unit-runnable: happy-path resolution and timeout
 *   reporting cover the R17 helper.
 * - The public barrel is checked to avoid exporting retired helpers.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import * as testSupport from '../src/index.js';
import { startApp, startMockModel, waitForState, type AppHandle } from '../src/index.js';

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

describe('@aharness/test-support public surface', () => {
  it('does not export retired helpers', () => {
    expect(testSupport).not.toHaveProperty('waitForTransition');
    expect(testSupport).not.toHaveProperty('currentState');
    expect(testSupport).not.toHaveProperty('lastSnapshot');
    expect(testSupport).not.toHaveProperty('spawnPty');
  });
});
