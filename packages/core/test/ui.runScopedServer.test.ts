import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RUN_EVENT_SCHEMA,
  createRunEventQueryService,
  type RunEventEnvelope,
} from '../src/runEvents/index.js';
import { createBrowserReplyController, type BrowserReplyResult } from '../src/ui/reply.js';
import {
  startUiServer,
  type UiRunScopedRouteService,
  type UiServerHandle,
} from '../src/ui/server.js';
import { createUiEventLog } from '../src/ui/sse.js';

const RUN_ID = 'run-server';
const OTHER_RUN_ID = 'other-run';
const TEST_UI_TOKEN = 'test-ui-token';

const runMeta = {
  runId: RUN_ID,
  threadId: 'thread-1',
  repoRoot: '/repo',
  fsmFile: 'demo.fsm.ts',
  fsmHash6: 'abc123',
  codexPin: 'codex-test',
  startedAt: '2026-05-29T00:00:00.000Z',
};

const topology = {
  machineId: 'demo',
  initial: 'root.plan',
  nodes: [{ id: 'root.plan', label: 'plan', kind: 'stateful' }],
  edges: [],
};

const handles: UiServerHandle[] = [];

afterEach(async () => {
  const openHandles = handles.splice(0);
  await Promise.all(openHandles.map((handle) => handle.close()));
});

type TestReplyHandler = (payload: unknown) => BrowserReplyResult | Promise<BrowserReplyResult>;

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function tempEventsPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aharness-ui-run-scoped-server-'));
  mkdirSync(root, { recursive: true });
  return join(root, 'events.jsonl');
}

