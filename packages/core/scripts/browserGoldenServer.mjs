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
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: 'pirate-roast.awaiting-open-composer',
    cause: 'boot',
    newState: {
      path: 'pirate-roast.awaiting-open-composer',
      leaf: 'awaiting-open-composer',
      kind: 'stateful',
      exits: [{ name: 'send-roast', kind: 'submit', branchCount: 1 }],
      visitCount: 3,
    },
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

function seedRequirementSpec() {
  const eventLog = createUiEventLog({ capacity: 32, run: runMeta });
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: 'requirement-spec.awaiting-owner-input',
    cause: 'boot',
    newState: {
      path: 'requirement-spec.awaiting-owner-input',
      leaf: 'awaiting-owner-input',
      kind: 'stateful',
      awaitsOwnerText: { messageToUser: 'Choose the next requirement detail.' },
      exits: [{ name: 'answered', kind: 'await', branchCount: 1 }],
      visitCount: 2,
    },
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

  return withStreamTriggeredResolution(eventLog, () => {
    eventLog.publish({
      kind: 'OwnerInputResolved',
      id: 'requirement-owner-input',
    });
    eventLog.publish({
      kind: 'StateChange',
      from: 'requirement-spec.awaiting-owner-input',
      to: 'requirement-spec.reviewing-accepted-detail',
      cause: 'await',
      newState: {
        path: 'requirement-spec.reviewing-accepted-detail',
        leaf: 'reviewing-accepted-detail',
        kind: 'stateful',
        exits: [{ name: 'continue', kind: 'submit', branchCount: 1 }],
        visitCount: 1,
      },
    });
    eventLog.publish({
      kind: 'AgentMessageDelta',
      id: 'requirement-spec-resolution',
      delta: 'Owner input resolved: Acceptance criteria.',
    });
  });
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

const eventLog = scenario === 'pirate-roast' ? seedPirateRoast() : seedRequirementSpec();
const uiToken = randomBytes(18).toString('base64url');
const handle = await startUiServer({
  host: '127.0.0.1',
  port: 0,
  uiToken,
  eventLog,
});

console.log(`Phase 3 browser-rendered check: ${scenario}`);
const url = new URL(handle.url);
url.searchParams.set('token', uiToken);
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
    `Resolution update: publishes after /api/stream opens + ${eventLog.resolutionDelayMs}ms`,
  );
}

async function shutdown(signal) {
  console.log(`Received ${signal}; closing browser golden server`);
  eventLog.cancelResolutionTimer?.();
  await handle.close();
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
