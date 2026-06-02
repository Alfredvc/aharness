/**
 * `aharness visualize <file>.fsm.ts` — load an FSM into the browser UI without
 * starting Codex, hooks, or an XState actor.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { loadFsm } from '../loader/index.js';
import { parseInputFlags } from '../loader/inputFlags.js';
import { fsmHash6 } from '../run.js';
import { resolveEntryPrompt } from '../runtime/resolvePrompt.js';
import type { RunCtx } from '../types.js';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import type { StateNode } from 'xstate';
import { createUiEventLog } from '../ui/sse.js';
import { startUiServer, type UiRunScopedRouteService, type UiServerHandle } from '../ui/server.js';
import { extractUiTopology } from '../ui/topology.js';
import { launchBrowser } from '../ui/browserLauncher.js';
import type { FsmState, RunMeta, VizNode } from '../ui/events.js';

import { emitReservedFlagWarnings } from './reservedFlags.js';
import { runVerifyCli } from './verifyCli.js';

export interface RunVisualizeCliOpts {
  readonly fsmPath: string;
  readonly cwd: string;
  readonly stderr: NodeJS.WritableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly inputArgs?: ReadonlyArray<string>;
}

export interface RunVisualizeCliResult {
  readonly exitCode: number;
}

export interface RunVisualizeCliTestHooks {
  readonly verify?: (o: { fsmPath: string; repoRoot: string }) => Promise<{ exitCode: number }>;
  readonly loadFsmImpl?: typeof loadFsm;
  readonly startUiServerImpl?: typeof startUiServer;
  readonly launchBrowserImpl?: typeof launchBrowser;
  readonly waitForExit?: () => Promise<{ readonly exitCode?: number } | null>;
}

export type RunVisualizeCliForTestOpts = RunVisualizeCliOpts & RunVisualizeCliTestHooks;

export function runVisualizeCli(o: RunVisualizeCliOpts): Promise<RunVisualizeCliResult> {
  return runVisualizeCliForTest({ ...o, launchBrowserImpl: launchBrowser });
}

export async function runVisualizeCliForTest(
  o: RunVisualizeCliForTestOpts,
): Promise<RunVisualizeCliResult> {
  const repoRoot = o.cwd;
  const verify = await (o.verify ?? defaultVerify)({ fsmPath: o.fsmPath, repoRoot });
  if (verify.exitCode !== 0) return { exitCode: verify.exitCode };

  const fsmAbs = resolve(repoRoot, o.fsmPath);
  const loadFsmFn = o.loadFsmImpl ?? loadFsm;
  let loaded: Awaited<ReturnType<typeof loadFsmFn>>;
  try {
    loaded = await loadFsmFn({ filePath: fsmAbs, repoRoot });
  } catch (e) {
    o.stderr.write(`aharness visualize: failed to load FSM: ${(e as Error).message}\n`);
    return { exitCode: 2 };
  }

  emitReservedFlagWarnings(loaded.inputFlags, o.stderr);
  const inputArgs = o.inputArgs ?? [];
  if (inputArgs.length > 0 && loaded.inputSchema && loaded.inputFlags) {
    const parsed = parseInputFlags({
      args: inputArgs,
      schema: optionalizeInputSchema(loaded.inputSchema),
      flags: loaded.inputFlags,
    });
    if (!parsed.ok) {
      o.stderr.write(`aharness visualize: input flags invalid:\n${parsed.errors.join('\n')}\n`);
      return { exitCode: 2 };
    }
  } else if (inputArgs.length > 0) {
    const unknownFlags = inputArgs.filter((arg) => arg.startsWith('--')).join(' ');
    o.stderr.write(
      `aharness visualize: FSM declares no input fields; unknown flags: ${unknownFlags}\n`,
    );
    return { exitCode: 2 };
  }

  const topology = extractUiTopology(loaded.machine, { sidecar: loaded.sidecar });
  const initialState = initialInspectState(loaded.machine, topology.nodes, topology.initial);
  const runMeta: RunMeta = {
    runId: `inspect-${fsmHash6(fsmAbs)}`,
    threadId: '',
    repoRoot,
    fsmFile: fsmAbs,
    fsmHash6: fsmHash6(fsmAbs),
    codexPin: 'not started',
    startedAt: new Date().toISOString(),
  };
  const eventLog = createUiEventLog({ run: runMeta, topology, mode: 'inspect' });
  eventLog.publish({
    kind: 'StateChange',
    from: null,
    to: initialState.path,
    cause: 'boot',
    newState: initialState,
  });

  let uiServer: UiServerHandle | undefined;
  const uiToken = randomBytes(18).toString('base64url');
  try {
    uiServer = await (o.startUiServerImpl ?? startUiServer)({
      host: '127.0.0.1',
      port: 0,
      uiToken,
      eventLog,
      runScoped: {
        activeRunId: runMeta.runId,
        service: createInspectRunScopedRouteService({
          runId: runMeta.runId,
          initialState,
          topology,
        }),
        getRunMeta: () => ({ ...runMeta }),
        topology,
      },
    });
  } catch (e) {
    o.stderr.write(`aharness visualize: UI server failed: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  const url = urlWithUiBootParams(uiServer.url, {
    token: uiToken,
    runId: runMeta.runId,
    mode: 'inspect',
  });
  o.stdout.write(`aharness: FSM visualization available at ${url}\n`);
  if (o.launchBrowserImpl) {
    const launchResult = o.launchBrowserImpl(url);
    if (!launchResult.ok) {
      o.stderr.write(`aharness visualize: failed to launch browser: ${launchResult.message}\n`);
    }
  }

  const waitResult = await (o.waitForExit ?? waitForSignal)();
  await uiServer.close();
  return { exitCode: waitResult?.exitCode ?? 0 };
}

async function defaultVerify(o: {
  readonly fsmPath: string;
  readonly repoRoot: string;
}): Promise<{ exitCode: number }> {
  return runVerifyCli({
    fsmPath: o.fsmPath,
    repoRoot: o.repoRoot,
    log: (line) => process.stderr.write(line + '\n'),
  });
}

function initialInspectState(
  machine: import('xstate').AnyStateMachine,
  nodes: ReadonlyArray<VizNode>,
  initial: string,
): FsmState {
  const node = nodes.find((candidate) => candidate.id === initial) ?? nodes[0];
  const path = node?.id ?? initial;
  const stateNode = findStateNode(machine, path);
  const meta = stateNode ? getAharnessMeta(stateNode) : undefined;
  const detail = node?.detail;
  const exits = (detail?.exits ?? [])
    .filter((exit) => exit.kind === 'submit')
    .map((exit) => ({
      name: exit.name,
      kind: 'submit' as const,
      ...(exit.branchCount !== undefined ? { branchCount: exit.branchCount } : {}),
    }));
  const entryPrompt =
    meta?.kind === 'stateful'
      ? resolveStaticEntryPrompt(meta.entryPrompt)
      : detail?.entryPrompt?.text;
  return {
    path,
    leaf: leafFromStatePath(path),
    kind: nodeKindToFsmKind(node?.kind),
    ...(typeof detail?.open === 'boolean' ? { open: detail.open } : {}),
    exits,
    visitCount: 1,
    ...(entryPrompt !== undefined ? { entryPrompt } : {}),
    context: {},
  };
}

function findStateNode(
  machine: import('xstate').AnyStateMachine,
  path: string,
): StateNode | undefined {
  for (const node of iterStates(machine)) {
    if (stateKeyPath(node) === path) return node;
  }
  return undefined;
}

function resolveStaticEntryPrompt(entryPrompt: string | ((ctx: RunCtx) => string)): string {
  if (typeof entryPrompt !== 'string') return '<dynamic prompt>';
  try {
    return resolveEntryPrompt(entryPrompt, {} as RunCtx);
  } catch (e) {
    return `(aharness: error computing entryPrompt: ${(e as Error).message})`;
  }
}

function nodeKindToFsmKind(kind: VizNode['kind'] | undefined): FsmState['kind'] {
  if (kind === 'terminal') return 'terminal';
  if (kind === 'passive') return 'passive';
  if (kind === 'stateful') return 'stateful';
  return 'final';
}

function leafFromStatePath(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] ?? path;
}

function createInspectRunScopedRouteService(options: {
  readonly runId: string;
  readonly initialState: FsmState;
  readonly topology: unknown;
}): UiRunScopedRouteService {
  const stateVisitId = `${options.initialState.path}#${options.initialState.visitCount}`;
  const bootTime = new Date().toISOString();
  const stateVisit = {
    id: stateVisitId,
    path: options.initialState.path,
    seq: 1,
    time: bootTime,
    from: null,
    to: options.initialState.path,
    cause: 'inspect',
  };
  const row = {
    id: `${options.runId}:inspect-state`,
    eventId: `${options.runId}:inspect`,
    seq: 1,
    time: bootTime,
    type: 'state.changed',
    stateVisitId,
    kind: 'state_change',
    label: options.initialState.path,
    status: 'inspect',
    summary: `Inspecting ${options.initialState.path}`,
  };

  return {
    runId: options.runId,
    subscribe: () => () => undefined,
    getLatestEventId: () => null,
    getBootstrap: ({ getRunMeta, topology }) => ({
      ok: true,
      bootstrap: {
        mode: 'inspect',
        run: getRunMeta(),
        topology: topology ?? options.topology,
        latestEventId: null,
        currentState: {
          path: options.initialState.path,
          leaf: options.initialState.leaf,
          kind: options.initialState.kind,
          visitCount: options.initialState.visitCount,
          exits: options.initialState.exits,
        },
        posture: {
          isTerminal: options.initialState.kind === 'terminal',
          isAwaiting: false,
          submittedThisTurn: false,
          open: options.initialState.open === true,
        },
        currentStateVisit: stateVisit,
        stateVisits: [stateVisit],
        statePathVisits: { [options.initialState.path]: [stateVisitId] },
        pending: [],
        aggregateStats: { turnCount: 0 },
        recentRows: [row],
        diagnostics: [],
      },
    }),
    getStateVisitRows: (stateVisitId) => ({
      ok: true,
      rows: stateVisitId === stateVisit.id ? [row] : [],
      nextCursor: null,
    }),
    getRecentRows: () => ({ ok: true, rows: [row], nextCursor: null }),
    getEventPage: () => ({ ok: true, events: [], nextCursor: null, diagnostics: [] }),
    eventsAfter: () => ({ ok: true, events: [] }),
  };
}

function urlWithUiBootParams(
  url: string,
  params: {
    readonly token: string;
    readonly runId: string;
    readonly mode: 'inspect';
  },
): string {
  const parsed = new URL(url);
  parsed.searchParams.set('token', params.token);
  parsed.searchParams.set('runId', params.runId);
  parsed.searchParams.set('mode', params.mode);
  return parsed.toString();
}

function optionalizeInputSchema(schema: Parameters<typeof parseInputFlags>[0]['schema']) {
  return { ...schema, required: [] };
}

function waitForSignal(): Promise<{ readonly exitCode?: number } | null> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    const onSigint = (): void => {
      cleanup();
      resolve({ exitCode: 130 });
    };
    const onSigterm = (): void => {
      cleanup();
      resolve({ exitCode: 143 });
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}
