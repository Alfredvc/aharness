import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FsmState, RunMeta } from '../src/ui/events.js';
import {
  startUiServer,
  type UiRunScopedEvent,
  type UiRunScopedRouteService,
  type UiServerHandle,
} from '../src/ui/server.js';
import { createUiEventLog, type UiEventLog } from '../src/ui/sse.js';

const handles: UiServerHandle[] = [];
const browserGoldenProcesses: ChildProcessWithoutNullStreams[] = [];
const TEST_UI_TOKEN = 'browser-golden-token';
const testFileDir = dirname(fileURLToPath(import.meta.url));
const browserGoldenScriptPath = resolve(testFileDir, '../scripts/browserGoldenServer.mjs');

const runMeta: RunMeta = {
  runId: 'browser-golden-run',
  threadId: 'browser-golden-thread',
  repoRoot: '/repo',
  fsmFile: 'agent.fsm.ts',
  fsmHash6: '3d4c0d',
  codexPin: 'codex-test',
  startedAt: '2026-05-13T00:00:00.000Z',
};

const pirateRoastState: FsmState = {
  path: 'pirate-roast.awaiting-open-composer',
  leaf: 'awaiting-open-composer',
  kind: 'stateful',
  exits: [{ name: 'send-roast', kind: 'submit', branchCount: 1 }],
  visitCount: 3,
};

const requirementSpecState: FsmState = {
  path: 'requirement-spec.open-owner-input',
  leaf: 'open-owner-input',
  kind: 'stateful',
  open: true,
  exits: [{ name: 'submit-requirements', kind: 'submit', branchCount: 1 }],
  visitCount: 2,
};

afterEach(async () => {
  const openHandles = handles.splice(0);
  const openProcesses = browserGoldenProcesses.splice(0);
  await Promise.all([
    ...openHandles.map((handle) => handle.close()),
    ...openProcesses.map((child) => stopBrowserGoldenProcess(child)),
  ]);
});

type GoldenFixture = {
  readonly eventLog: UiEventLog;
  readonly runScoped: UiRunScopedRouteService;
};

async function startGoldenServer(fixture: GoldenFixture): Promise<UiServerHandle> {
  const handle = await startUiServer({
    host: '127.0.0.1',
    port: 0,
    uiToken: TEST_UI_TOKEN,
    eventLog: fixture.eventLog,
    runScoped: {
      activeRunId: runMeta.runId,
      service: fixture.runScoped,
      getRunMeta: () => runMeta,
      topology: null,
    },
  });
  handles.push(handle);
  return handle;
}

function seedPirateRoast(): GoldenFixture {
  const eventLog = createUiEventLog({ capacity: 32, run: runMeta });
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: pirateRoastState.path,
    cause: 'boot',
    newState: pirateRoastState,
  });
  eventLog.publish({
    kind: 'PostureChange',
    posture: {
      isAwaiting: false,
      submittedThisTurn: false,
      open: true,
    },
  });
  eventLog.publish({
    kind: 'AgentMessageDelta',
    id: 'pirate-roast-transcript',
    delta: 'Arrr, your diff needs a sharper hook before it sails.',
  });
  return {
    eventLog,
    runScoped: createStaticRunScopedService({
      state: pirateRoastState,
      rows: [
        {
          kind: 'message',
          text: 'Arrr, your diff needs a sharper hook before it sails.',
        },
      ],
      pending: [],
    }),
  };
}

