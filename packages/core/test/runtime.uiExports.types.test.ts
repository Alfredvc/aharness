import { describe, expectTypeOf, it } from 'vitest';
import type {
  AharnessApprovalResolution,
  AharnessElicitationResolution,
  AharnessOwnerChoiceInput,
  AharnessOwnerInputAnswer,
  AharnessPermissionResolution,
  AharnessRunHandle,
  AharnessRunReplyResult,
  AharnessRunResult,
  RunMeta,
  StartAharnessRunOptions,
  StartUiServerOptions,
} from '../src/runtime.js';

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

  it('exports the programmatic run option, handle, and reply input types', () => {
    expectTypeOf<StartAharnessRunOptions>().toHaveProperty('target').toEqualTypeOf<string>();
    expectTypeOf<StartAharnessRunOptions>()
      .toHaveProperty('cwd')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<StartAharnessRunOptions>()
      .toHaveProperty('permissionMode')
      .toEqualTypeOf<'autoReview' | 'ask' | 'yolo' | undefined>();
    expectTypeOf<StartAharnessRunOptions>()
      .toHaveProperty('ui')
      .toEqualTypeOf<boolean | { readonly open?: boolean } | undefined>();
    expectTypeOf<AharnessRunHandle['sendText']>().parameters.toEqualTypeOf<[text: string]>();
    expectTypeOf<AharnessRunHandle['chooseOwnerOption']>().parameters.toEqualTypeOf<
      [input: AharnessOwnerChoiceInput]
    >();
    expectTypeOf<AharnessRunHandle['answerOwnerInput']>().parameters.toEqualTypeOf<
      [input: AharnessOwnerInputAnswer]
    >();
    expectTypeOf<AharnessRunHandle['resolveApproval']>().parameters.toEqualTypeOf<
      [input: AharnessApprovalResolution]
    >();
    expectTypeOf<AharnessRunHandle['resolvePermission']>().parameters.toEqualTypeOf<
      [input: AharnessPermissionResolution]
    >();
    expectTypeOf<AharnessRunHandle['resolveElicitation']>().parameters.toEqualTypeOf<
      [input: AharnessElicitationResolution]
    >();
    expectTypeOf<AharnessRunReplyResult>().toHaveProperty('ok').toEqualTypeOf<boolean>();
    expectTypeOf<AharnessRunResult>()
      .toHaveProperty('status')
      .toEqualTypeOf<'completed' | 'failed' | 'cancelled'>();
  });
});
