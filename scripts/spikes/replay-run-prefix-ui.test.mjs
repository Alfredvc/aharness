import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createReplayRunPrefixRouteService,
  startReplayRunPrefixUi,
  urlWithReplayBootParams,
} from './replay-run-prefix-ui.mjs';

const RUN_ID = 'replay-run';

const tempRoots = [];
const handles = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    await handle.close();
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'aharness-replay-prefix-test-'));
  tempRoots.push(root);
  return root;
}

function event(seq, type, overrides = {}) {
  return {
    schema: 'aharness.event.v1',
    runId: RUN_ID,
    seq,
    id: `${RUN_ID}:${seq}`,
    time: `2026-05-31T00:00:0${seq}.000Z`,
    type,
    ...overrides,
  };
}

function fixtureEvents() {
  return [
    event(1, 'run.started', { data: { startedAt: '2026-05-31T00:00:01.000Z' } }),
    event(2, 'state.changed', {
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
        exits: [{ name: 'done', kind: 'submit' }],
        row: {
          kind: 'state_change',
          label: 'root.plan',
          status: 'boot',
          summary: 'Entered root.plan',
        },
      },
    }),
    event(3, 'model.delta', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: { delta: 'Hello through reducer path' },
    }),
    event(4, 'model.delta', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: { delta: ' beyond prefix' },
    }),
  ];
}

function contextFixtureEvents() {
  return [
    event(1, 'run.started', { data: { startedAt: '2026-05-31T00:00:01.000Z' } }),
    event(2, 'state.changed', {
      stateVisitId: 'root.plan#1',
      data: {
        path: 'root.plan',
        leaf: 'plan',
        kind: 'stateful',
        visitCount: 1,
        exits: [{ name: 'done', kind: 'submit' }],
      },
    }),
    event(3, 'context.initialized', { data: { context: { draft: 'boot' } } }),
    event(4, 'context.changed', { data: { context: { draft: 'latest' } } }),
  ];
}

function writeEventsJsonl(eventsPath, events) {
  writeFileSync(
    eventsPath,
    `${JSON.stringify(events[0])}\n\n${events
      .slice(1)
      .map((runEvent) => JSON.stringify(runEvent))
      .join('\n')}\n`,
  );
}

function makeFixtureLog() {
  const root = tempRoot();
  const eventsPath = join(root, 'events.jsonl');
  writeEventsJsonl(eventsPath, fixtureEvents());
  return eventsPath;
}

function makeContextFixtureLog() {
  const root = tempRoot();
  const eventsPath = join(root, 'events.jsonl');
  writeEventsJsonl(eventsPath, contextFixtureEvents());
  return eventsPath;
}

async function readSseEvents(response, expectedCount) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (let i = 0; i < 12; i += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (parseSseEvents(text).length >= expectedCount) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return parseSseEvents(text);
}

function parseSseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return data.length === 0 ? null : JSON.parse(data);
    })
    .filter((event) => event !== null);
}