function event(
  seq: number,
  type: string,
  overrides: Partial<RunEventEnvelope> = {},
): RunEventEnvelope {
  const runId = overrides.runId ?? RUN_ID;
  return {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq,
    id: `${runId}:${seq}`,
    time: `2026-05-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    ...overrides,
  };
}

function fixtureEvents(): RunEventEnvelope[] {
  return [
    event(1, 'run.started', { data: { startedAt: '2026-05-29T00:00:01.000Z' } }),
    event(2, 'turn.started', { turnId: 'turn-1' }),
    event(3, 'state.changed', {
      stateVisitId: 'root.plan#1',
      data: {
        from: null,
        to: 'root.plan',
        cause: 'boot',
        stateVisitId: 'root.plan#1',
        path: 'root.plan',
        leaf: 'plan',
        kind: 'stateful',
        visitCount: 1,
        exits: [{ name: 'done', kind: 'submit', branchCount: 1 }],
        row: {
          kind: 'state_change',
          label: 'root.plan',
          status: 'boot',
          summary: 'Entered root.plan',
        },
      },
      raw: { entryPrompt: 'raw prompt must not be served' },
    }),
    event(4, 'model.message', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'message-1',
      data: { row: { kind: 'message', label: 'Assistant', text: 'Hello from JSONL data' } },
      raw: { text: 'raw message must not be served' },
    }),
    event(5, 'request.created', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'request-1',
      requestId: 'request-1',
      data: {
        kind: 'owner-input',
        summary: 'Approve from data?',
        pendingCard: {
          kind: 'owner-input',
          id: 'request-1',
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Approval',
              question: 'Approve from normalized data?',
              isOther: false,
              isSecret: false,
              choices: ['yes', 'no'],
            },
          ],
        },
      },
      raw: { summary: 'raw request must not be served', answer: 'raw answer must not be served' },
    }),
  ];
}

function writeJsonl(eventsPath: string, events: ReadonlyArray<RunEventEnvelope>): void {
  writeFileSync(eventsPath, `${events.map((runEvent) => JSON.stringify(runEvent)).join('\n')}\n`);
}

function createService(
  events: ReadonlyArray<RunEventEnvelope> = fixtureEvents(),
): UiRunScopedRouteService {
  const eventsPath = tempEventsPath();
  writeJsonl(eventsPath, events);
  return createRunEventQueryService({ runId: RUN_ID, eventsPath });
}

function unavailableService(): UiRunScopedRouteService {
  const eventsPath = tempEventsPath();
  writeFileSync(eventsPath, 'not json\n');
  return createRunEventQueryService({ runId: RUN_ID, eventsPath });
}

async function startTestServer(
  options: {
    readonly service?: UiRunScopedRouteService;
    readonly activeRunId?: string;
    readonly replyHandler?: TestReplyHandler;
  } = {},
): Promise<UiServerHandle> {
  const handle = await startUiServer({
    host: '127.0.0.1',
    port: 0,
    uiToken: TEST_UI_TOKEN,
    eventLog: createUiEventLog({ run: runMeta, topology }),
    replyHandler: options.replyHandler,
    ...(options.service === undefined
      ? {}
      : {
          runScoped: {
            activeRunId: options.activeRunId ?? RUN_ID,
            service: options.service,
            getRunMeta: () => runMeta,
            topology,
            recentLimit: 10,
          },
        }),
  });
  handles.push(handle);
  return handle;
}

async function readSseUntil(response: Response, marker: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error('SSE response did not expose a readable body');
  }

  const decoder = new TextDecoder();
  let text = '';

  try {
    for (let readCount = 0; readCount < 8; readCount += 1) {
      const { done, value } = await reader.read();
      if (done) break;

      text += decoder.decode(value, { stream: true });
      if (text.includes(marker)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

async function readJsonResponse(response: Response): Promise<JsonResponse> {
  return { status: response.status, body: await response.json() };
}

async function postReply(
  handle: UiServerHandle,
  path: string,
  payload: unknown,
  token = TEST_UI_TOKEN,
): Promise<JsonResponse> {
  const response = await fetch(`${handle.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': token },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

describe('run-scoped UI server routes', () => {
  it('serves bootstrap, visit rows, recent rows, and event pages from JSONL projections without raw payloads', async () => {
    const handle = await startTestServer({ service: createService() });

    const bootstrapResponse = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/bootstrap?token=${TEST_UI_TOKEN}`,
    );
    const bootstrap = await bootstrapResponse.json();
    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrap.run).toEqual(runMeta);
    expect(bootstrap.topology).toEqual(topology);
    expect(bootstrap.latestEventId).toBe('run-server:5');
    expect(bootstrap.currentState).toEqual({
      path: 'root.plan',
      leaf: 'plan',
      kind: 'stateful',
      visitCount: 1,
      exits: [{ name: 'done', kind: 'submit', branchCount: 1 }],
    });
    expect(bootstrap.recentRows).toEqual([
      expect.objectContaining({ eventId: 'run-server:3', summary: 'Entered root.plan' }),
      expect.objectContaining({ eventId: 'run-server:4', text: 'Hello from JSONL data' }),
    ]);
    expect(bootstrap.pending).toEqual([
      expect.objectContaining({
        requestId: 'request-1',
        pendingCard: {
          kind: 'owner-input',
          id: 'request-1',
          requestId: 'request-1',
          method: 'item/tool/requestUserInput',
          questions: [
            {
              id: 'q1',
              header: 'Approval',
              question: 'Approve from normalized data?',
              isOther: false,
              isSecret: false,
              choices: ['yes', 'no'],
            },
          ],
        },
      }),
    ]);
    expect(bootstrap.posture).toEqual({
      isTerminal: false,
      isAwaiting: true,
      submittedThisTurn: false,
      open: false,
    });
    expect(JSON.stringify(bootstrap)).not.toContain('raw');
    expect(JSON.stringify(bootstrap)).not.toContain('raw prompt must not be served');
    expect(JSON.stringify(bootstrap)).not.toContain('raw answer must not be served');

    const visitRowsResponse = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/visits/root.plan%231/rows?limit=1&token=${TEST_UI_TOKEN}`,
    );
    const visitRows = await visitRowsResponse.json();
    expect(visitRowsResponse.status).toBe(200);
    expect(visitRows).toEqual({
      rows: [expect.objectContaining({ eventId: 'run-server:3', kind: 'state_change' })],
      nextCursor: 'run-server:3:row',
    });

    const recentRowsResponse = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/rows/recent?cursor=run-server:3:row&limit=1`,
      { headers: { 'X-Aharness-Ui-Token': TEST_UI_TOKEN } },
    );
    const recentRows = await recentRowsResponse.json();
    expect(recentRowsResponse.status).toBe(200);
    expect(recentRows).toEqual({
      rows: [expect.objectContaining({ eventId: 'run-server:4', text: 'Hello from JSONL data' })],
      nextCursor: null,
    });

    const eventsResponse = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/events?after=run-server:3&limit=1&token=${TEST_UI_TOKEN}`,
    );
    const events = await eventsResponse.json();
    expect(eventsResponse.status).toBe(200);
    expect(events).toEqual({
      events: [
        expect.objectContaining({
          id: 'run-server:4',
          type: 'model.message',
          data: { row: { kind: 'message', label: 'Assistant', text: 'Hello from JSONL data' } },
          offset: expect.any(Number),
          lineBytes: expect.any(Number),
        }),
      ],
      nextCursor: 'run-server:4',
      diagnostics: [],
    });
    expect(JSON.stringify(events)).not.toContain('raw message must not be served');
  });

  it('pins run-scoped route error precedence before invoking the service', async () => {
    const service = createService();
    const bootstrapSpy = vi.spyOn(service, 'getBootstrap');
    const subscribeSpy = vi.spyOn(service, 'subscribe');
    const handle = await startTestServer({ service });

    const malformed = await fetch(
      `${handle.url}/api/runs/%E0%A4%A/bootstrap?token=${TEST_UI_TOKEN}`,
    );
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'run-scoped-route-not-found' });

    const encodedSlash = await fetch(
      `${handle.url}/api/runs/run%2Fserver/bootstrap?token=${TEST_UI_TOKEN}`,
    );
    expect(encodedSlash.status).toBe(404);
    expect(await encodedSlash.json()).toEqual({ error: 'run-scoped-route-not-found' });

    const unmatched = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/unknown?token=${TEST_UI_TOKEN}`,
    );
    expect(unmatched.status).toBe(404);
    expect(await unmatched.json()).toEqual({ error: 'run-scoped-route-not-found' });

    const wrongMethod = await fetch(`${handle.url}/api/runs/${RUN_ID}/bootstrap`, {
      method: 'POST',
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');

    const unauthorized = await fetch(`${handle.url}/api/runs/${RUN_ID}/bootstrap`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' });

    const wrongRun = await fetch(
      `${handle.url}/api/runs/${OTHER_RUN_ID}/bootstrap?token=${TEST_UI_TOKEN}`,
    );
    expect(wrongRun.status).toBe(404);
    expect(await wrongRun.json()).toEqual({ error: 'run-not-found' });
    expect(bootstrapSpy).not.toHaveBeenCalled();

    const wrongRunStream = await fetch(
      `${handle.url}/api/runs/${OTHER_RUN_ID}/stream?token=${TEST_UI_TOKEN}`,
    );
    expect(wrongRunStream.status).toBe(404);
    expect(await wrongRunStream.json()).toEqual({ error: 'run-not-found' });
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it('returns run-not-found for valid run-scoped routes when no route service is installed', async () => {
    const handle = await startTestServer();

    const response = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/rows/recent?token=${TEST_UI_TOKEN}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'run-not-found' });
  });

  it.each([
    ['/api/runs/run-server/bootstrap', 'POST', 'GET'],
    ['/api/runs/run-server/visits/root.plan%231/rows', 'POST', 'GET'],
    ['/api/runs/run-server/rows/recent', 'POST', 'GET'],
    ['/api/runs/run-server/events', 'POST', 'GET'],
    ['/api/runs/run-server/stream', 'POST', 'GET'],
    ['/api/runs/run-server/reply', 'GET', 'POST'],
  ])('returns 405 for %s method mismatches before auth', async (path, method, allow) => {
    const handle = await startTestServer({ service: createService() });

    const response = await fetch(`${handle.url}${path}`, { method });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allow);
  });

  it('maps event cursor and unavailable replay errors to stable JSON responses', async () => {
    const handle = await startTestServer({ service: createService() });

    const invalid = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/events?after=bad-cursor&token=${TEST_UI_TOKEN}`,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid-event-cursor' });

    const future = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/events?after=${RUN_ID}:99&token=${TEST_UI_TOKEN}`,
    );
    expect(future.status).toBe(409);
    expect(await future.json()).toEqual({
      error: 'event-cursor-out-of-range',
      latestEventId: 'run-server:5',
    });

    const unavailableHandle = await startTestServer({ service: unavailableService() });
    const unavailable = await fetch(
      `${unavailableHandle.url}/api/runs/${RUN_ID}/bootstrap?token=${TEST_UI_TOKEN}`,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: 'run-event-log-unavailable',
      diagnostics: [expect.objectContaining({ code: 'malformed-non-final-line' })],
    });
  });

  it('streams canonical run-scoped SSE events with query-token auth and no raw payloads', async () => {
    const handle = await startTestServer({ service: createService() });

    const headerOnly = await fetch(`${handle.url}/api/runs/${RUN_ID}/stream`, {
      headers: { 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
    });
    expect(headerOnly.status).toBe(401);

    const response = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/stream?after=run-server:3&token=${TEST_UI_TOKEN}`,
    );
    const body = await readSseUntil(response, 'model.message');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('id: run-server:4\n');
    expect(body).toContain('event: model.message\n');
    expect(body).toContain('data:   "type": "model.message"');
    expect(body).toContain('data:       "text": "Hello from JSONL data"');
    expect(body).not.toContain('raw message must not be served');
  });

  it('serves replies only through the run-scoped reply route', async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly payload: unknown;
      readonly result: BrowserReplyResult;
    }> = [
      {
        name: 'accepted owner input',
        payload: { kind: 'owner-input', requestId: 'owner-1', answers: { q1: 'alpha' } },
        result: { status: 200, body: { ok: true } },
      },
      {
        name: 'rejected owner input',
        payload: { kind: 'owner-input', requestId: 'owner-2', answers: {} },
        result: {
          status: 400,
          body: { error: 'missing-owner-input-answer', missingQuestionIds: ['q1'] },
        },
      },
      {
        name: 'accepted user prompt',
        payload: { kind: 'user-prompt', text: 'continue' },
        result: { status: 200, body: { ok: true } },
      },
      {
        name: 'rejected user prompt',
        payload: { kind: 'user-prompt', text: '' },
        result: { status: 409, body: { error: 'state-not-open' } },
      },
      {
        name: 'accepted approval',
        payload: { kind: 'approval', requestId: 'approval-1', decision: 'accept' },
        result: { status: 200, body: { ok: true } },
      },
      {
        name: 'rejected approval',
        payload: { kind: 'approval', requestId: 'approval-2', decision: 'reject' },
        result: { status: 409, body: { error: 'approval-not-pending' } },
      },
      {
        name: 'accepted permission',
        payload: { kind: 'permission', requestId: 'permission-1', decision: 'accept' },
        result: { status: 200, body: { ok: true } },
      },
      {
        name: 'rejected permission',
        payload: { kind: 'permission', requestId: 'permission-2', decision: 'reject' },
        result: { status: 409, body: { error: 'permission-not-pending' } },
      },
      {
        name: 'accepted elicitation',
        payload: {
          kind: 'elicitation',
          requestId: 'elicitation-1',
          action: 'accept',
          values: {},
        },
        result: { status: 200, body: { ok: true } },
      },
      {
        name: 'rejected elicitation',
        payload: {
          kind: 'elicitation',
          requestId: 'elicitation-2',
          action: 'cancel',
        },
        result: { status: 409, body: { error: 'elicitation-not-pending' } },
      },
    ];
    const results = new Map(
      cases.map((testCase) => [JSON.stringify(testCase.payload), testCase.result]),
    );
    const replyHandler = vi.fn<TestReplyHandler>((payload) => {
      const result = results.get(JSON.stringify(payload));
      if (result === undefined) {
        throw new Error(`unexpected reply payload for ${JSON.stringify(payload)}`);
      }
      return result;
    });
    const handle = await startTestServer({ service: createService(), replyHandler });

    for (const testCase of cases) {
      const flat = await postReply(handle, '/api/reply', testCase.payload);
      const runScoped = await postReply(handle, `/api/runs/${RUN_ID}/reply`, testCase.payload);

      expect(flat, testCase.name).toEqual({ status: 404, body: { error: 'Not found' } });
      expect(runScoped, testCase.name).toEqual(testCase.result);
    }
    expect(replyHandler).toHaveBeenCalledTimes(cases.length);
  });

  it('rejects run-scoped reply transport failures before invoking the reply handler', async () => {
    const lifecycle: unknown[] = [];
    const replyHandler = vi.fn<TestReplyHandler>((payload) => {
      lifecycle.push({ phase: 'handler', payload });
      return { status: 200, body: { ok: true } };
    });
    const service = createService();
    const handle = await startTestServer({ service, replyHandler });

    const malformed = await fetch(`${handle.url}/api/runs/${RUN_ID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: '{"kind":"user-prompt",',
    });
    const oversized = await fetch(`${handle.url}/api/runs/${RUN_ID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'x'.repeat(65_536) }),
    });
    const unauthorized = await fetch(`${handle.url}/api/runs/${RUN_ID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });
    const wrongRun = await fetch(`${handle.url}/api/runs/${OTHER_RUN_ID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });

    expect(await readJsonResponse(malformed)).toEqual({
      status: 400,
      body: { error: 'malformed-json' },
    });
    expect(await readJsonResponse(oversized)).toEqual({
      status: 413,
      body: { error: 'reply-body-too-large' },
    });
    expect(await readJsonResponse(unauthorized)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(await readJsonResponse(wrongRun)).toEqual({
      status: 404,
      body: { error: 'run-not-found' },
    });
    expect(replyHandler).not.toHaveBeenCalled();
    expect(lifecycle).toEqual([]);
  });

  it('returns a stable run-scoped reply response when no reply handler is installed', async () => {
    const handle = await startTestServer({ service: createService() });

    const response = await postReply(handle, `/api/runs/${RUN_ID}/reply`, {
      kind: 'user-prompt',
      text: 'continue',
    });

    expect(response).toEqual({
      status: 503,
      body: { error: 'reply-handler-unavailable' },
    });
  });

  it('forwards authorized run-scoped replies through BrowserReplyController lifecycle hooks', async () => {
    const lifecycle: unknown[] = [];
    const sendUserPrompt = vi.fn();
    const controller = createBrowserReplyController({
      isOpen: () => true,
      sendUserPrompt,
      onReplySubmitted: (input) => lifecycle.push({ phase: 'submitted', ...input }),
      onReplyResolved: (input) => lifecycle.push({ phase: 'resolved', ...input }),
    });
    const handle = await startTestServer({
      service: createService(),
      replyHandler: (payload) => controller.handleReply(payload),
    });

    const accepted = await postReply(handle, `/api/runs/${RUN_ID}/reply`, {
      kind: 'user-prompt',
      text: 'continue',
    });
    const unsupported = await postReply(handle, `/api/runs/${RUN_ID}/reply`, {
      kind: 'future-reply',
      requestId: 'future-1',
    });

    expect(accepted).toEqual({ status: 200, body: { ok: true } });
    expect(unsupported).toEqual({ status: 400, body: { error: 'unknown-reply-kind' } });
    expect(sendUserPrompt).toHaveBeenCalledExactlyOnceWith('continue');
    expect(lifecycle).toEqual([
      expect.objectContaining({ phase: 'submitted', kind: 'user-prompt' }),
      expect.objectContaining({
        phase: 'resolved',
        kind: 'user-prompt',
        result: { status: 200, body: { ok: true } },
      }),
      expect.objectContaining({
        phase: 'submitted',
        kind: 'future-reply',
        requestId: 'future-1',
      }),
      expect.objectContaining({
        phase: 'resolved',
        kind: 'future-reply',
        requestId: 'future-1',
        result: { status: 400, body: { error: 'unknown-reply-kind' } },
      }),
    ]);
  });

  it('forwards run-scoped replies through the flat reply handler with header-token auth', async () => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 202,
      body: { ok: true, source: 'handler' },
    });
    const handle = await startTestServer({ service: createService(), replyHandler });

    const queryToken = await fetch(
      `${handle.url}/api/runs/${RUN_ID}/reply?token=${TEST_UI_TOKEN}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
      },
    );
    expect(queryToken.status).toBe(401);

    const wrongRun = await fetch(`${handle.url}/api/runs/${OTHER_RUN_ID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });
    expect(wrongRun.status).toBe(404);
    expect(await wrongRun.json()).toEqual({ error: 'run-not-found' });

    const response = await fetch(`${handle.url}/api/runs/${RUN_ID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({ ok: true, source: 'handler' });
    expect(replyHandler).toHaveBeenCalledExactlyOnceWith({
      kind: 'user-prompt',
      text: 'continue',
    });
  });
});