function seedRequirementSpec(): GoldenFixture {
  const eventLog = createUiEventLog({ capacity: 32, run: runMeta });
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: requirementSpecState.path,
    cause: 'boot',
    newState: requirementSpecState,
  });
  eventLog.publish({
    kind: 'ServerRequest',
    id: 'requirement-owner-input',
    method: 'item/tool/requestUserInput',
    questions: [
      {
        id: 'scope',
        header: 'Scope',
        question: 'Which requirement should the spec lock down next?',
        isOther: false,
        isSecret: false,
        choices: ['Acceptance criteria', 'Non-goals'],
      },
    ],
  });
  eventLog.publish({
    kind: 'AgentMessageDelta',
    id: 'requirement-spec-transcript',
    delta: 'Need owner input before finalizing the requirement spec.',
  });
  return {
    eventLog,
    runScoped: createStaticRunScopedService({
      state: requirementSpecState,
      rows: [
        {
          kind: 'message',
          text: 'Need owner input before finalizing the requirement spec.',
        },
      ],
      pending: [
        {
          requestId: 'requirement-owner-input',
          status: 'pending',
          kind: 'owner-input',
          summary: 'Which requirement should the spec lock down next?',
          createdAt: '2026-05-13T00:00:01.000Z',
          updatedAt: '2026-05-13T00:00:01.000Z',
          lastEventId: `${runMeta.runId}:2`,
          pendingCard: {
            kind: 'owner-input',
            id: 'requirement-owner-input',
            requestId: 'requirement-owner-input',
            method: 'item/tool/requestUserInput',
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Which requirement should the spec lock down next?',
                isOther: false,
                isSecret: false,
                choices: ['Acceptance criteria', 'Non-goals'],
              },
            ],
          },
        },
      ],
    }),
  };
}

