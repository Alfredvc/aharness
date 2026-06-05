import { describe, expectTypeOf, it } from 'vitest';
import type { RunMeta, StartUiServerOptions } from '../src/runtime.js';

type RuntimeRunScopedOptions = NonNullable<StartUiServerOptions['runScoped']>;
type RuntimeRunScopedService = RuntimeRunScopedOptions['service'];

type StructuralRunScopedService = {
  readonly runId: 'run-structural';
  readonly subscribe: (_listener: () => void) => () => undefined;
  readonly getLatestEventId: () => 'run-structural:1';
  readonly getBootstrap: <TRunMeta extends object, TTopology = unknown>(options: {
    readonly getRunMeta: () => TRunMeta;
    readonly topology?: TTopology;
    readonly recentLimit?: number;
  }) => {
    readonly ok: true;
    readonly bootstrap: {
      readonly run: TRunMeta;
      readonly topology: TTopology | null;
      readonly latestEventId: 'run-structural:1';
      readonly currentState: null;
      readonly currentStateVisit: null;
      readonly stateVisits: readonly [];
      readonly statePathVisits: {};
      readonly pending: readonly [];
      readonly aggregateStats: { readonly turnCount: 0 };
      readonly completionStats: null;
      readonly recentRows: readonly [];
      readonly diagnostics: readonly [];
    };
  };
  readonly getCompletionStats: () => { readonly ok: true; readonly completionStats: null };
  readonly getStateVisitRows: () => {
    readonly ok: true;
    readonly rows: readonly [];
    readonly nextCursor: null;
  };
  readonly getRecentRows: () => {
    readonly ok: true;
    readonly rows: readonly [];
    readonly nextCursor: null;
  };
  readonly getEventPage: () => {
    readonly ok: true;
    readonly events: readonly [];
    readonly nextCursor: null;
    readonly diagnostics: readonly [];
  };
  readonly eventsAfter: () => { readonly ok: true; readonly events: readonly [] };
};

type StructuralStartUiServerOptions = {
  readonly host: '127.0.0.1';
  readonly port: 0;
  readonly uiToken: 'test-ui-token';
  readonly runScoped: {
    readonly activeRunId: 'run-structural';
    readonly service: StructuralRunScopedService;
    readonly getRunMeta: () => RunMeta;
    readonly topology: {
      readonly machineId: 'demo';
      readonly initial: 'root.plan';
      readonly nodes: readonly [];
      readonly edges: readonly [];
    };
  };
};

describe('runtime UI export types', () => {
  it('accepts a structural run-scoped route service', () => {
    expectTypeOf<StructuralRunScopedService>().toMatchTypeOf<RuntimeRunScopedService>();
    expectTypeOf<StructuralStartUiServerOptions>().toMatchTypeOf<StartUiServerOptions>();
  });
});
