import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createReplayRunPrefixRouteService,
  startReplayRunPrefixUi,
  urlWithReplayBootParams,
} from './replay-run-prefix-ui.mjs';

const RUN_ID = 'replay-run';

const tempRoots = [];
const handles = [];

const OBJECT_CONTAINING = Symbol('objectContaining');

function expect(actual) {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assertMatch(actual, expected),
    toContain: (expected) => assert.ok(actual.includes(expected)),
    toContainEqual: (expected) => assert.ok(actual.some((item) => matchesExpected(item, expected))),
    toHaveLength: (expected) => assert.strictEqual(actual.length, expected),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toMatch: (expected) => assert.match(actual, expected),
    toHaveProperty: (property) => assert.ok(Object.hasOwn(actual, property)),
    not: {
      toContain: (expected) => assert.ok(!actual.includes(expected)),
      toHaveProperty: (property) => assert.ok(!Object.hasOwn(actual, property)),
    },
  };
}

expect.objectContaining = (shape) => ({ [OBJECT_CONTAINING]: true, shape });

function assertMatch(actual, expected) {
  const mismatch = explainMismatch(actual, expected);
  if (mismatch !== null) {
    assert.fail(mismatch);
  }
}

function matchesExpected(actual, expected) {
  return explainMismatch(actual, expected) === null;
}

function explainMismatch(actual, expected, path = 'value') {
  if (isObjectContaining(expected)) {
    if (!isRecord(actual)) return `${path} expected an object`;
    for (const [key, value] of Object.entries(expected.shape)) {
      const mismatch = explainMismatch(actual[key], value, `${path}.${key}`);
      if (mismatch !== null) return mismatch;
    }
    return null;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path} expected an array`;
    if (actual.length !== expected.length) {
      return `${path} expected length ${expected.length}, received ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = explainMismatch(actual[index], expected[index], `${path}[${index}]`);
      if (mismatch !== null) return mismatch;
    }
    return null;
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return `${path} expected a plain object`;
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    try {
      assert.deepStrictEqual(actualKeys, expectedKeys);
    } catch {
      return `${path} expected keys ${expectedKeys.join(',')}, received ${actualKeys.join(',')}`;
    }
    for (const key of expectedKeys) {
      const mismatch = explainMismatch(actual[key], expected[key], `${path}.${key}`);
      if (mismatch !== null) return mismatch;
    }
    return null;
  }

  try {
    assert.deepStrictEqual(actual, expected);
    return null;
  } catch (error) {
    return error instanceof Error ? `${path}: ${error.message}` : `${path} mismatch`;
  }
}

function isObjectContaining(value) {
  return isRecord(value) && value[OBJECT_CONTAINING] === true;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

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

function terminalFixtureEvents() {
  return [
    event(1, 'run.started', { data: { startedAt: '2026-05-31T00:00:01.000Z' } }),
    event(2, 'state.changed', {
      stateVisitId: 'root.plan#1',
      data: {
        path: 'root.plan',
        to: 'root.plan',
        leaf: 'plan',
        kind: 'stateful',
        stateVisitId: 'root.plan#1',
      },
      raw: { ownerInput: 'raw owner input must not leak from replay summary' },
    }),
    event(3, 'git.diff.recorded', {
      data: {
        status: 'available',
        from: 'from-object-id',
        to: 'to-object-id',
        filesChanged: 2,
        linesAdded: 5,
        linesDeleted: 1,
      },
    }),
    event(4, 'run.completed', { data: { endedAt: '2026-05-31T00:00:04.000Z' } }),
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

function currentContractFixtureEvents() {
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
      },
    }),
    event(3, 'framework.note', {
      stateVisitId: 'root.plan#1',
      data: {
        row: {
          id: 'framework-orientation',
          kind: 'framework_note',
          status: 'orientation',
          text: 'You have entered `root.plan`.',
        },
      },
    }),
    event(4, 'item.started', {
      stateVisitId: 'root.plan#1',
      itemId: 'orientation-message',
      data: {
        row: {
          id: 'orientation-envelope',
          kind: 'message',
          label: 'userMessage',
          itemId: 'orientation-message',
          text: '[aharness] Now in state "root.plan".',
        },
      },
    }),
    event(5, 'item.started', {
      stateVisitId: 'root.plan#1',
      itemId: 'assistant-message-1',
      data: {
        row: {
          id: 'assistant-start-envelope',
          kind: 'message',
          label: 'agentMessage',
          itemId: 'assistant-message-1',
        },
      },
    }),
    event(6, 'model.delta', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: { delta: 'Draft answer' },
    }),
    event(7, 'model.delta', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: { delta: ' in flight' },
    }),
    event(8, 'item.completed', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      data: {
        row: {
          id: 'assistant-completed-row',
          kind: 'message',
          label: 'agentMessage',
          itemId: 'assistant-message-1',
          text: 'Final assistant answer.',
        },
      },
    }),
    event(9, 'item.started', {
      stateVisitId: 'root.plan#1',
      itemId: 'reasoning-1',
      data: {
        row: {
          id: 'empty-reasoning-envelope',
          kind: 'reasoning',
          label: 'reasoning',
          itemId: 'reasoning-1',
        },
      },
    }),
    event(10, 'item.completed', {
      stateVisitId: 'root.plan#1',
      turnId: 'turn-1',
      itemId: 'command-1',
      raw: { hidden: 'not-api-safe' },
      data: {
        row: {
          id: 'command-row',
          kind: 'tool',
          label: 'bash',
          itemId: 'command-1',
          status: 'completed',
          summary: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
          elapsedMs: 1234,
          output: 'line 1\nline 2\nline 3',
          data: {
            displayKind: 'command',
            command: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
          },
        },
      },
    }),
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

