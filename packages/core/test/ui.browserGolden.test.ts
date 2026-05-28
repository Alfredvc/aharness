import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FsmState, RunMeta } from '../src/ui/events.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';
import { createUiEventLog, type UiEventLog } from '../src/ui/sse.js';

const handles: UiServerHandle[] = [];
const TEST_UI_TOKEN = 'browser-golden-token';

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
  path: 'requirement-spec.awaiting-owner-input',
  leaf: 'awaiting-owner-input',
  kind: 'stateful',
  awaitsOwnerText: { messageToUser: 'Choose the next requirement detail.' },
  exits: [{ name: 'answered', kind: 'await', branchCount: 1 }],
  visitCount: 2,
};

afterEach(async () => {
  const openHandles = handles.splice(0);
  await Promise.all(openHandles.map((handle) => handle.close()));
});

async function startGoldenServer(eventLog: UiEventLog): Promise<UiServerHandle> {
  const handle = await startUiServer({
    host: '127.0.0.1',
    port: 0,
    uiToken: TEST_UI_TOKEN,
    eventLog,
  });
  handles.push(handle);
  return handle;
}

function seedPirateRoast(): UiEventLog {
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
  return eventLog;
}

function seedRequirementSpec(): UiEventLog {
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
  return eventLog;
}

function referencedAssetPaths(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((match) => match[1] ?? '');
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

describe('Phase 3 browser-rendered golden contract', () => {
  it('serves production HTML that references built JS and CSS assets', async () => {
    const handle = await startGoldenServer(seedPirateRoast());
    const { response, body } = await fetchText(`${handle.url}/`);
    const assets = referencedAssetPaths(body);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('<div id="root">');
    expect(body).toContain('id="harness-preboot"');
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
    expect(js.body).toContain('/api/state');
    expect(js.body).toContain('/api/stream');
    expect(js.body).toContain('/api/reply');
    expect(js.body).not.toContain('fixtures/');
    expect(js.body).not.toContain('browserGoldenServer');
    expect(js.body).not.toContain('ui.browserGolden.test');

    expect(css.response.status).toBe(200);
    expect(css.response.headers.get('content-type')).toContain('text/css');
    expect(css.body).toContain('font-family');
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
    'seeds representative %s /api/state and /api/stream surfaces',
    async (_scenario, seed, expectedStatePath, expectedText) => {
      const handle = await startGoldenServer(seed());

      const stateResponse = await fetch(`${handle.url}/api/state?token=${TEST_UI_TOKEN}`);
      const state = await stateResponse.json();

      expect(stateResponse.status).toBe(200);
      expect(state.latestEventId).toMatch(/^[1-9]\d*$/);
      expect(state.state.currentState.path).toBe(expectedStatePath);
      expect(JSON.stringify(state)).toContain(expectedText);

      const streamResponse = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`, {
        headers: { 'Last-Event-ID': '1' },
      });
      const streamBody = await readSseUntil(streamResponse, expectedText);

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
      expect(streamBody).toContain(expectedText);
    },
  );

  it('keeps the fixture server script available for real-browser Phase 3 checks', () => {
    const scriptPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../scripts/browserGoldenServer.mjs',
    );
    const script = readFileSync(scriptPath, 'utf8');

    expect(scriptPath).toMatch(/packages\/core\/scripts\/browserGoldenServer\.mjs$/);
    expect(script).toContain("import { startUiServer } from '../dist/ui/server.js'");
    expect(script).toContain("import { createUiEventLog } from '../dist/ui/sse.js'");
    expect(script).toContain('pirate-roast');
    expect(script).toContain('requirement-spec');
  });
});
