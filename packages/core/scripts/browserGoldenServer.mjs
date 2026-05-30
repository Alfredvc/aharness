#!/usr/bin/env node

import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

import { startUiServer } from '../dist/ui/server.js';
import { createUiEventLog } from '../dist/ui/sse.js';

const scenarios = new Set(['pirate-roast', 'requirement-spec']);
const scenario = process.argv[2];

if (!scenarios.has(scenario)) {
  console.error(
    'Usage: node packages/core/scripts/browserGoldenServer.mjs <pirate-roast|requirement-spec>',
  );
  process.exit(1);
}

const runMeta = {
  runId: `browser-golden-${scenario}`,
  threadId: `browser-golden-${scenario}-thread`,
  repoRoot: '/repo',
  fsmFile: `${scenario}.fsm.ts`,
  fsmHash6: '3d4c0d',
  codexPin: 'codex-test',
  startedAt: '2026-05-13T00:00:00.000Z',
};

function seedPirateRoast() {
  const eventLog = createUiEventLog({ capacity: 32, run: runMeta });
  const state = {
    path: 'pirate-roast.awaiting-open-composer',
    leaf: 'awaiting-open-composer',
    kind: 'stateful',
    exits: [{ name: 'send-roast', kind: 'submit', branchCount: 1 }],
    visitCount: 3,
  };
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: state.path,
    cause: 'boot',
    newState: state,
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
    runScoped: createRunScopedService({
      state,
      rows: [{ kind: 'message', text: 'Arrr, your diff needs a sharper hook before it sails.' }],
      pending: [],
    }),
  };
}

function seedRequirementSpec() {
  const eventLog = createUiEventLog({ capacity: 32, run: runMeta });
  const state = {
    path: 'requirement-spec.awaiting-owner-input',
    leaf: 'awaiting-owner-input',
    kind: 'stateful',
    awaitsOwnerText: { messageToUser: 'Choose the next requirement detail.' },
    exits: [{ name: 'answered', kind: 'await', branchCount: 1 }],
    visitCount: 2,
  };
  const nextState = {
    path: 'requirement-spec.reviewing-accepted-detail',
    leaf: 'reviewing-accepted-detail',
    kind: 'stateful',
    exits: [{ name: 'continue', kind: 'submit', branchCount: 1 }],
    visitCount: 1,
  };
  const pending = [
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
  ];
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: state.path,
    cause: 'boot',
    newState: state,
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
  const flatEventLog = withStreamTriggeredResolution(eventLog, () => {
    eventLog.publish({
      kind: 'OwnerInputResolved',
      id: 'requirement-owner-input',
    });
    eventLog.publish({
      kind: 'StateChange',
      from: state.path,
      to: nextState.path,
      cause: 'await',
      newState: nextState,
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'requirement-spec-resolution',
      delta: 'Owner input resolved: Acceptance criteria.',
    });
  });
  const runScoped = createRunScopedService({
    state,
    rows: [{ kind: 'message', text: 'Need owner input before finalizing the requirement spec.' }],
    pending,
    delayedResolution: {
      delayMs: flatEventLog.resolutionDelayMs,
      resolvedRequestId: 'requirement-owner-input',
      nextState,
      text: 'Owner input resolved: Acceptance criteria.',
    },
  });

  return {
    eventLog: flatEventLog,
    runScoped,
    cancelResolutionTimer() {
      flatEventLog.cancelResolutionTimer?.();
      runScoped.cancelResolutionTimer?.();
    },
    resolutionDelayMs: flatEventLog.resolutionDelayMs,
  };
}