function makeTerminalFixtureLog() {
  const root = tempRoot();
  const eventsPath = join(root, 'events.jsonl');
  writeEventsJsonl(eventsPath, terminalFixtureEvents());
  return eventsPath;
}

function makeContextFixtureLog() {
  const root = tempRoot();
  const eventsPath = join(root, 'events.jsonl');
  writeEventsJsonl(eventsPath, contextFixtureEvents());
  return eventsPath;
}

function makeCurrentContractFixtureLog() {
  const root = tempRoot();
  const eventsPath = join(root, 'events.jsonl');
  writeEventsJsonl(eventsPath, currentContractFixtureEvents());
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
    expect(bootstrap.completionStats).toBeNull();
    expect(bootstrap.recentRows).toEqual([]);

    const summaryResponse = await fetch(`${replay.server.url}/api/runs/${RUN_ID}/summary`, {
      headers: { 'X-Aharness-Ui-Token': 'test-token' },
    });
    expect(summaryResponse.status).toBe(200);
    expect(await summaryResponse.json()).toEqual({ completionStats: null });
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
      expect(bootstrap.bootstrap.completionStats).toBeNull();
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

  it('serves terminal replay-prefix completion stats through bootstrap and summary', async () => {
    const eventsPath = makeTerminalFixtureLog();
    const replay = await startReplayRunPrefixUi({
      inputPath: eventsPath,
      eventCount: 4,
      token: 'test-token',
      fsm: '/secret/replay-demo.fsm.ts',
    });
    handles.push(replay);

    const bootstrapResponse = await fetch(`${replay.server.url}/api/runs/${RUN_ID}/bootstrap`, {
      headers: { 'X-Aharness-Ui-Token': 'test-token' },
    });
    const bootstrap = await bootstrapResponse.json();
    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrap.completionStats).toEqual(
      expect.objectContaining({
        outcome: 'success',
        fsmDisplayName: 'replay-demo.fsm',
        workDelta: {
          status: 'available',
          filesChanged: 2,
          linesAdded: 5,
          linesDeleted: 1,
        },
      }),
    );

    const summaryResponse = await fetch(`${replay.server.url}/api/runs/${RUN_ID}/summary`, {
      headers: { 'X-Aharness-Ui-Token': 'test-token' },
    });
    const summary = await summaryResponse.json();
    expect(summaryResponse.status).toBe(200);
    expect(summary).toEqual({ completionStats: bootstrap.completionStats });
    expect(JSON.stringify(summary)).not.toContain('/secret');
    expect(JSON.stringify(summary)).not.toContain('from-object-id');
    expect(JSON.stringify(summary)).not.toContain('to-object-id');
    expect(JSON.stringify(summary)).not.toContain('raw owner input must not leak');
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

  it('serves current compact contract replay events without raw payloads or row backfill', () => {
    const eventsPath = makeCurrentContractFixtureLog();
    const replay = createReplayRunPrefixRouteService({ inputPath: eventsPath, eventCount: 10 });
    tempRoots.push(resolve(replay.prefixPath, '..'));
    try {
      const drained = replay.service.eventsAfter(null);
      expect(drained.ok).toBe(true);
      expect(drained.events).toHaveLength(10);
      expect(JSON.stringify(drained.events)).not.toContain('"raw"');
      expect(drained.events).toContainEqual(
        expect.objectContaining({
          id: `${RUN_ID}:4`,
          type: 'item.started',
          data: {
            row: expect.objectContaining({
              kind: 'message',
              label: 'userMessage',
              text: '[aharness] Now in state "root.plan".',
            }),
          },
        }),
      );
      expect(drained.events).toContainEqual(
        expect.objectContaining({
          id: `${RUN_ID}:10`,
          type: 'item.completed',
          data: {
            row: expect.objectContaining({
              kind: 'tool',
              label: 'bash',
              status: 'completed',
              elapsedMs: 1234,
              output: 'line 1\nline 2\nline 3',
              data: expect.objectContaining({
                displayKind: 'command',
                command: 'pnpm exec vitest run packages/web-ui/src/state/store.test.ts',
              }),
            }),
          },
        }),
      );
    } finally {
      replay.dispose();
    }
  });

  it('does not add a public production CLI dispatch or package bin entry', () => {
    const rootPackageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(rootPackageJson.scripts.replay).toBe('node scripts/spikes/replay-run-prefix-ui.mjs');

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