function createStaticRunScopedService(options: {
  readonly state: FsmState;
  readonly rows: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
  readonly pending: ReadonlyArray<unknown>;
}): UiRunScopedRouteService {
  const stateVisitId = `${options.state.path}#${options.state.visitCount}`;
  const time = '2026-05-13T00:00:00.000Z';
  const stateVisit = {
    id: stateVisitId,
    path: options.state.path,
    seq: 1,
    time,
    from: null,
    to: options.state.path,
    cause: 'boot',
  };
  const events: UiRunScopedEvent[] = [
    {
      schema: 'aharness.event.v1',
      runId: runMeta.runId,
      seq: 1,
      id: `${runMeta.runId}:1`,
      time,
      type: 'state.changed',
      stateVisitId,
      data: {
        path: options.state.path,
        leaf: options.state.leaf,
        kind: options.state.kind,
        visitCount: options.state.visitCount,
        exits: options.state.exits,
        row: {
          kind: 'state_change',
          label: options.state.path,
          summary: `Entered ${options.state.path}`,
        },
      },
      offset: 0,
      lineBytes: 1,
    },
    ...options.pending.map((pending, index): UiRunScopedEvent => {
      const summary =
        typeof pending === 'object' &&
        pending !== null &&
        'summary' in pending &&
        typeof pending.summary === 'string'
          ? pending.summary
          : 'pending request';
      const requestId =
        typeof pending === 'object' &&
        pending !== null &&
        'requestId' in pending &&
        typeof pending.requestId === 'string'
          ? pending.requestId
          : `request-${index + 1}`;
      const pendingCard =
        typeof pending === 'object' && pending !== null && 'pendingCard' in pending
          ? pending.pendingCard
          : undefined;
      const seq = index + 2;
      return {
        schema: 'aharness.event.v1',
        runId: runMeta.runId,
        seq,
        id: `${runMeta.runId}:${seq}`,
        time,
        type: 'request.created',
        stateVisitId,
        requestId,
        data: {
          ...(pendingCard === undefined ? {} : { pendingCard }),
          row: { kind: 'request', status: 'pending', summary },
        },
        offset: seq,
        lineBytes: 1,
      };
    }),
    ...options.rows.map((row, index): UiRunScopedEvent => {
      const seq = index + 2 + options.pending.length;
      return {
        schema: 'aharness.event.v1',
        runId: runMeta.runId,
        seq,
        id: `${runMeta.runId}:${seq}`,
        time,
        type: 'model.delta',
        stateVisitId,
        itemId: `row-${seq}`,
        data: { row: { kind: row.kind, text: row.text } },
        offset: seq,
        lineBytes: 1,
      };
    }),
  ];
  const rows = events
    .map((event) => {
      const row = event.data?.['row'];
      return typeof row === 'object' && row !== null
        ? {
            id: `${event.id}:row`,
            eventId: event.id,
            seq: event.seq,
            time: event.time,
            type: event.type,
            stateVisitId,
            ...(row as Record<string, unknown>),
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const latestEventId = events.at(-1)?.id ?? null;
  const afterSeq = (after: string | null | undefined): number => {
    if (after === undefined || after === null) return 0;
    const prefix = `${runMeta.runId}:`;
    return after.startsWith(prefix) ? Number(after.slice(prefix.length)) : 0;
  };

  return {
    runId: runMeta.runId,
    subscribe: () => () => undefined,
    getLatestEventId: () => latestEventId,
    getBootstrap: ({ getRunMeta, topology }) => ({
      ok: true,
      bootstrap: {
        run: getRunMeta(),
        topology: topology ?? null,
        latestEventId,
        currentState: {
          path: options.state.path,
          leaf: options.state.leaf,
          kind: options.state.kind,
          visitCount: options.state.visitCount,
          exits: options.state.exits,
        },
        posture: {
          isTerminal: false,
          isAwaiting: options.pending.length > 0,
          submittedThisTurn: false,
          open: options.pending.length === 0 && options.state.open === true,
        },
        currentStateVisit: stateVisit,
        stateVisits: [stateVisit],
        statePathVisits: { [options.state.path]: [stateVisitId] },
        pending: options.pending,
        aggregateStats: { turnCount: 0 },
        completionStats: null,
        recentRows: rows,
        diagnostics: [],
      },
    }),
    getCompletionStats: () => ({ ok: true, completionStats: null }),
    getStateVisitRows: (visitId) => ({
      ok: true,
      rows: visitId === stateVisitId ? rows : [],
      nextCursor: null,
    }),
    getRecentRows: () => ({ ok: true, rows, nextCursor: null }),
    getEventPage: (query) => ({
      ok: true,
      events: events.filter((event) => event.seq > afterSeq(query?.after)),
      nextCursor: null,
      diagnostics: [],
    }),
    eventsAfter: (after) => ({
      ok: true,
      events: events.filter((event) => event.seq > afterSeq(after)),
    }),
  };
}

function referencedAssetPaths(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((asset) => asset.endsWith('.js') || asset.endsWith('.css'));
}

async function fetchText(url: string): Promise<{ response: Response; body: string }> {
  const response = await fetch(url);
  const body = await response.text();
  return { response, body };
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

async function startBrowserGoldenScript(scenario: string): Promise<URL> {
  const child = spawn(process.execPath, [browserGoldenScriptPath, scenario], {
    env: { ...process.env, BROWSER_GOLDEN_RESOLUTION_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  browserGoldenProcesses.push(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeout = setTimeout(() => {
      rejectWithOutput(`Timed out waiting for browser golden server URL`);
    }, 5_000);

    const rejectWithOutput = (message: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/^URL: (.+)$/m);
      if (match === null || resolved) return;

      resolved = true;
      clearTimeout(timeout);
      resolve(new URL(match[1]));
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', (code, signal) => {
      rejectWithOutput(
        `Browser golden server exited before printing a URL (code ${code ?? 'null'}, signal ${
          signal ?? 'null'
        })`,
      );
    });
  });
}

async function stopBrowserGoldenProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolveStop) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(forceKillTimer);
      resolveStop();
    };
    const forceKillTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1_000);

    child.once('exit', finish);
    if (!child.kill('SIGTERM')) {
      finish();
    }
  });
}