function createRunScopedService(options) {
  const stateVisitId = `${options.state.path}#${options.state.visitCount}`;
  const time = '2026-05-13T00:00:00.000Z';
  const listeners = new Set();
  const delayed = options.delayedResolution;
  const delayMs = delayed?.delayMs ?? null;
  let timer = null;
  let delayedPublished = false;
  const events = [
    runScopedStateEvent(1, options.state, null, 'boot', stateVisitId),
    ...options.pending.map((pending, index) =>
      runScopedRequestEvent(index + 2, pending, stateVisitId),
    ),
    ...options.rows.map((row, index) =>
      runScopedRowEvent(index + 2 + options.pending.length, stateVisitId, row),
    ),
  ];

  const publishDelayedResolution = () => {
    if (delayed === undefined || delayedPublished) return;
    delayedPublished = true;
    const baseSeq = events.length;
    events.push(
      runScopedResolvedRequestEvent(baseSeq + 1, delayed.resolvedRequestId, stateVisitId),
      runScopedStateEvent(
        baseSeq + 2,
        delayed.nextState,
        options.state.path,
        'await',
        `${delayed.nextState.path}#${delayed.nextState.visitCount}`,
      ),
      runScopedRowEvent(baseSeq + 3, `${delayed.nextState.path}#${delayed.nextState.visitCount}`, {
        kind: 'message',
        text: delayed.text,
      }),
    );
    for (const listener of listeners) listener();
  };

  const scheduleDelayedResolution = () => {
    if (delayed === undefined || delayedPublished || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      publishDelayedResolution();
    }, delayMs);
  };

  const rows = () =>
    events
      .map((event) => {
        const row = event.data?.row;
        return row === undefined
          ? null
          : {
              id: `${event.id}:row`,
              eventId: event.id,
              seq: event.seq,
              time: event.time,
              type: event.type,
              stateVisitId: event.stateVisitId,
              ...row,
            };
      })
      .filter(Boolean);
  const afterSeq = (after) => {
    if (after === undefined || after === null) return 0;
    const prefix = `${runMeta.runId}:`;
    return after.startsWith(prefix) ? Number(after.slice(prefix.length)) : 0;
  };
  const currentState = () => (delayedPublished && delayed ? delayed.nextState : options.state);
  const currentStateVisit = () => {
    const state = currentState();
    return {
      id: `${state.path}#${state.visitCount}`,
      path: state.path,
      seq: 1,
      time,
      from: null,
      to: state.path,
      cause: delayedPublished ? 'await' : 'boot',
    };
  };

  return {
    runId: runMeta.runId,
    resolutionDelayMs: delayMs,
    cancelResolutionTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLatestEventId: () => events.at(-1)?.id ?? null,
    getBootstrap({ getRunMeta, topology }) {
      const state = currentState();
      const visit = currentStateVisit();
      return {
        ok: true,
        bootstrap: {
          run: getRunMeta(),
          topology: topology ?? null,
          latestEventId: events.at(-1)?.id ?? null,
          currentState: runScopedCurrentState(state),
          posture: {
            isTerminal: false,
            isAwaiting: Boolean(state.awaitsOwnerText),
            submittedThisTurn: false,
            open: !state.awaitsOwnerText,
          },
          currentStateVisit: visit,
          stateVisits: [visit],
          statePathVisits: { [visit.path]: [visit.id] },
          pending: delayedPublished ? [] : options.pending,
          aggregateStats: { turnCount: 0 },
          recentRows: rows(),
          diagnostics: [],
        },
      };
    },
    getStateVisitRows(visitId) {
      return {
        ok: true,
        rows: rows().filter((row) => row.stateVisitId === visitId),
        nextCursor: null,
      };
    },
    getRecentRows() {
      return { ok: true, rows: rows(), nextCursor: null };
    },
    getEventPage(query) {
      return {
        ok: true,
        events: events.filter((event) => event.seq > afterSeq(query?.after)),
        nextCursor: null,
        diagnostics: [],
      };
    },
    eventsAfter(after) {
      scheduleDelayedResolution();
      return {
        ok: true,
        events: events.filter((event) => event.seq > afterSeq(after)),
      };
    },
  };
}

function runScopedCurrentState(state) {
  return {
    path: state.path,
    leaf: state.leaf,
    kind: state.kind,
    visitCount: state.visitCount,
    exits: state.exits,
  };
}

