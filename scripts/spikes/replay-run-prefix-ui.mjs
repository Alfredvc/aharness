#!/usr/bin/env node
// Dev/test-only replay harness for visualizing the first N canonical run events
// through the normal run-scoped SSE reducer path. This is intentionally a spike
// script, not an aharness production CLI command.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRunCompletionStats,
  replayRunEvents,
} from '../../packages/core/dist/runEvents/index.js';
import { startUiServer } from '../../packages/core/dist/ui/server.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;

export function resolveReplayEventsPath(inputPath) {
  const absolute = resolve(inputPath);
  const stat = statSync(absolute);
  return stat.isDirectory() ? join(absolute, 'events.jsonl') : absolute;
}

export function readFirstNonEmptyCanonicalRunId(eventsPath) {
  for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && typeof parsed.runId === 'string') {
      return parsed.runId;
    }
    break;
  }
  return null;
}

export function urlWithReplayBootParams(url, params) {
  const parsed = new URL(url);
  parsed.searchParams.set('token', params.token);
  parsed.searchParams.set('runId', params.runId);
  return parsed.toString();
}

export function createReplayRunPrefixRouteService(options) {
  const eventsPath = resolveReplayEventsPath(options.inputPath);
  const eventCount = normalizeEventCount(options.eventCount);
  const runId = options.runId ?? readFirstNonEmptyCanonicalRunId(eventsPath);
  if (runId === null) {
    throw new Error('could not infer runId from events.jsonl; pass --run-id for an empty prefix');
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'aharness-replay-prefix-'));
  const prefixPath = join(tempRoot, 'events.jsonl');
  writeFileSync(prefixPath, firstNonEmptyLines(eventsPath, eventCount).join('') ?? '');

  const replay = replayRunEvents({ runId, eventsPath: prefixPath });
  const events = replay.events;
  const diagnostics = replay.diagnostics;
  const available = replay.ok;
  const bootstrapSeed = bootstrapSeedFromEvents(events);

  const service = {
    runId,
    subscribe: () => () => undefined,
    getLatestEventId: () => events.at(-1)?.event.id ?? null,
    getBootstrap: ({ getRunMeta, topology }) => {
      if (!available) return unavailable(diagnostics);
      return {
        ok: true,
        bootstrap: {
          run: getRunMeta(),
          topology: topology ?? null,
          latestEventId: null,
          currentState: bootstrapSeed.currentState,
          posture: {
            isTerminal: false,
            isAwaiting: false,
            submittedThisTurn: false,
            open: false,
          },
          currentStateVisit: bootstrapSeed.currentStateVisit,
          stateVisits: bootstrapSeed.stateVisits,
          statePathVisits: bootstrapSeed.statePathVisits,
          pending: [],
          aggregateStats: { turnCount: 0 },
          completionStats: buildReplayCompletionStats({ events, getRunMeta, topology }),
          recentRows: [],
          diagnostics,
        },
      };
    },
    getCompletionStats: ({ getRunMeta, topology }) => {
      if (!available) return unavailable(diagnostics);
      return {
        ok: true,
        completionStats: buildReplayCompletionStats({ events, getRunMeta, topology }),
      };
    },
    getStateVisitRows: () => ({ ok: true, rows: [], nextCursor: null }),
    getRecentRows: () => ({ ok: true, rows: [], nextCursor: null }),
    getEventPage: (query = {}) => {
      if (!available) return unavailable(diagnostics);
      const parsed = parseEventCursor(runId, query.after);
      if (!parsed.ok) return { ok: false, error: 'invalid-event-cursor' };
      const latestSeq = events.at(-1)?.event.seq ?? 0;
      if (parsed.seq > latestSeq) {
        return {
          ok: false,
          error: 'event-cursor-out-of-range',
          latestEventId: events.at(-1)?.event.id ?? null,
        };
      }
      const page = pageEvents(events, parsed.seq, query.limit);
      return {
        ok: true,
        events: page.events.map(apiSafeEvent),
        nextCursor: page.nextCursor,
        diagnostics,
      };
    },
    eventsAfter: (afterEventId = null, drainOptions = {}) => {
      const drained = [];
      let cursor = afterEventId;
      for (;;) {
        const page = service.getEventPage({
          after: cursor,
          ...(drainOptions.pageLimit === undefined ? {} : { limit: drainOptions.pageLimit }),
        });
        if (!page.ok) return page;
        drained.push(...page.events);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return { ok: true, events: drained };
    },
  };

  return {
    runId,
    eventsPath,
    prefixPath,
    eventCount,
    service,
    diagnostics,
    dispose: () => {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function startReplayRunPrefixUi(options) {
  const replay = createReplayRunPrefixRouteService(options);
  const token = options.token ?? randomBytes(18).toString('base64url');
  const runMeta = {
    runId: replay.runId,
    threadId: '',
    repoRoot: process.cwd(),
    fsmFile: options.fsm ?? '',
    fsmHash6: '',
    codexPin: 'not started',
    startedAt: new Date().toISOString(),
  };
  const topology = options.topology ?? null;

  let handle;
  try {
    handle = await startUiServer({
      host: options.host ?? DEFAULT_HOST,
      port: options.port ?? DEFAULT_PORT,
      uiToken: token,
      runScoped: {
        activeRunId: replay.runId,
        service: replay.service,
        getRunMeta: () => runMeta,
        ...(topology === null ? {} : { topology }),
      },
    });
  } catch (error) {
    replay.dispose();
    throw error;
  }

  return {
    ...replay,
    token,
    server: handle,
    url: urlWithReplayBootParams(handle.url, { token, runId: replay.runId }),
    close: async () => {
      await handle.close();
      replay.dispose();
    },
  };
}

function firstNonEmptyLines(eventsPath, count) {
  if (count === 0) return [];
  const lines = [];
  for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    lines.push(`${line}\n`);
    if (lines.length === count) break;
  }
  return lines;
}

function bootstrapSeedFromEvents(events) {
  const firstStateEntry = events.find((entry) => entry.event.type === 'state.changed');
  if (firstStateEntry === undefined) {
    return {
      currentState: null,
      currentStateVisit: null,
      stateVisits: [],
      statePathVisits: {},
    };
  }

  const currentStateVisit = stateVisitFromEvent(firstStateEntry.event);
  const stateVisits = currentStateVisit === null ? [] : [currentStateVisit];
  return {
    currentState: currentStateFromEvent(firstStateEntry.event),
    currentStateVisit,
    stateVisits,
    statePathVisits: statePathVisits(stateVisits),
  };
}

function stateVisitFromEvent(event) {
  if (!isRecord(event.data)) return null;
  const path = readString(event.data.path) ?? readString(event.data.to) ?? event.stateVisitId;
  const to = readString(event.data.to) ?? path;
  if (path === undefined || to === undefined) return null;

  const from = readNullableString(event.data.from);
  const cause = readString(event.data.cause);
  return {
    id: event.stateVisitId ?? readString(event.data.stateVisitId) ?? `${path}#${event.seq}`,
    path,
    seq: event.seq,
    time: event.time,
    to,
    ...(from !== undefined ? { from } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
}

function currentStateFromEvent(event) {
  if (!isRecord(event.data)) return null;
  const path = readString(event.data.path);
  if (path === undefined) return null;

  const leaf = readString(event.data.leaf);
  const kind = readString(event.data.kind);
  const visitCount = readNumber(event.data.visitCount);
  const exits = Array.isArray(event.data.exits)
    ? event.data.exits.map((exit) => currentStateExit(exit)).filter((exit) => exit !== null)
    : undefined;

  return {
    path,
    ...(leaf !== undefined ? { leaf } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(visitCount !== undefined ? { visitCount } : {}),
    ...(exits !== undefined ? { exits } : {}),
  };
}

function currentStateExit(value) {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  const kind = readString(value.kind);
  if (name === undefined || kind === undefined) return null;
  const branchCount = readNumber(value.branchCount);
  return {
    name,
    kind,
    ...(branchCount !== undefined ? { branchCount } : {}),
  };
}

function statePathVisits(visits) {
  const byPath = {};
  for (const visit of visits) {
    byPath[visit.path] ??= [];
    byPath[visit.path].push(visit.id);
  }
  return byPath;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNullableString(value) {
  if (value === null) return null;
  return readString(value);
}

function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeEventCount(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('event-count must be a non-negative integer');
  }
  return parsed;
}

function unavailable(diagnostics) {
  return { ok: false, error: 'run-event-log-unavailable', diagnostics };
}

function buildReplayCompletionStats({ events, getRunMeta, topology }) {
  return buildRunCompletionStats({
    events,
    getRunMeta,
    topology: isRecord(topology) ? topology : null,
  });
}

function parseEventCursor(runId, after) {
  if (after === undefined || after === null) return { ok: true, seq: 0 };
  const prefix = `${runId}:`;
  if (!after.startsWith(prefix)) return { ok: false };
  const seqText = after.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(seqText)) return { ok: false };
  const seq = Number(seqText);
  return Number.isSafeInteger(seq) ? { ok: true, seq } : { ok: false };
}

function normalizeLimit(limit) {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 1_000);
}

function pageEvents(events, afterSeq, limit) {
  const candidates = events.filter((entry) => entry.event.seq > afterSeq);
  const page = candidates.slice(0, normalizeLimit(limit));
  const last = page.at(-1);
  return {
    events: page,
    nextCursor: last !== undefined && candidates.length > page.length ? last.event.id : null,
  };
}

function apiSafeEvent(entry) {
  const event = entry.event;
  return {
    schema: event.schema,
    runId: event.runId,
    seq: event.seq,
    id: event.id,
    time: event.time,
    type: event.type,
    ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.stateVisitId !== undefined ? { stateVisitId: event.stateVisitId } : {}),
    ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
    ...(event.meta !== undefined ? { meta: event.meta } : {}),
    offset: entry.offset,
    lineBytes: entry.lineBytes,
  };
}

function parseArgs(argv) {
  const [inputPath, eventCountText, ...rest] = argv;
  if (inputPath === undefined || eventCountText === undefined) return null;

  const options = {
    inputPath,
    eventCount: normalizeEventCount(eventCountText),
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === '--host' && value !== undefined) {
      options.host = value;
      i += 1;
    } else if (arg === '--port' && value !== undefined) {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error('--port must be an integer between 0 and 65535');
      }
      options.port = port;
      i += 1;
    } else if (arg === '--run-id' && value !== undefined) {
      options.runId = value;
      i += 1;
    } else if (arg === '--fsm' && value !== undefined) {
      options.fsm = value;
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg ?? ''}`);
    }
  }

  return options;
}

function usage() {
  return [
    'usage: node scripts/spikes/replay-run-prefix-ui.mjs <events.jsonl|run-dir> <event-count> [--host <host>] [--port <port>] [--run-id <run-id>] [--fsm <path>]',
    '',
    'Starts a dev/test-only UI server and immediately drains the first N canonical events through run-scoped SSE.',
  ].join('\n');
}

function waitForSignal() {
  return new Promise((resolve) => {
    const cleanup = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    const onSigint = () => {
      cleanup();
      resolve(130);
    };
    const onSigterm = () => {
      cleanup();
      resolve(143);
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const replay = await startReplayRunPrefixUi(options);
  process.stdout.write(`aharness replay prefix UI available at ${replay.url}\n`);
  process.stdout.write(
    `serving ${replay.service.getLatestEventId() === null ? 0 : replay.eventCount} requested event(s) from ${basename(replay.eventsPath)}\n`,
  );
  const exitCode = await waitForSignal();
  await replay.close();
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
