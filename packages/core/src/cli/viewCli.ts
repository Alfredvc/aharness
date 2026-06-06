/**
 * `aharness view [run-id]` — open a recorded run log in a foreground,
 * read-only browser session.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { loadFsm } from '../loader/index.js';
import {
  createRunEventQueryService,
  replayRunEvents,
  RUN_EVENT_SCHEMA,
  type RunEventEnvelope,
  type RunEventQueryService,
} from '../runEvents/index.js';
import { launchBrowser } from '../ui/browserLauncher.js';
import type { RunMeta, Topology } from '../ui/events.js';
import { startUiServer, type UiRunScopedRouteService, type UiServerHandle } from '../ui/server.js';
import { extractUiTopology } from '../ui/topology.js';

export interface RunViewCliOpts {
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly runId?: string;
}

export interface RunViewCliResult {
  readonly exitCode: number;
}

export interface RunViewCliTestHooks {
  readonly startUiServerImpl?: typeof startUiServer;
  readonly launchBrowserImpl?: typeof launchBrowser;
  readonly waitForExit?: () => Promise<{ readonly exitCode?: number } | null>;
}

export type RunViewCliForTestOpts = RunViewCliOpts & RunViewCliTestHooks;

interface SelectedRecordedRun {
  readonly eventsPath: string;
}

type ViewFailureResult = {
  readonly ok: false;
  readonly message: string;
  readonly exitCode?: number;
};
type SelectionResult =
  | { readonly ok: true; readonly selected: SelectedRecordedRun }
  | ViewFailureResult;
type RunsRootResult = { readonly ok: true } | ViewFailureResult;

const EVENTS_FILE = 'events.jsonl';
const EMPTY_TOPOLOGY: Topology = {
  machineId: '',
  initial: '',
  nodes: [],
  edges: [],
};

export function runViewCli(o: RunViewCliOpts): Promise<RunViewCliResult> {
  return runViewCliForTest({ ...o, launchBrowserImpl: launchBrowser });
}

export async function runViewCliForTest(o: RunViewCliForTestOpts): Promise<RunViewCliResult> {
  const selection = await selectRecordedRun({
    cwd: o.cwd,
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
  });
  if (!selection.ok) return viewError(o.stderr, selection.message, selection.exitCode);

  let recordedRunId: string;
  try {
    recordedRunId = await readRecordedRunId(selection.selected.eventsPath);
  } catch (e) {
    return viewError(o.stderr, (e as Error).message);
  }

  const queryService = createRunEventQueryService({
    runId: recordedRunId,
    eventsPath: selection.selected.eventsPath,
  });
  const runMeta = readRecordedRunMeta({
    runId: recordedRunId,
    eventsPath: selection.selected.eventsPath,
  });
  const topology = await recoverRecordedTopology({
    runMeta,
    cwd: o.cwd,
    stderr: o.stderr,
  });

  let uiServer: UiServerHandle | undefined;
  const uiToken = randomBytes(18).toString('base64url');
  try {
    uiServer = await (o.startUiServerImpl ?? startUiServer)({
      host: '127.0.0.1',
      port: 0,
      uiToken,
      runScoped: {
        activeRunId: recordedRunId,
        service: createViewRouteService(queryService),
        getRunMeta: () => ({ ...runMeta }),
        topology,
      },
      replyHandler: rejectViewReply,
    });
  } catch (e) {
    return viewError(o.stderr, `UI server failed: ${(e as Error).message}`);
  }

  const url = urlWithUiBootParams(uiServer.url, {
    token: uiToken,
    runId: recordedRunId,
    mode: 'view',
  });
  o.stdout.write(`aharness: run view available at ${url}\n`);
  if (o.launchBrowserImpl) {
    const launchResult = o.launchBrowserImpl(url);
    if (!launchResult.ok) {
      o.stderr.write(`aharness view: failed to launch browser: ${launchResult.message}\n`);
    }
  }

  let waitResult: { readonly exitCode?: number } | null = null;
  try {
    waitResult = await (o.waitForExit ?? waitForViewExit)();
  } finally {
    await uiServer.close();
  }
  return { exitCode: waitResult?.exitCode ?? 0 };
}

function createViewRouteService(service: RunEventQueryService): UiRunScopedRouteService {
  return {
    runId: service.runId,
    subscribe: service.subscribe,
    getLatestEventId: service.getLatestEventId,
    getBootstrap: (options) => {
      const result = service.getBootstrap(options);
      if (!result.ok) return result;
      return { ok: true, bootstrap: { ...result.bootstrap, mode: 'view' } };
    },
    getCompletionStats: service.getCompletionStats,
    getStateVisitRows: service.getStateVisitRows,
    getRecentRows: service.getRecentRows,
    getEventPage: service.getEventPage,
    eventsAfter: service.eventsAfter,
  };
}

function rejectViewReply(): { readonly status: 403; readonly body: { readonly error: string } } {
  return { status: 403, body: { error: 'replies-unavailable-in-view-mode' } };
}

async function selectRecordedRun(options: {
  readonly cwd: string;
  readonly runId?: string;
}): Promise<SelectionResult> {
  const runsRoot = resolve(options.cwd, '.aharness', 'runs');

  if (options.runId !== undefined) {
    if (!isValidViewRunId(options.runId)) {
      return { ok: false, message: `malformed run id: ${options.runId}`, exitCode: 2 };
    }
    return selectRequestedRun(runsRoot, options.runId);
  }

  return selectNewestRun(runsRoot);
}

async function selectRequestedRun(runsRoot: string, runId: string): Promise<SelectionResult> {
  const rootCheck = await inspectRunsRoot(runsRoot);
  if (!rootCheck.ok) return rootCheck;

  const eventsPath = resolve(runsRoot, runId, EVENTS_FILE);
  if (!isPathInside(runsRoot, eventsPath)) {
    return { ok: false, message: `selected events log escapes runs directory: ${eventsPath}` };
  }

  try {
    const eventsStat = await stat(eventsPath);
    if (!eventsStat.isFile()) {
      return { ok: false, message: `events log is not a file: ${eventsPath}` };
    }
  } catch (e) {
    if (isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR')) {
      return { ok: false, message: `recorded run not found: ${runId}` };
    }
    return {
      ok: false,
      message: `failed to inspect recorded run ${runId}: ${(e as Error).message}`,
    };
  }

  return { ok: true, selected: { eventsPath } };
}

async function inspectRunsRoot(runsRoot: string): Promise<RunsRootResult> {
  try {
    const rootStat = await stat(runsRoot);
    if (!rootStat.isDirectory()) {
      return { ok: false, message: `recorded runs path is not a directory: ${runsRoot}` };
    }
  } catch (e) {
    if (isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR')) {
      return { ok: false, message: `recorded runs directory not found: ${runsRoot}` };
    }
    return {
      ok: false,
      message: `failed to inspect recorded runs directory: ${(e as Error).message}`,
    };
  }

  return { ok: true };
}

async function selectNewestRun(runsRoot: string): Promise<SelectionResult> {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (e) {
    if (isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR')) {
      return { ok: false, message: `recorded runs directory not found: ${runsRoot}` };
    }
    return {
      ok: false,
      message: `failed to read recorded runs directory: ${(e as Error).message}`,
    };
  }

  const candidates: Array<{
    readonly dirName: string;
    readonly eventsPath: string;
    readonly mtimeMs: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = resolve(runsRoot, entry.name);
    const eventsPath = resolve(join(runDir, EVENTS_FILE));
    if (!isPathInside(runsRoot, eventsPath)) continue;

    try {
      const [dirStat, eventsStat] = await Promise.all([stat(runDir), stat(eventsPath)]);
      if (dirStat.isDirectory() && eventsStat.isFile()) {
        candidates.push({ dirName: entry.name, eventsPath, mtimeMs: dirStat.mtimeMs });
      }
    } catch (e) {
      if (isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR')) continue;
      return {
        ok: false,
        message: `failed to inspect recorded run directory ${entry.name}: ${(e as Error).message}`,
      };
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      message: `no recorded run directories with ${EVENTS_FILE} found under ${runsRoot}`,
    };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.dirName.localeCompare(a.dirName));
  const selected = candidates[0]!;
  return { ok: true, selected: { eventsPath: selected.eventsPath } };
}

async function readRecordedRunId(eventsPath: string): Promise<string> {
  const input = createReadStream(eventsPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      return runIdFromFirstRecord(line);
    }
  } finally {
    lines.close();
    input.destroy();
  }

  throw new Error('recorded run log contains no canonical events');
}

function runIdFromFirstRecord(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new Error(`first recorded run event is not valid JSON: ${(e as Error).message}`, {
      cause: e,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error('first recorded run event must be a JSON object');
  }

  for (const key of ['schema', 'runId', 'seq', 'id', 'time', 'type'] as const) {
    if (missing(parsed, key)) {
      throw new Error(`first recorded run event is missing required field ${key}`);
    }
  }

  if (parsed['schema'] !== RUN_EVENT_SCHEMA) {
    throw new Error('first recorded run event is not an aharness.event.v1 canonical envelope');
  }

  const runId = parsed['runId'];
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('first recorded run event has no canonical runId');
  }

  const seq = parsed['seq'];
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
    throw new Error('first recorded run event has an invalid seq');
  }

  if (parsed['id'] !== `${runId}:${seq as number}`) {
    throw new Error('first recorded run event id does not match its runId and seq');
  }

  const time = parsed['time'];
  if (typeof time !== 'string' || time.length === 0) {
    throw new Error('first recorded run event has an invalid time');
  }

  const type = parsed['type'];
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('first recorded run event has an invalid type');
  }

  for (const key of ['threadId', 'turnId', 'stateVisitId', 'itemId', 'requestId'] as const) {
    if (!missing(parsed, key) && typeof parsed[key] !== 'string') {
      throw new Error(`first recorded run event ${key} field must be a string when present`);
    }
  }

  for (const key of ['data', 'meta', 'raw'] as const) {
    if (!missing(parsed, key) && !isRecord(parsed[key])) {
      throw new Error(`first recorded run event ${key} field must be an object when present`);
    }
  }

  return runId;
}

function readRecordedRunMeta(options: {
  readonly runId: string;
  readonly eventsPath: string;
}): RunMeta {
  const replay = replayRunEvents({ runId: options.runId, eventsPath: options.eventsPath });
  const started = replay.events.find((entry) => entry.event.type === 'run.started')?.event;
  const data = isRecord(started?.data) ? started.data : {};

  return {
    runId: options.runId,
    threadId: readString(data['threadId']),
    repoRoot: readString(data['repoRoot']),
    fsmFile: readString(data['fsmFile']),
    fsmHash6: readString(data['fsmHash6']),
    codexPin: readString(data['codexPin']),
    startedAt: readString(data['startedAt']),
  };
}

async function recoverRecordedTopology(options: {
  readonly runMeta: RunMeta;
  readonly cwd: string;
  readonly stderr: NodeJS.WritableStream;
}): Promise<Topology> {
  if (options.runMeta.fsmFile.length === 0) {
    warnTopologyRecoveryFailed(options.stderr, 'recorded run metadata does not include fsmFile');
    return EMPTY_TOPOLOGY;
  }

  const repoRoot = options.runMeta.repoRoot.length > 0 ? options.runMeta.repoRoot : options.cwd;
  const fsmFile = isAbsolute(options.runMeta.fsmFile)
    ? options.runMeta.fsmFile
    : resolve(repoRoot, options.runMeta.fsmFile);

  try {
    const loaded = await loadFsm({ filePath: fsmFile, repoRoot });
    return extractUiTopology(loaded.machine, { sidecar: loaded.sidecar });
  } catch (e) {
    warnTopologyRecoveryFailed(options.stderr, (e as Error).message);
    return EMPTY_TOPOLOGY;
  }
}

function warnTopologyRecoveryFailed(stderr: NodeJS.WritableStream, reason: string): void {
  stderr.write(
    `aharness view: topology recovery failed: ${reason}. ` +
      'Topology recovery imports the recorded FSM source and may run import-time code under the same trust boundary as verify/run.\n',
  );
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isValidViewRunId(runId: string): boolean {
  return (
    runId.length > 0 &&
    runId !== '.' &&
    runId !== '..' &&
    !runId.startsWith('-') &&
    !runId.includes('/') &&
    !runId.includes('\\') &&
    !isAbsolute(runId)
  );
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missing(value: Record<string, unknown>, key: keyof RunEventEnvelope): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined;
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

function urlWithUiBootParams(
  url: string,
  params: {
    readonly token: string;
    readonly runId: string;
    readonly mode: 'view';
  },
): string {
  const parsed = new URL(url);
  parsed.searchParams.set('token', params.token);
  parsed.searchParams.set('runId', params.runId);
  parsed.searchParams.set('mode', params.mode);
  return parsed.toString();
}

function viewError(
  stderr: NodeJS.WritableStream,
  message: string,
  exitCode: number | undefined = 1,
): RunViewCliResult {
  stderr.write(`aharness view: ${message}\n`);
  return { exitCode };
}

function waitForViewExit(): Promise<{ readonly exitCode?: number } | null> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off('SIGINT', onStop);
      process.off('SIGTERM', onStop);
    };
    const onStop = (): void => {
      cleanup();
      resolve({ exitCode: 0 });
    };
    process.once('SIGINT', onStop);
    process.once('SIGTERM', onStop);
  });
}