function runScopedStateEvent(seq, state, from, cause, stateVisitId) {
  return {
    schema: 'aharness.event.v1',
    runId: runMeta.runId,
    seq,
    id: `${runMeta.runId}:${seq}`,
    time: '2026-05-13T00:00:00.000Z',
    type: 'state.changed',
    stateVisitId,
    data: {
      ...runScopedCurrentState(state),
      from,
      to: state.path,
      cause,
      row: {
        kind: 'state_change',
        label: state.path,
        summary: from === null ? `Entered ${state.path}` : `${from} -> ${state.path}`,
      },
    },
    offset: seq,
    lineBytes: 1,
  };
}

function runScopedRequestEvent(seq, pending, stateVisitId) {
  return {
    schema: 'aharness.event.v1',
    runId: runMeta.runId,
    seq,
    id: `${runMeta.runId}:${seq}`,
    time: '2026-05-13T00:00:00.000Z',
    type: 'request.created',
    stateVisitId,
    requestId: pending.requestId,
    data: {
      pendingCard: pending.pendingCard,
      row: { kind: 'request', status: 'pending', summary: pending.summary },
    },
    offset: seq,
    lineBytes: 1,
  };
}

function runScopedResolvedRequestEvent(seq, requestId, stateVisitId) {
  return {
    schema: 'aharness.event.v1',
    runId: runMeta.runId,
    seq,
    id: `${runMeta.runId}:${seq}`,
    time: '2026-05-13T00:00:00.000Z',
    type: 'request.resolved',
    stateVisitId,
    requestId,
    data: { requestId, status: 'resolved' },
    offset: seq,
    lineBytes: 1,
  };
}

function runScopedRowEvent(seq, stateVisitId, row) {
  return {
    schema: 'aharness.event.v1',
    runId: runMeta.runId,
    seq,
    id: `${runMeta.runId}:${seq}`,
    time: '2026-05-13T00:00:00.000Z',
    type: 'model.delta',
    stateVisitId,
    itemId: `row-${seq}`,
    data: { row },
    offset: seq,
    lineBytes: 1,
  };
}

function withStreamTriggeredResolution(eventLog, publishResolution) {
  const delayMs = readResolutionDelayMs();
  let timer = null;
  let published = false;

  return {
    publish: eventLog.publish,
    snapshot: eventLog.snapshot,
    eventsAfter(lastEventId) {
      if (timer === null && !published) {
        timer = setTimeout(() => {
          published = true;
          publishResolution();
        }, delayMs);
      }

      return eventLog.eventsAfter(lastEventId);
    },
    cancelResolutionTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    resolutionDelayMs: delayMs,
  };
}

function readResolutionDelayMs() {
  const raw = process.env.BROWSER_GOLDEN_RESOLUTION_DELAY_MS;
  if (raw === undefined) {
    return 4_000;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 4_000;
}

const fixture = scenario === 'pirate-roast' ? seedPirateRoast() : seedRequirementSpec();
const uiToken = randomBytes(18).toString('base64url');
const handle = await startUiServer({
  host: '127.0.0.1',
  port: 0,
  uiToken,
  eventLog: fixture.eventLog,
  runScoped: {
    activeRunId: runMeta.runId,
    service: fixture.runScoped,
    getRunMeta: () => runMeta,
    topology: null,
  },
});

console.log(`Phase 3 browser-rendered check: ${scenario}`);
const url = new URL(handle.url);
url.searchParams.set('token', uiToken);
url.searchParams.set('runId', runMeta.runId);
console.log(`URL: ${url.toString()}`);
if (scenario === 'pirate-roast') {
  console.log('Assert: state path pirate-roast.awaiting-open-composer');
  console.log('Assert: transcript text "Arrr, your diff needs a sharper hook"');
  console.log('Assert: open-state composer is visible');
} else {
  console.log('Assert: pending owner input question is visible');
  console.log(
    'Assert: resolved/next state requirement-spec.reviewing-accepted-detail appears after update',
  );
  console.log(
    `Resolution update: publishes after /api/runs/${runMeta.runId}/stream opens + ${fixture.resolutionDelayMs}ms`,
  );
}

async function shutdown(signal) {
  console.log(`Received ${signal}; closing browser golden server`);
  fixture.cancelResolutionTimer?.();
  await handle.close();
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
