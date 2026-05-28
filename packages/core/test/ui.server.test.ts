import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FsmState, RunMeta } from '../src/ui/events.js';
import type { BrowserReplyResult } from '../src/ui/reply.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';
import { createUiEventLog, type UiEventLog } from '../src/ui/sse.js';

const runMeta: RunMeta = {
  runId: 'run-1',
  threadId: 'thread-1',
  repoRoot: '/repo',
  fsmFile: 'agent.fsm.ts',
  fsmHash6: 'abc123',
  codexPin: 'codex-test',
  startedAt: '2026-05-13T00:00:00.000Z',
};

const state: FsmState = {
  path: 'root.working',
  leaf: 'working',
  kind: 'stateful',
  exits: [{ name: 'done', kind: 'submit', branchCount: 1 }],
  visitCount: 2,
};

const handles: UiServerHandle[] = [];
const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui/static');
const TEST_UI_TOKEN = 'test-ui-token';

afterEach(async () => {
  const openHandles = handles.splice(0);
  await Promise.all(openHandles.map((handle) => handle.close()));
});

type TestReplyHandler = (payload: unknown) => BrowserReplyResult | Promise<BrowserReplyResult>;

async function startTestServer(
  eventLog: UiEventLog,
  replyHandler?: TestReplyHandler,
): Promise<UiServerHandle> {
  const handle = await startUiServer({
    host: '127.0.0.1',
    port: 0,
    uiToken: TEST_UI_TOKEN,
    eventLog,
    replyHandler,
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
      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.includes(marker)) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

function builtAssetPath(extension: 'css' | 'js'): string {
  const indexHtml = readFileSync(resolve(staticRoot, 'index.html'), 'utf8');
  const matches = [...indexHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)];
  const asset = matches.map((match) => match[1]).find((path) => path.endsWith(`.${extension}`));

  if (asset === undefined) {
    throw new Error(`Built ${extension} asset was not referenced by static index.html`);
  }

  return `/${asset}`;
}

describe('startUiServer', () => {
  it('returns the chosen loopback URL and a close handle', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof handle.close).toBe('function');
  });

  it('serves the built React index from / and /index.html', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    for (const path of ['/', '/index.html']) {
      const response = await fetch(`${handle.url}${path}`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(body).toContain('<title>aharness · run</title>');
      expect(body).toContain('<div id="root">');
      expect(body).toContain('id="aharness-preboot"');
      expect(body).toMatch(/(?:src|href)="\.\/assets\/index-[^"]+\.(?:js|css)"/);
    }
  });

  it('serves built JavaScript and CSS assets with correct content types', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const jsResponse = await fetch(`${handle.url}${builtAssetPath('js')}`);
    const jsBody = await jsResponse.text();
    const cssResponse = await fetch(`${handle.url}${builtAssetPath('css')}`);
    const cssBody = await cssResponse.text();

    expect(jsResponse.status).toBe(200);
    expect(jsResponse.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
    expect(jsBody).toContain('/api/state');
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(cssBody).toContain('font-family');
  });

  it('returns 404 for unknown static files and rejects encoded traversal', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const missing = await fetch(`${handle.url}/assets/missing.js`);
    const traversal = await fetch(`${handle.url}/assets/%2e%2e/package.json`);
    const traversalBody = await traversal.text();

    expect(missing.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(traversalBody).not.toContain('"name"');
    expect(traversalBody).not.toContain('@aharness/core');
  });

  it('returns 405 for unsupported methods on static routes', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const indexResponse = await fetch(`${handle.url}/index.html`, { method: 'POST' });
    const assetResponse = await fetch(`${handle.url}${builtAssetPath('js')}`, { method: 'POST' });

    expect(indexResponse.status).toBe(405);
    expect(indexResponse.headers.get('allow')).toBe('GET');
    expect(assetResponse.status).toBe(405);
    expect(assetResponse.headers.get('allow')).toBe('GET');
  });

  it('returns the current state snapshot from /api/state', async () => {
    const eventLog = createUiEventLog({ capacity: 8, run: runMeta });
    eventLog.publish({
      kind: 'StateChange',
      from: null,
      to: 'root.working',
      cause: 'boot',
      newState: state,
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'Hello',
      reasoning: true,
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: ' world',
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/state?token=${TEST_UI_TOKEN}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual({
      latestEventId: '3',
      state: {
        run: runMeta,
        posture: {
          isTerminal: false,
          isAwaiting: false,
          submittedThisTurn: false,
          open: false,
        },
        currentState: state,
        topology: {
          machineId: '',
          initial: '',
          nodes: [],
          edges: [],
        },
        transcript: [{ id: 'msg-1', text: 'Hello world', reasoning: true }],
        frameworkNotes: [],
        diagnostics: [],
        pending: {
          ownerInput: null,
          fileApprovals: [],
          cmdApprovals: [],
          permissionApprovals: [],
          elicitations: [],
        },
        completedTurns: [],
      },
    });
  });

  it('protects browser API routes with the per-run UI token', async () => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const state = await fetch(`${handle.url}/api/state`);
    const stream = await fetch(`${handle.url}/api/stream`);
    const queryOnlyReply = await fetch(`${handle.url}/api/reply?token=${TEST_UI_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });
    const bodyOnlyReply = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_UI_TOKEN, kind: 'user-prompt', text: 'continue' }),
    });

    expect(state.status).toBe(401);
    expect(await state.json()).toEqual({ error: 'unauthorized' });
    expect(state.headers.get('access-control-allow-origin')).toBeNull();
    expect(stream.status).toBe(401);
    expect(queryOnlyReply.status).toBe(401);
    expect(bodyOnlyReply.status).toBe(401);
    expect(replyHandler).not.toHaveBeenCalled();
  });

  it('returns a fully reduced replay-safe late-join snapshot from /api/state', async () => {
    const eventLog = createUiEventLog({ capacity: 16, run: runMeta });
    const pendingOwnerInput = {
      kind: 'ServerRequest',
      id: 'owner-input-1',
      method: 'item/tool/requestUserInput',
      questions: [
        {
          id: 'q1',
          header: 'Next',
          question: 'What should happen next?',
          isOther: false,
          isSecret: false,
          choices: ['Continue', 'Stop'],
        },
      ],
    } as const;

    eventLog.publish({
      kind: 'StateChange',
      from: null,
      to: 'root.working',
      cause: 'boot',
      newState: state,
    });
    eventLog.publish({
      kind: 'PostureChange',
      posture: {
        isAwaiting: true,
        submittedThisTurn: true,
        open: true,
      },
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'Boot',
      reasoning: true,
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: ' complete',
    });
    eventLog.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'orientation text',
      variant: 'orientation',
    });
    eventLog.publish(pendingOwnerInput);
    eventLog.publish({
      kind: 'OwnerInputResolved',
      id: 'owner-input-1',
    });
    eventLog.publish({
      kind: 'TurnCompleted',
      turnId: 'turn-1',
      finishReason: 'stop',
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/state?token=${TEST_UI_TOKEN}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      latestEventId: '8',
      state: {
        run: runMeta,
        posture: {
          isTerminal: false,
          isAwaiting: true,
          submittedThisTurn: true,
          open: true,
        },
        currentState: state,
        topology: {
          machineId: '',
          initial: '',
          nodes: [],
          edges: [],
        },
        transcript: [{ id: 'msg-1', text: 'Boot complete', reasoning: true }],
        frameworkNotes: [
          {
            kind: 'FrameworkNote',
            id: 'note-1',
            text: 'orientation text',
            variant: 'orientation',
          },
        ],
        diagnostics: [],
        pending: {
          ownerInput: null,
          fileApprovals: [],
          cmdApprovals: [],
          permissionApprovals: [],
          elicitations: [],
        },
        completedTurns: [
          {
            kind: 'TurnCompleted',
            turnId: 'turn-1',
            finishReason: 'stop',
          },
        ],
      },
    });
  });

  it('reflects published posture updates in /api/state snapshots', async () => {
    const eventLog = createUiEventLog({ capacity: 8, run: runMeta });
    eventLog.publish({
      kind: 'PostureChange',
      posture: {
        isAwaiting: true,
        submittedThisTurn: true,
      },
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/state?token=${TEST_UI_TOKEN}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.state.posture).toEqual({
      isTerminal: false,
      isAwaiting: true,
      submittedThisTurn: true,
      open: false,
    });
  });

  it('streams fresh-clear boundary and abandoned diagnostic SSE frames', async () => {
    const eventLog = createUiEventLog({ capacity: 8, run: runMeta });
    eventLog.publish({
      kind: 'FreshClearBoundary',
      id: 'fresh-1',
      reason: 'clearOnEntry',
      previousThreadId: 'thread-old',
      nextThreadId: 'thread-new',
      statePath: 'root.working',
    });
    eventLog.publish({
      kind: 'AbandonedThreadDiagnostic',
      id: 'diag-1',
      threadId: 'thread-old',
      source: 'turnCompleted',
      message: 'ignored old turn',
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`);
    const body = await readSseUntil(response, 'AbandonedThreadDiagnostic');

    expect(response.status).toBe(200);
    expect(body).toContain('event: FreshClearBoundary\n');
    expect(body).toContain('data:   "previousThreadId": "thread-old"');
    expect(body).toContain('event: AbandonedThreadDiagnostic\n');
    expect(body).toContain('data:   "source": "turnCompleted"');
  });

  it('streams SSE frames and replays events after Last-Event-ID', async () => {
    const eventLog = createUiEventLog({ capacity: 8, run: runMeta });
    eventLog.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'already seen',
      variant: 'info',
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'new text',
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`, {
      headers: { 'Last-Event-ID': '1' },
    });
    const body = await readSseUntil(response, 'AgentMessageDelta');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('id: 2\n');
    expect(body).toContain('event: AgentMessageDelta\n');
    expect(body).toContain('data:   "delta": "new text"');
    expect(body).not.toContain('already seen');
  });

  it('uses the after query cursor when Last-Event-ID is absent', async () => {
    const eventLog = createUiEventLog({ capacity: 8, run: runMeta });
    eventLog.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'already seen',
      variant: 'info',
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'msg-1',
      delta: 'new text',
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}&after=1`);
    const body = await readSseUntil(response, 'AgentMessageDelta');

    expect(response.status).toBe(200);
    expect(body).toContain('id: 2\n');
    expect(body).not.toContain('already seen');
  });

  it('flushes events published immediately before server close to active streams', async () => {
    const eventLog = createUiEventLog({ capacity: 8, run: runMeta });
    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`);

    eventLog.publish({
      kind: 'StateChange',
      from: 'root.working',
      to: 'root.done',
      cause: 'submit',
      newState: {
        path: 'root.done',
        leaf: 'done',
        kind: 'terminal',
        exits: [],
        visitCount: 1,
      },
    });
    await handle.close();
    handles.splice(handles.indexOf(handle), 1);

    const body = await response.text();

    expect(body).toContain('event: StateChange\n');
    expect(body).toContain('data:   "to": "root.done"');
    expect(body).toContain('data:     "kind": "terminal"');
  });

  it('streams an explicit resync event when replay is impossible', async () => {
    const eventLog = createUiEventLog({ capacity: 1, run: runMeta });
    eventLog.publish({
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'evicted',
      variant: 'info',
    });
    eventLog.publish({
      kind: 'FrameworkNote',
      id: 'note-2',
      text: 'retained',
      variant: 'info',
    });

    const handle = await startTestServer(eventLog);
    const response = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`, {
      headers: { 'Last-Event-ID': '1' },
    });
    const body = await readSseUntil(response, 'ResyncRequired');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: ResyncRequired\n');
    expect(body).toContain('data:   "reason": "event-buffer-overflow"');
    expect(body).toContain('data:   "requestedLastEventId": "1"');
    expect(eventLog.snapshot().latestEventId).toBe('2');
  });

  it.each([
    ['invalid', 'not-decimal', 'unknown-last-event-id'],
    ['future', '99', 'unknown-last-event-id'],
    ['evicted', '1', 'event-buffer-overflow'],
  ])(
    'streams a resync event for %s Last-Event-ID cursors',
    async (_name, lastEventId, expectedReason) => {
      const eventLog = createUiEventLog({ capacity: 1, run: runMeta });
      eventLog.publish({
        kind: 'FrameworkNote',
        id: 'note-1',
        text: 'evicted',
        variant: 'info',
      });
      eventLog.publish({
        kind: 'FrameworkNote',
        id: 'note-2',
        text: 'retained',
        variant: 'info',
      });

      const handle = await startTestServer(eventLog);
      const response = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`, {
        headers: { 'Last-Event-ID': lastEventId },
      });
      const body = await readSseUntil(response, 'ResyncRequired');

      expect(response.status).toBe(200);
      expect(body).toContain('id: 2\n');
      expect(body).toContain('event: ResyncRequired\n');
      expect(body).toContain(`data:   "reason": "${expectedReason}"`);
      expect(body).toContain(`data:   "requestedLastEventId": "${lastEventId}"`);
      expect(eventLog.snapshot().latestEventId).toBe('2');
    },
  );

  it('forwards parsed POST /api/reply JSON to the reply handler', async () => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 200,
      body: { ok: true, source: 'handler' },
    });
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const response = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({
        kind: 'owner-input',
        requestId: 'item-1',
        answers: { q1: 'alpha' },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual({ ok: true, source: 'handler' });
    expect(replyHandler).toHaveBeenCalledExactlyOnceWith({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha' },
    });
  });

  it('returns 400 for malformed POST /api/reply JSON without invoking the handler', async () => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const response = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: '{"kind":"user-prompt",',
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual({ error: 'malformed-json' });
    expect(replyHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['owner-input', { kind: 'owner-input', requestId: 'item-1', answers: { q1: 'alpha' } }],
    ['user-prompt', { kind: 'user-prompt', text: 'continue' }],
  ])('returns 200 JSON for an accepted %s reply', async (_name, payload) => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const response = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual({ ok: true });
    expect(replyHandler).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it.each([
    ['unknown', { kind: 'future-reply' }, { status: 400, body: { error: 'unknown-reply-kind' } }],
    [
      'reserved approval',
      { kind: 'approval', requestId: 'approval-1', decision: 'accept' },
      { status: 501, body: { error: 'reply-kind-unavailable' } },
    ],
  ])('returns non-2xx JSON for %s replies via the handler', async (_name, payload, result) => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue(result);
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const response = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    expect(response.status).toBe(result.status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual(result.body);
    expect(replyHandler).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it('returns 413 for POST /api/reply bodies that exceed the reply size limit', async () => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const response = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'x'.repeat(65_536) }),
    });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual({ error: 'reply-body-too-large' });
    expect(replyHandler).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes and 405 for unsupported methods', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const unknown = await fetch(`${handle.url}/missing`);
    const unsupported = await fetch(`${handle.url}/api/state`, {
      method: 'POST',
    });

    expect(unknown.status).toBe(404);
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('allow')).toBe('GET');
  });
});
