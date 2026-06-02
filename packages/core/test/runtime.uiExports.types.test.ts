import { createUiEventLog, type RunMeta, type StartUiServerOptions } from '../src/runtime.js';
import { describe, expect, it } from 'vitest';

const run: RunMeta = {
  runId: 'run-structural',
  threadId: 'thread-1',
  repoRoot: '/repo',
  fsmFile: 'demo.fsm.ts',
  fsmHash6: 'abc123',
  codexPin: 'codex-test',
  startedAt: '2026-05-29T00:00:00.000Z',
};

const structuralRunScopedService = {
  runId: 'run-structural',
  subscribe: (_listener: () => void) => () => undefined,
  getLatestEventId: () => 'run-structural:1',
  getBootstrap: <TRunMeta extends object, TTopology = unknown>(options: {
    readonly getRunMeta: () => TRunMeta;
    readonly topology?: TTopology;
    readonly recentLimit?: number;
  }) => ({
    ok: true as const,
    bootstrap: {
      run: options.getRunMeta(),
      topology: options.topology ?? null,
      latestEventId: 'run-structural:1',
      currentState: null,
      currentStateVisit: null,
      stateVisits: [],
      statePathVisits: {},
      pending: [],
      aggregateStats: { turnCount: 0 },
      completionStats: null,
      recentRows: [],
      diagnostics: [],
    },
  }),
  getCompletionStats: () => ({ ok: true as const, completionStats: null }),
  getStateVisitRows: () => ({ ok: true as const, rows: [], nextCursor: null }),
  getRecentRows: () => ({ ok: true as const, rows: [], nextCursor: null }),
  getEventPage: () => ({ ok: true as const, events: [], nextCursor: null, diagnostics: [] }),
  eventsAfter: () => ({ ok: true as const, events: [] }),
};

const _options: StartUiServerOptions = {
  host: '127.0.0.1',
  port: 0,
  uiToken: 'test-ui-token',
  eventLog: createUiEventLog({ run }),
  runScoped: {
    activeRunId: 'run-structural',
    service: structuralRunScopedService,
    getRunMeta: () => run,
    topology: { machineId: 'demo', initial: 'root.plan', nodes: [], edges: [] },
  },
};

void _options;

describe('runtime UI export types', () => {
  it('accepts a structural run-scoped route service', () => {
    expect(_options.runScoped?.activeRunId).toBe('run-structural');
  });
});
