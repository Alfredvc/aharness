/**
 * Real-Codex end-to-end checks for managed sidecar threads.
 *
 * Ordinary local and CI runs compile this file but skip execution unless
 * `codex` is on PATH and `AHARNESS_E2E_REAL_CODEX=1`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { METHOD } from '../src/protocol/methodNames.js';
import { startAharnessRunForTest, type AharnessRunEvent } from '../src/runtime/programmaticRun.js';
import { connectHeadlessWs } from '../src/transport/wsClient.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['AHARNESS_E2E_REAL_CODEX'] === '1';

const SIDECAR_COMPLETED_FSM_SOURCE = `import { createFsm, skill } from '@aharness/core';

interface Data {
  status: string;
}

const base = createFsm<Data>();
const fsm = base.withEvents({
  sidecarDone: base.event<{ status: string }>(),
});

export default fsm.machine({
  id: 'sidecar-e2e-completed',
  threadSkills: {
    research: skill({ path: './skills/sidecar-research/SKILL.md' }),
  },
  data: () => ({ status: 'pending' }),
  initial: 'work',
  states: {
    work: fsm.state({
      prompt: 'Start a sidecar from onEntry.',
      entry: async (_data, ops) => {
        const thread = await ops.codex.createThread('research', {
          initialSkills: ['research'],
          label: 'Research',
        });
        const result = await thread.send('Return a tiny research note.');
        await thread.close();
        await ops.emit('sidecarDone', {
          status: result.ok ? result.kind : result.reason,
        });
      },
      on: {
        sidecarDone: {
          to: 'done',
          reduce: (draft, payload) => {
            draft.status = payload.status;
          },
        },
      },
    }),
    done: fsm.final({
      outcome: 'success',
      artifacts: {
        'status.txt': (data) => data.status,
      },
    }),
  },
});
`;

const SIDECAR_INPUT_FSM_SOURCE = `import { createFsm } from '@aharness/core';

interface Data {
  status: string;
}

const base = createFsm<Data>();
const fsm = base.withEvents({
  sidecarDone: base.event<{ status: string }>(),
});

export default fsm.machine({
  id: 'sidecar-e2e-input',
  data: () => ({ status: 'pending' }),
  initial: 'work',
  states: {
    work: fsm.state({
      prompt: 'Start a sidecar input boundary from onEntry.',
      entry: async (_data, ops) => {
        const thread = await ops.codex.createThread('helper');
        const first = await thread.send('Ask for one missing direction.');
        if (!first.ok || first.kind !== 'needsInput') {
          await thread.close();
          await ops.emit('sidecarDone', {
            status: first.ok ? first.kind : first.reason,
          });
          return;
        }
        const answered = await thread.answer(first.request.id, {
          direction: 'Use the deterministic answer.',
        });
        await thread.close();
        await ops.emit('sidecarDone', {
          status: answered.ok ? answered.kind : answered.reason,
        });
      },
      on: {
        sidecarDone: {
          to: 'done',
          reduce: (draft, payload) => {
            draft.status = payload.status;
          },
        },
      },
    }),
    done: fsm.final({
      outcome: 'success',
      artifacts: {
        'status.txt': (data) => data.status,
      },
    }),
  },
});
`;

interface RecordedJsonRpcRequest {
  readonly method: string;
  readonly params: unknown;
}

describe.skipIf(!E2E_ENABLED)('sidecar threads - real Codex E2E', () => {
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

  it('completes a tiny sidecar turn and records sidecar lifecycle evidence', async () => {
    const { sseAssistantText, sseResponseCreated, sseTurnComplete, startMockModel } =
      await import('@aharness/test-support');
    const repoRoot = createTempRepo('h-sidecar-e2e-completed-');
    writeWorkflow(repoRoot, SIDECAR_COMPLETED_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    process.env['AHARNESS_MOCK_MODEL_BASE_URL'] = mock.baseUrl;
    mock.queueTurn([sseResponseCreated(), sseAssistantText('sidecar complete'), sseTurnComplete()]);

    const requests: RecordedJsonRpcRequest[] = [];
    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: repoRoot, ui: false },
      realCodexHooks(requests),
    );

    await expect(run.result()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    expect(readFileSync(join(run.runDir, 'artifacts', 'status.txt'), 'utf8')).toBe('completed');
    const events = readJsonl(run.eventsPath);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'sidecar.thread.started',
        'sidecar.turn.completed',
        'sidecar.thread.closed',
        'run.completed',
      ]),
    );

    const sidecarThreadId = sidecarThreadIdFromEvents(events);
    expect(sidecarThreadId).toBeDefined();
    expect(parentThreadStartRequests(requests)).toHaveLength(1);
    expect(sidecarThreadStartRequests(requests)).toHaveLength(1);
    expect(turnStartRequestsForThread(requests, sidecarThreadId!)).toHaveLength(1);
    expect(unsubscribeRequestsForThread(requests, sidecarThreadId!)).toHaveLength(1);
  }, 30_000);

  it('handles a sidecar request_user_input boundary without creating parent owner-input evidence', async () => {
    const {
      buildRequestUserInputTurn,
      sseAssistantText,
      sseResponseCreated,
      sseTurnComplete,
      startMockModel,
    } = await import('@aharness/test-support');
    const repoRoot = createTempRepo('h-sidecar-e2e-input-');
    writeWorkflow(repoRoot, SIDECAR_INPUT_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    process.env['AHARNESS_MOCK_MODEL_BASE_URL'] = mock.baseUrl;
    mock.queueTurn(
      buildRequestUserInputTurn('call-sidecar-input', [
        { id: 'direction', header: 'Direction', question: 'Which path?' },
      ]),
    );
    mock.queueTurn([
      sseResponseCreated(),
      sseAssistantText('sidecar answer accepted'),
      sseTurnComplete(),
    ]);

    const requests: RecordedJsonRpcRequest[] = [];
    const run = await startAharnessRunForTest(
      { target: './workflow.fsm.ts', cwd: repoRoot, ui: false },
      realCodexHooks(requests),
    );

    await expect(run.result()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    expect(readFileSync(join(run.runDir, 'artifacts', 'status.txt'), 'utf8')).toBe('completed');
    const events = readJsonl(run.eventsPath);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'sidecar.input_request.created',
        'sidecar.input_request.resolved',
        'sidecar.thread.closed',
      ]),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'request.created' &&
          event.data !== undefined &&
          event.data['kind'] === 'owner-input',
      ),
    ).toBe(false);

    const sidecarThreadId = sidecarThreadIdFromEvents(events);
    expect(sidecarThreadId).toBeDefined();
    expect(parentThreadStartRequests(requests)).toHaveLength(1);
    expect(sidecarThreadStartRequests(requests)).toHaveLength(1);
    expect(turnStartRequestsForThread(requests, sidecarThreadId!)).toHaveLength(1);
    expect(unsubscribeRequestsForThread(requests, sidecarThreadId!)).toHaveLength(1);
  }, 30_000);

  function createTempRepo(prefix: string): string {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    return repoRoot;
  }
});

function writeWorkflow(repoRoot: string, source: string): void {
  mkdirSync(join(repoRoot, 'skills', 'sidecar-research'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'skills', 'sidecar-research', 'SKILL.md'),
    [
      '---',
      'name: sidecar-research',
      'description: Fixture sidecar research skill for sidecar E2E tests.',
      '---',
      '',
      '# Sidecar Research',
      '',
      'Return one concise note for tests.',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repoRoot, 'workflow.fsm.ts'), source);
}

function realCodexHooks(
  requests: RecordedJsonRpcRequest[],
): Parameters<typeof startAharnessRunForTest>[1] {
  return {
    verify: async () => ({ exitCode: 0 }),
    versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
    authJsonExists: () => true,
    connectHeadlessWsImpl: async (options: ConnectHeadlessWsOptions) => {
      const handle = await connectHeadlessWs(options);
      const originalRequest = handle.client.request.bind(handle.client);
      handle.client.request = ((method: string, params: unknown) => {
        requests.push({ method, params });
        return originalRequest(method, params);
      }) as typeof handle.client.request;
      return handle;
    },
  };
}

function readJsonl(eventsPath: string): AharnessRunEvent[] {
  return readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AharnessRunEvent);
}

function parentThreadStartRequests(
  requests: readonly RecordedJsonRpcRequest[],
): readonly RecordedJsonRpcRequest[] {
  return requests.filter(
    (request) =>
      request.method === METHOD.threadStart &&
      request.params !== null &&
      typeof request.params === 'object' &&
      Object.prototype.hasOwnProperty.call(request.params, 'dynamicTools'),
  );
}

function sidecarThreadStartRequests(
  requests: readonly RecordedJsonRpcRequest[],
): readonly RecordedJsonRpcRequest[] {
  return requests.filter(
    (request) =>
      request.method === METHOD.threadStart &&
      request.params !== null &&
      typeof request.params === 'object' &&
      !Object.prototype.hasOwnProperty.call(request.params, 'dynamicTools'),
  );
}

function turnStartRequestsForThread(
  requests: readonly RecordedJsonRpcRequest[],
  threadId: string,
): readonly RecordedJsonRpcRequest[] {
  return requests.filter(
    (request) =>
      request.method === METHOD.turnStart &&
      request.params !== null &&
      typeof request.params === 'object' &&
      (request.params as { readonly threadId?: unknown }).threadId === threadId,
  );
}

function unsubscribeRequestsForThread(
  requests: readonly RecordedJsonRpcRequest[],
  threadId: string,
): readonly RecordedJsonRpcRequest[] {
  return requests.filter(
    (request) =>
      request.method === METHOD.threadUnsubscribe &&
      request.params !== null &&
      typeof request.params === 'object' &&
      (request.params as { readonly threadId?: unknown }).threadId === threadId,
  );
}

function sidecarThreadIdFromEvents(events: readonly AharnessRunEvent[]): string | undefined {
  const started = events.find((event) => event.type === 'sidecar.thread.started');
  const threadId = started?.threadId ?? started?.data?.['threadId'];
  return typeof threadId === 'string' ? threadId : undefined;
}
