/**
 * Phase 4c real app-server approval integration tests.
 *
 * These follow the existing real-Codex gate used by Phase 2 integration
 * tests: ordinary local/CI runs compile this file but skip execution unless
 * `codex` is on PATH and `HARNESS_E2E_REAL_CODEX=1`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { spawnAppServer } from '../src/appServer/index.js';
import { runCliForTest } from '../src/cli/runCli.js';
import { METHOD } from '../src/protocol/methodNames.js';
import type { BrowserApprovalDecision } from '../src/protocol/index.js';
import { connectHeadlessWs } from '../src/transport/wsClient.js';
import type { ConnectHeadlessWsOptions } from '../src/transport/wsClient.js';
import type {
  CommandApprovalRequest,
  FileChangeApprovalRequest,
  ReplayableAppEvent,
  UiSnapshot,
} from '../src/ui/events.js';

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const E2E_ENABLED = hasCodex() && process.env['HARNESS_E2E_REAL_CODEX'] === '1';

const APPROVAL_WALK_FSM_SOURCE = `import { harness, state, exit, terminal } from '@aharness/core';

interface DonePayload {
  _empty?: never;
}

export default harness.machine({
  id: 'approval-walk',
  initial: 'work',
  states: {
    work: state({
      entryPrompt: 'Ask to run exactly one approval-triggering tool, then submit done.',
      exits: {
        done: exit<DonePayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});
`;

type ApprovalKind = 'command' | 'file';

interface EventCollector {
  push(event: ReplayableAppEvent): void;
  waitFor<T extends ReplayableAppEvent>(
    label: string,
    predicate: (event: ReplayableAppEvent) => event is T,
  ): Promise<T>;
}

function createEventCollector(timeoutMs = 15_000): EventCollector {
  const events: ReplayableAppEvent[] = [];
  const waiters: Array<{
    label: string;
    predicate: (event: ReplayableAppEvent) => boolean;
    resolve: (event: ReplayableAppEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  return {
    push(event) {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    },
    waitFor<T extends ReplayableAppEvent>(
      label: string,
      predicate: (event: ReplayableAppEvent) => event is T,
    ): Promise<T> {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          label,
          predicate,
          resolve: resolve as unknown as (event: ReplayableAppEvent) => void,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`timed out waiting for ${label}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

interface UiSession {
  readonly baseUrl: string;
  readonly token: string;
}

function uiSessionFromStdout(chunks: ReadonlyArray<string>): UiSession {
  const stdout = chunks.join('');
  const match = stdout.match(
    /aharness: browser UI available at (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/,
  );
  if (!match) throw new Error(`browser UI URL was not printed; stdout=${stdout}`);
  const parsed = new URL(match[1]!);
  const token = parsed.searchParams.get('token');
  if (token === null || token.length === 0) {
    throw new Error(`browser UI URL did not include a token; stdout=${stdout}`);
  }
  return { baseUrl: parsed.origin, token };
}

function summarizeMockRequests(recorded: ReadonlyArray<{ body: unknown }>): string {
  return JSON.stringify(
    recorded.map((entry, index) => ({
      index: index + 1,
      ...summarizeMockRequestBody(entry.body),
    })),
  );
}

function summarizeMockRequestBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') return { bodyType: typeof body };
  const record = body as Record<string, unknown>;
  return {
    previousResponseId: record['previous_response_id'],
    input: summarizeInputItems(record['input']),
    tools: summarizeTools(record['tools']),
  };
}

function summarizeInputItems(input: unknown): unknown {
  if (!Array.isArray(input)) return typeof input;
  return input.map((item) => {
    if (item === null || typeof item !== 'object') return typeof item;
    const record = item as Record<string, unknown>;
    return {
      type: record['type'],
      name: record['name'],
      callId: record['call_id'],
      status: record['status'],
      output: summarizeOutput(record['output']),
    };
  });
}

function summarizeOutput(output: unknown): unknown {
  if (typeof output !== 'string') return typeof output;
  return output.length > 240 ? `${output.slice(0, 240)}...` : output;
}

function summarizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return typeof tools;
  return tools.map((tool) => {
    if (tool === null || typeof tool !== 'object') return typeof tool;
    const record = tool as Record<string, unknown>;
    return {
      type: record['type'],
      name: record['name'],
    };
  });
}

function uiAuthHeaders(session: UiSession): Record<string, string> {
  return { 'x-harness-ui-token': session.token };
}

async function readUiState(session: UiSession): Promise<UiSnapshot> {
  const response = await fetch(`${session.baseUrl}/api/state`, {
    headers: uiAuthHeaders(session),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as UiSnapshot;
}

async function postApprovalReply(
  session: UiSession,
  requestId: string,
  decision: BrowserApprovalDecision,
): Promise<void> {
  const response = await fetch(`${session.baseUrl}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...uiAuthHeaders(session) },
    body: JSON.stringify({ kind: 'approval', requestId, decision }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

async function withTimeout<T>(label: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function waitForPendingCleared(
  session: UiSession,
  kind: ApprovalKind,
  requestId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await readUiState(session);
    const bucket =
      kind === 'command'
        ? snapshot.state.pending.cmdApprovals
        : snapshot.state.pending.fileApprovals;
    if (!bucket.some((approval) => approval.id === requestId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`approval ${requestId} was still pending after ${timeoutMs}ms`);
}

async function waitForFileApprovalChanges(
  session: UiSession,
  requestId: string,
  timeoutMs = 5_000,
): Promise<FileChangeApprovalRequest> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await readUiState(session);
    const approval = snapshot.state.pending.fileApprovals.find((entry) => entry.id === requestId);
    if (approval && approval.changes.length > 0) return approval;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file approval ${requestId} never received changes[]`);
}

function isCommandApprovalEvent(
  event: ReplayableAppEvent,
): event is ReplayableAppEvent & { event: CommandApprovalRequest } {
  return (
    event.event.kind === 'ServerRequest' &&
    event.event.method === METHOD.commandExecutionRequestApproval
  );
}

function isFileApprovalEvent(
  event: ReplayableAppEvent,
): event is ReplayableAppEvent & { event: FileChangeApprovalRequest } {
  return (
    event.event.kind === 'ServerRequest' && event.event.method === METHOD.fileChangeRequestApproval
  );
}

function writeCodexHomeForRun(repoRoot: string): () => void {
  const prior = process.env['CODEX_HOME'];
  const codexHome = join(repoRoot, '.codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'sandbox_mode = "workspace-write"\n');
  process.env['CODEX_HOME'] = codexHome;
  return () => {
    if (prior === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = prior;
    }
  };
}

describe.skipIf(!E2E_ENABLED)('runCli — real app-server approvals (end-to-end)', () => {
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

  async function runApprovalFlow(args: {
    decision: BrowserApprovalDecision;
    firstTurn: ReadonlyArray<unknown> | ((repoRoot: string) => ReadonlyArray<unknown>);
    approvalKind: ApprovalKind;
    assertBeforeReply?: (session: UiSession, requestId: string, repoRoot: string) => Promise<void>;
    assertAfterRun?: (repoRoot: string) => void;
  }): Promise<ReadonlyArray<unknown>> {
    const { startMockModel, sseFunctionCall, sseResponseCreated, sseTurnComplete } =
      await import('@aharness/test-support');

    const repoRoot = mkdtempSync(join(tmpdir(), 'h-cli-approval-'));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    cleanups.push(() =>
      rmSync(join(repoRoot, '..', `${basename(repoRoot)}-outside.toml`), { force: true }),
    );
    cleanups.push(() =>
      rmSync(join(process.cwd(), '..', `${basename(repoRoot)}-outside.toml`), { force: true }),
    );
    cleanups.push(writeCodexHomeForRun(repoRoot));

    const fsmPath = join(repoRoot, 'approvalWalk.fsm.ts');
    writeFileSync(fsmPath, APPROVAL_WALK_FSM_SOURCE);

    const mock = await startMockModel();
    cleanups.push(() => mock.close());
    const firstTurn =
      typeof args.firstTurn === 'function' ? args.firstTurn(repoRoot) : args.firstTurn;
    mock.queueTurn(firstTurn as Parameters<typeof mock.queueTurn>[0]);
    mock.queueTurn([
      sseResponseCreated(),
      sseFunctionCall('harness_submit', { state: 'work', exit: 'done', data: {} }, 'call-submit'),
      sseTurnComplete(),
    ]);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = {
      write(chunk: string | Uint8Array): boolean {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stderr = {
      write(chunk: string | Uint8Array): boolean {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const collector = createEventCollector();
    const resolvedNotifications: unknown[] = [];
    const connectWithResolvedSpy = async (opts: ConnectHeadlessWsOptions) =>
      connectHeadlessWs({
        ...opts,
        registerHandlers(client) {
          opts.registerHandlers?.(client);
          client.onNotification(METHOD.serverRequestResolved, (params) => {
            resolvedNotifications.push(params);
          });
        },
      });

    const runPromise = runCliForTest({
      fsmPath: 'approvalWalk.fsm.ts',
      cwd: repoRoot,
      stderr,
      stdout,
      verify: async () => ({ exitCode: 0 }),
      versionGate: async () => ({ ok: true, found: '99.99.99', required: '0.0.0' }),
      authJsonExists: () => true,
      _testMockModelBaseUrl: mock.baseUrl,
      launchBrowserImpl: () => ({ ok: true }),
      spawnAppServer: (opts) =>
        spawnAppServer({
          ...opts,
          stderrSink(chunk) {
            stderrChunks.push(`[app-server] ${chunk}`);
          },
        }),
      connectHeadlessWsImpl: connectWithResolvedSpy,
      _testOnUiEvent: (event) => collector.push(event),
    });

    let approval: ReplayableAppEvent & {
      event: CommandApprovalRequest | FileChangeApprovalRequest;
    };
    try {
      const approvalPromise =
        args.approvalKind === 'command'
          ? collector.waitFor('command approval', isCommandApprovalEvent)
          : collector.waitFor('file approval', isFileApprovalEvent);
      const earlyExitPromise = runPromise.then((result) => {
        throw new Error(
          `runCli exited before ${args.approvalKind} approval; exitCode=${result.exitCode}; mockRequests=${mock.requestCount}; mockRequestSummary=${summarizeMockRequests(mock.recordedRequests)}; stdout=${stdoutChunks.join('')}; stderr=${stderrChunks.join('')}`,
        );
      });
      approval = await withTimeout(
        `${args.approvalKind} approval event`,
        20_000,
        Promise.race([approvalPromise, earlyExitPromise]),
      );
    } catch (error) {
      throw new Error(
        `${(error as Error).message}; mockRequests=${mock.requestCount}; mockRequestSummary=${summarizeMockRequests(mock.recordedRequests)}; stdout=${stdoutChunks.join('')}; stderr=${stderrChunks.join('')}`,
        { cause: error },
      );
    }
    const requestId = approval.event.id;
    const uiSession = uiSessionFromStdout(stdoutChunks);
    if (args.assertBeforeReply) {
      await withTimeout(
        `${args.approvalKind} approval pre-reply assertion`,
        5_000,
        args.assertBeforeReply(uiSession, requestId, repoRoot),
      );
    }
    await withTimeout(
      `${args.approvalKind} approval reply`,
      5_000,
      postApprovalReply(uiSession, requestId, args.decision),
    );
    await withTimeout(
      `${args.approvalKind} approval pending-clear`,
      5_000,
      waitForPendingCleared(uiSession, args.approvalKind, requestId),
    );

    let result: Awaited<typeof runPromise>;
    try {
      result = await withTimeout('runCli completion after approval reply', 30_000, runPromise);
    } catch (error) {
      throw new Error(
        `${(error as Error).message}; mockRequests=${mock.requestCount}; mockRequestSummary=${summarizeMockRequests(mock.recordedRequests)}; stdout=${stdoutChunks.join('')}; stderr=${stderrChunks.join('')}`,
        { cause: error },
      );
    }
    expect(
      result.exitCode,
      `stderr: ${stderrChunks.join('')}\nstdout: ${stdoutChunks.join('')}`,
    ).toBe(0);
    expect(mock.requestCount).toBeGreaterThanOrEqual(2);
    expect(resolvedNotifications.length).toBeGreaterThanOrEqual(1);
    args.assertAfterRun?.(repoRoot);
    return resolvedNotifications;
  }

  for (const decision of ['accept', 'decline'] as const) {
    it(`routes a Codex-generated command approval through /api/reply (${decision})`, async () => {
      const { sseFunctionCall, sseResponseCreated, sseTurnComplete } =
        await import('@aharness/test-support');

      const firstTurn = [
        sseResponseCreated(),
        sseFunctionCall(
          'shell_command',
          {
            command: 'python3 -c "print(42)"',
            timeout_ms: 10_000,
            sandbox_permissions: 'require_escalated',
          },
          'call-shell-approval',
        ),
        sseTurnComplete(),
      ];

      await runApprovalFlow({
        decision,
        firstTurn,
        approvalKind: 'command',
        assertBeforeReply: async (session, requestId) => {
          const snapshot = await readUiState(session);
          const approval = snapshot.state.pending.cmdApprovals.find(
            (entry) => entry.id === requestId,
          );
          expect(approval).toBeDefined();
          expect(approval?.requestId).not.toBe(approval?.itemId);
          expect(approval?.command).toContain('python3 -c');
        },
      });
    }, 45_000);
  }

  for (const decision of ['accept', 'decline'] as const) {
    it(`routes a Codex-generated file approval through /api/reply (${decision})`, async () => {
      const { sseFunctionCall, sseResponseCreated, sseTurnComplete } =
        await import('@aharness/test-support');

      const outsideName = (repoRoot: string) => `${basename(repoRoot)}-outside.toml`;
      const outsidePath = (repoRoot: string) => join(process.cwd(), '..', outsideName(repoRoot));
      const patch = (repoRoot: string) => [
        '*** Begin Patch',
        `*** Add File: ${outsidePath(repoRoot)}`,
        '+model = "mock"',
        '*** End Patch',
      ];
      const firstTurn = (repoRoot: string) => [
        sseResponseCreated(),
        {
          event: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            item: {
              type: 'custom_tool_call',
              name: 'apply_patch',
              input: patch(repoRoot).join('\n'),
              call_id: 'call-apply-patch-approval',
            },
          },
        },
        sseTurnComplete(),
      ];

      await runApprovalFlow({
        decision,
        firstTurn,
        approvalKind: 'file',
        assertBeforeReply: async (session, requestId, repoRoot) => {
          const approval = await waitForFileApprovalChanges(session, requestId);
          expect(approval.requestId).not.toBe(approval.itemId);
          expect(
            approval.changes.some((change) => change.path.endsWith(outsideName(repoRoot))),
          ).toBe(true);
        },
        assertAfterRun: (repoRoot) => {
          const filePath = outsidePath(repoRoot);
          if (decision === 'accept') {
            expect(existsSync(filePath)).toBe(true);
          } else {
            expect(existsSync(filePath)).toBe(false);
          }
        },
      });
    }, 45_000);
  }
});