describe('Phase 3 browser-rendered golden contract', () => {
  it('serves production HTML that references built JS and CSS assets', async () => {
    const handle = await startGoldenServer(seedPirateRoast());
    const { response, body } = await fetchText(`${handle.url}/`);
    const assets = referencedAssetPaths(body);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('<div id="root">');
    expect(body).toContain('id="aharness-preboot"');
    expect(assets.some((asset) => asset.endsWith('.js'))).toBe(true);
    expect(assets.some((asset) => asset.endsWith('.css'))).toBe(true);
    expect(assets.every((asset) => asset.startsWith('assets/index-'))).toBe(true);
  });

  it('serves built assets with production API endpoints and no fixture import path', async () => {
    const handle = await startGoldenServer(seedPirateRoast());
    const index = await fetchText(`${handle.url}/`);
    const assets = referencedAssetPaths(index.body);
    const jsAsset = assets.find((asset) => asset.endsWith('.js'));
    const cssAsset = assets.find((asset) => asset.endsWith('.css'));

    expect(jsAsset).toBeDefined();
    expect(cssAsset).toBeDefined();

    const js = await fetchText(`${handle.url}/${jsAsset}`);
    const css = await fetchText(`${handle.url}/${cssAsset}`);

    expect(js.response.status).toBe(200);
    expect(js.response.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
    expect(js.body).toContain('/api/runs/');
    expect(js.body).toContain('bottom-run-stats');
    expect(js.body).not.toContain('/api/state');
    expect(js.body).not.toContain('/api/stream');
    expect(js.body).not.toContain('/api/reply');
    expect(js.body).not.toContain('TurnRibbon');
    expect(js.body).not.toContain('no turns completed yet');
    expect(js.body).not.toContain('fixtures/');
    expect(js.body).not.toContain('browserGoldenServer');
    expect(js.body).not.toContain('ui.browserGolden.test');

    expect(css.response.status).toBe(200);
    expect(css.response.headers.get('content-type')).toContain('text/css');
    expect(css.body).toContain('font-family');
    expect(css.body).toContain('.run-status-bar');
    expect(css.body).not.toContain('.ribbon');
  });

  it.each([
    [
      'pirate-roast',
      seedPirateRoast,
      pirateRoastState.path,
      'Arrr, your diff needs a sharper hook',
    ],
    [
      'requirement-spec',
      seedRequirementSpec,
      requirementSpecState.path,
      'Which requirement should the spec lock down next?',
    ],
  ])(
    'seeds representative %s run-scoped bootstrap and stream surfaces',
    async (_scenario, seed, expectedStatePath, expectedText) => {
      const handle = await startGoldenServer(seed());

      const stateResponse = await fetch(
        `${handle.url}/api/runs/${runMeta.runId}/bootstrap?token=${TEST_UI_TOKEN}`,
      );
      const state = await stateResponse.json();

      expect(stateResponse.status).toBe(200);
      expect(state.latestEventId).toMatch(new RegExp(`^${runMeta.runId}:\\d+$`));
      expect(state.currentState.path).toBe(expectedStatePath);
      expect(JSON.stringify(state)).toContain(expectedText);

      const streamResponse = await fetch(
        `${handle.url}/api/runs/${runMeta.runId}/stream?token=${TEST_UI_TOKEN}`,
        {
          headers: { 'Last-Event-ID': `${runMeta.runId}:1` },
        },
      );
      const streamBody = await readSseUntil(streamResponse, expectedText);

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
      expect(streamBody).toContain(expectedText);
    },
  );

  it.each([
    ['pirate-roast', 'pirate-roast.awaiting-open-composer', 'Arrr, your diff needs a sharper hook'],
    [
      'requirement-spec',
      'requirement-spec.open-owner-input',
      'Which requirement should the spec lock down next?',
    ],
  ])(
    'starts the standalone %s fixture server for real-browser Phase 3 checks',
    async (scenario, expectedStatePath, expectedText) => {
      const url = await startBrowserGoldenScript(scenario);
      const token = url.searchParams.get('token');
      const runId = url.searchParams.get('runId');

      expect(runId).toBe(`browser-golden-${scenario}`);
      expect(token).toEqual(expect.any(String));
      if (token === null || runId === null) {
        throw new Error(`Browser golden URL was missing token or runId: ${url.toString()}`);
      }

      const index = await fetchText(url.toString());
      expect(index.response.status).toBe(200);
      expect(index.body).toContain('<div id="root">');

      const bootstrapResponse = await fetch(
        `${url.origin}/api/runs/${runId}/bootstrap?token=${token}`,
      );
      const bootstrap = await bootstrapResponse.json();
      expect(bootstrapResponse.status).toBe(200);
      expect(bootstrap.currentState.path).toBe(expectedStatePath);
      expect(JSON.stringify(bootstrap)).toContain(expectedText);

      const summaryResponse = await fetch(`${url.origin}/api/runs/${runId}/summary?token=${token}`);
      const summary = await summaryResponse.json();
      expect(summaryResponse.status).toBe(200);
      expect(summary).toEqual({ completionStats: null });
    },
  );
});