describe('replay-run-prefix-ui spike helper', () => {
  it('boots with latestEventId null, first state seeded, and inspect mode unset', async () => {
    const eventsPath = makeFixtureLog();
    const replay = await startReplayRunPrefixUi({
      inputPath: eventsPath,
      eventCount: 3,
      token: 'test-token',
    });
    handles.push(replay);

    const bootUrl = new URL(replay.url);
    expect(bootUrl.searchParams.get('runId')).toBe(RUN_ID);
    expect(bootUrl.searchParams.get('token')).toBe('test-token');
    expect(bootUrl.searchParams.has('mode')).toBe(false);

    const response = await fetch(`${replay.server.url}/api/runs/${RUN_ID}/bootstrap`, {
      headers: { 'X-Aharness-Ui-Token': 'test-token' },
    });
    const bootstrap = await response.json();
    expect(response.status).toBe(200);
    expect(bootstrap.latestEventId).toBeNull();
    expect(bootstrap.mode).toBeUndefined();
    expect(bootstrap.currentState).toEqual({
      path: 'root.plan',
      leaf: 'plan',
      kind: 'stateful',
      visitCount: 1,
      exits: [{ name: 'done', kind: 'submit' }],
    });
    expect(bootstrap.currentStateVisit).toEqual({
      id: 'root.plan#1',
      path: 'root.plan',
      seq: 2,
      time: '2026-05-31T00:00:02.000Z',
      from: null,
      to: 'root.plan',
      cause: 'boot',
    });
    expect(bootstrap.stateVisits).toEqual([bootstrap.currentStateVisit]);
    expect(bootstrap.statePathVisits).toEqual({ 'root.plan': ['root.plan#1'] });
    expect(bootstrap.recentRows).toEqual([]);
  });

  it('drains exactly the first N canonical events immediately through run-scoped SSE', async () => {
    const eventsPath = makeFixtureLog();
    const replay = await startReplayRunPrefixUi({
      inputPath: eventsPath,
      eventCount: 3,
      token: 'test-token',
    });
    handles.push(replay);

    const response = await fetch(`${replay.server.url}/api/runs/${RUN_ID}/stream?token=test-token`);
    expect(response.status).toBe(200);
    const events = await readSseEvents(response, 3);

    expect(events.map((runEvent) => runEvent.id)).toEqual([
      `${RUN_ID}:1`,
      `${RUN_ID}:2`,
      `${RUN_ID}:3`,
    ]);
    expect(events.map((runEvent) => runEvent.type)).toEqual([
      'run.started',
      'state.changed',
      'model.delta',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: `${RUN_ID}:3`,
        type: 'model.delta',
        itemId: 'assistant-message-1',
        data: { delta: 'Hello through reducer path' },
      }),
    );
    expect(events.map((runEvent) => runEvent.id)).not.toContain(`${RUN_ID}:4`);
  });

  it('pages the same prefix through the service without synthetic transcript state', () => {
    const eventsPath = makeFixtureLog();
    const replay = createReplayRunPrefixRouteService({ inputPath: eventsPath, eventCount: 3 });
    tempRoots.push(resolve(replay.prefixPath, '..'));
    try {
      const bootstrap = replay.service.getBootstrap({
        getRunMeta: () => ({ runId: RUN_ID }),
      });
      expect(bootstrap.ok).toBe(true);
      expect(bootstrap.bootstrap.latestEventId).toBeNull();
      expect(bootstrap.bootstrap.currentState).toEqual(
        expect.objectContaining({ path: 'root.plan' }),
      );
      expect(bootstrap.bootstrap.currentStateVisit).toEqual(
        expect.objectContaining({ id: 'root.plan#1' }),
      );
      expect(bootstrap.bootstrap.recentRows).toEqual([]);

      const drained = replay.service.eventsAfter(null);
      expect(drained.ok).toBe(true);
      expect(drained.events.map((runEvent) => runEvent.id)).toEqual([
        `${RUN_ID}:1`,
        `${RUN_ID}:2`,
        `${RUN_ID}:3`,
      ]);

      const afterFirst = replay.service.eventsAfter(`${RUN_ID}:1`);
      expect(afterFirst.ok).toBe(true);
      expect(afterFirst.events.map((runEvent) => runEvent.id)).toEqual([
        `${RUN_ID}:2`,
        `${RUN_ID}:3`,
      ]);
    } finally {
      replay.dispose();
    }
  });

  it('replays context events without attaching later snapshots to the bootstrap state seed', () => {
    const eventsPath = makeContextFixtureLog();
    const replay = createReplayRunPrefixRouteService({ inputPath: eventsPath, eventCount: 4 });
    tempRoots.push(resolve(replay.prefixPath, '..'));
    try {
      const result = replay.service.getBootstrap({
        getRunMeta: () => ({ runId: RUN_ID }),
      });
      expect(result.ok).toBe(true);
      const { bootstrap } = result;
      expect(bootstrap.currentState).toEqual({
        path: 'root.plan',
        leaf: 'plan',
        kind: 'stateful',
        visitCount: 1,
        exits: [{ name: 'done', kind: 'submit' }],
      });
      expect(bootstrap.currentState).not.toHaveProperty('context');

      const drained = replay.service.eventsAfter(null);
      expect(drained.ok).toBe(true);
      expect(drained.events.map((runEvent) => runEvent.type)).toEqual([
        'run.started',
        'state.changed',
        'context.initialized',
        'context.changed',
      ]);
      expect(drained.events.at(-1).data).toEqual({ context: { draft: 'latest' } });
    } finally {
      replay.dispose();
    }
  });

  it('does not add a public production CLI dispatch or package bin entry', () => {
    const packageJson = JSON.parse(readFileSync('packages/core/package.json', 'utf8'));
    expect(packageJson.bin).toEqual({ aharness: './dist/cli/main.js' });

    const cliMain = readFileSync('packages/core/src/cli/main.ts', 'utf8');
    expect(cliMain).not.toContain('replay-run-prefix-ui');
    expect(cliMain).not.toContain('replay-prefix');

    const url = urlWithReplayBootParams('http://127.0.0.1:0/', {
      token: 'token',
      runId: RUN_ID,
    });
    expect(new URL(url).searchParams.has('mode')).toBe(false);
  });
});
