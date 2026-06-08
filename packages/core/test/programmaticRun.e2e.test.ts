/**
 * Real-Codex end-to-end checks for the public programmatic run API.
 *
 * These tests intentionally follow the existing `AHARNESS_E2E_REAL_CODEX=1`
 * gate. They use a real Codex app-server and aharness live engine while routing
 * model traffic to `startMockModel()` for deterministic turns.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startAharnessRunForTest, type AharnessRunEvent } from '../src/runtime/programmaticRun.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

const ONE_STEP_FSM_SOURCE = `import { aharness, state, exit, terminal } from '@aharness/core';

interface DonePayload {
  ok: boolean;
}

export default aharness.machine({
  id: 'programmatic-e2e-one-step',
  initial: 'work',
  states: {
    work: state({
      entryPrompt: 'finish through aharness_submit',
      exits: {
        done: exit<DonePayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});
`;

const OWNER_INPUT_FSM_SOURCE = `import { aharness, state, exit, terminal } from '@aharness/core';

interface DonePayload {
  answer: string;
}

export default aharness.machine({
  id: 'programmatic-e2e-owner-input',
  initial: 'ask',
  states: {
    ask: state({
      entryPrompt: 'ask for owner input, then submit done',
      exits: {
        done: exit<DonePayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});
`;

describe.skipIf(!E2E_ENABLED)('startAharnessRun - real Codex E2E', () => {
  let cleanups: Array<() => Promise<void> | void> = [];
  const previousMockModelBaseUrl = process.env['AHARNESS_MOCK_MODEL_BASE_URL'];

  afterEach(async () => {
    if (previousMockModelBaseUrl === undefined) {
      delete process.env['AHARNESS_MOCK_MODEL_BASE_URL'];
    } else {
      process.env['AHARNESS_MOCK_MODEL_BASE_URL'] = previousMockModelBaseUrl;
    }

    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
    cleanups = [];
  });

  it('completes a tiny local FSM and emits canonical events', async () => {
    const { sseFunctionCall, sseResponseCreated, sseTurnComplete, startMockModel } =
      await import('@aharness/test-support');
    const repoRoot = createTempRepo('h-programmatic-e2e-happy-');
    writeFileSync(join(repoRoot, 'workflow.fsm.ts'), ONE_STEP_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    process.env['AHARNESS_MOCK_MODEL_BASE_URL'] = mock.baseUrl;
    mock.queueTurn([
      sseResponseCreated(),
      sseFunctionCall('aharness_submit', {
        state: 'work',
        exit: 'done',
        data: { ok: true },
      }),
      sseTurnComplete(),
    ]);

    const observed: AharnessRunEvent[] = [];
    const run = await startAharnessRunForTest(
      {
        target: './workflow.fsm.ts',
        cwd: repoRoot,
        ui: false,
        onEvent: (event) => {
          observed.push(event);
        },
      },
      realCodexHooks(),
    );

    const result = await run.result();

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(run.uiUrl).toBeUndefined();
    expect(observed.map((event) => event.type)).toEqual(
      expect.arrayContaining(['run.started', 'run.completed']),
    );
    expect(readJsonl(run.eventsPath)).toEqual(observed);
  }, 30_000);

  it('answers a model-originated owner-input request through the typed helper', async () => {
    const {
      buildRequestUserInputTurn,
      sseFunctionCall,
      sseResponseCreated,
      sseTurnComplete,
      startMockModel,
    } = await import('@aharness/test-support');
    const repoRoot = createTempRepo('h-programmatic-e2e-owner-input-');
    writeFileSync(join(repoRoot, 'workflow.fsm.ts'), OWNER_INPUT_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    process.env['AHARNESS_MOCK_MODEL_BASE_URL'] = mock.baseUrl;
    mock.queueTurn(
      buildRequestUserInputTurn('call-owner-input', [
        { id: 'owner', header: 'Owner', question: 'What value should be used?' },
      ]),
    );

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: repoRoot, ui: false },
      realCodexHooks(),
    );
    const request = await waitForOwnerInputRequest(run.eventsPath);

    mock.queueTurn([
      sseResponseCreated(),
      sseFunctionCall('aharness_submit', {
        state: 'ask',
        exit: 'done',
        data: { answer: 'alpha' },
      }),
      sseTurnComplete(),
    ]);
    await expect(
      run.answerOwnerInput({ requestId: request.requestId, answers: { owner: 'alpha' } }),
    ).resolves.toMatchObject({ ok: true, status: 200 });

    await expect(run.result()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    const eventTypes = readJsonl(run.eventsPath).map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining(['request.created', 'reply.submitted', 'reply.resolved']),
    );
  }, 30_000);

  it('cancels a real app-server run and records one cancellation event', async () => {
    const { startMockModel } = await import('@aharness/test-support');
    const repoRoot = createTempRepo('h-programmatic-e2e-cancel-');
    writeFileSync(join(repoRoot, 'workflow.fsm.ts'), ONE_STEP_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    process.env['AHARNESS_MOCK_MODEL_BASE_URL'] = mock.baseUrl;

    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: repoRoot, ui: false },
      realCodexHooks(),
    );

    await run.cancel('e2e stop');

    await expect(run.result()).resolves.toMatchObject({
      status: 'cancelled',
      exitCode: 130,
      reason: 'e2e stop',
    });
    expect(
      readJsonl(run.eventsPath).filter((event) => event.type === 'run.cancelled'),
    ).toHaveLength(1);
  }, 30_000);

  function createTempRepo(prefix: string): string {
    const repoRoot = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    return repoRoot;
  }
});

function realCodexHooks(): Parameters<typeof startAharnessRunForTest>[1] {
  return {
    verify: async () => ({ exitCode: 0 }),
    versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
    authJsonExists: () => true,
  };
}

function readJsonl(eventsPath: string): AharnessRunEvent[] {
  return readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AharnessRunEvent);
}

async function waitForOwnerInputRequest(
  eventsPath: string,
): Promise<{ readonly requestId: string }> {
  for (let i = 0; i < 200; i += 1) {
    const found = readJsonl(eventsPath).find(
      (event) =>
        event.type === 'request.created' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        (event.data as Record<string, unknown>)['kind'] === 'owner-input',
    );
    if (found !== undefined && typeof found.requestId === 'string') {
      return { requestId: found.requestId };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('timed out waiting for owner-input request');
}
