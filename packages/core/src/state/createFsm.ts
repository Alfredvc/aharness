import { assign, type AnyEventObject, type AnyStateMachine, type MachineContext } from 'xstate';
import {
  arg,
  type ArgMeta,
  type ArgSentinel,
  type CompletionKind,
  type InputOf,
  type ResolveInput,
} from './args.js';
import {
  exit,
  final,
  passive,
  state,
  type Action,
  type AwaitExitDef,
  type CanonicalEventBranchMeta,
  type CanonicalEventKind,
  type CanonicalEventMeta,
  type CanonicalSubmitBranchMeta,
  type ExitDef,
  type FinalConfig,
  type FinalOutputFn,
  type StateConfig,
  type SubmitBranch,
} from './exits.js';
import {
  applyCanonicalAwaitCommitOrReduce,
  applyCanonicalCommitOrReduce,
  cloneCanonicalCallbackData,
  canonicalCommitContext,
  canonicalSelectedBranchIndex,
  defaultCanonicalOps,
  isCanonicalDryRun,
  payloadWithoutCanonicalCommit,
  runCanonicalEffectSynchronously,
} from './canonicalTransition.js';
import {
  embed as primitiveEmbed,
  type EmbeddedCompoundConfig,
  type EmbedOptions,
  type FinalsOf,
  type MinimalChildConfig,
} from './embed.js';
import type { AharnessOps } from './aharnessOps.js';
import type {
  PermissionRequestDecision,
  PermissionRequestEvent,
  PostToolUseDecision,
  PostToolUseEvent,
  PreToolUseDecision,
  PreToolUseEvent,
  UserPromptSubmitDecision,
  UserPromptSubmitEvent,
} from './hooks.js';
import { aharness, type ExtractFinals, type AharnessMachine } from './machine.js';
import {
  skill,
  type SkillOptions,
  type SkillRef,
  type SkillRefName,
  type SkillRefPath,
} from './skills.js';

type CanonicalText<Data> = string | ((data: Readonly<Data>) => string);

type CanonicalClearOnEntry<Data> =
  | boolean
  | {
      readonly cwd: string | ((data: Readonly<Data>) => string);
    };

type CanonicalReducer<Data, Payload> = (draft: Data, payload: Payload) => void | Partial<Data>;

type CanonicalEffect<Data, Payload> = (args: {
  readonly data: Readonly<Data>;
  readonly payload: Payload;
  readonly ops: AharnessOps;
}) => void | Promise<void>;

type CanonicalAwaitReducer<Data> = (draft: Data, ownerReply: string) => void | Partial<Data>;

type CanonicalAwaitEffect<Data> = (args: {
  readonly data: Readonly<Data>;
  readonly ownerReply: string;
  readonly ops: AharnessOps;
}) => void | Promise<void>;

type CanonicalEmbedReducer<Data, Output> = (draft: Data, output: Output) => void | Partial<Data>;

type CanonicalEmbedEffect<Data, Output> = (args: {
  readonly data: Readonly<Data>;
  readonly output: Output;
  readonly ops: AharnessOps;
}) => void | Promise<void>;

interface CanonicalSubmitDirect<Data, Payload> {
  readonly to: string;
  readonly route?: never;
  readonly effect?: CanonicalEffect<Data, Payload>;
  readonly reduce?: CanonicalReducer<Data, Payload>;
  readonly actions?: Action | ReadonlyArray<Action>;
}

interface CanonicalSubmitRouteBranch<Data, Payload> {
  readonly if: (data: Readonly<Data>, payload: Payload) => boolean;
  readonly to: string;
  readonly effect?: CanonicalEffect<Data, Payload>;
  readonly reduce?: CanonicalReducer<Data, Payload>;
  readonly actions?: Action | ReadonlyArray<Action>;
}

interface CanonicalSubmitRouteCatchAll<Data, Payload> {
  readonly if?: never;
  readonly to: string;
  readonly effect?: CanonicalEffect<Data, Payload>;
  readonly reduce?: CanonicalReducer<Data, Payload>;
  readonly actions?: Action | ReadonlyArray<Action>;
}

type CanonicalSubmitRoute<Data, Payload> = readonly [
  CanonicalSubmitRouteBranch<Data, Payload>,
  ...CanonicalSubmitRouteBranch<Data, Payload>[],
  CanonicalSubmitRouteCatchAll<Data, Payload>,
];

interface CanonicalSubmitRouted<Data, Payload> {
  readonly to?: never;
  readonly route: CanonicalSubmitRoute<Data, Payload>;
  readonly effect?: never;
  readonly reduce?: never;
  readonly actions?: never;
}

type CanonicalSubmitOptions<Data, Payload> =
  | CanonicalSubmitDirect<Data, Payload>
  | CanonicalSubmitRouted<Data, Payload>;

interface CanonicalSubmitTransition<Data, Payload> {
  readonly __canonicalKind: 'submit';
  readonly options: CanonicalSubmitOptions<Data, Payload>;
}

interface CanonicalAwaitOptions<Data> {
  readonly ask: CanonicalText<Data>;
  readonly to: string;
  readonly effect?: CanonicalAwaitEffect<Data>;
  readonly reduce?: CanonicalAwaitReducer<Data>;
}

interface CanonicalAwaitTransition<Data> {
  readonly __canonicalKind: 'await';
  readonly options: CanonicalAwaitOptions<Data>;
}

interface CanonicalEmbedFinalHandler<Data, Output> {
  readonly to: string;
  readonly effect?: CanonicalEmbedEffect<Data, Output>;
  readonly reduce?: CanonicalEmbedReducer<Data, Output>;
}

type CanonicalEmbedOn<Data, TFinals extends Record<string, unknown>> = {
  readonly [K in keyof TFinals]: CanonicalEmbedFinalHandler<Data, TFinals[K]>;
};

interface CanonicalEmbedOptions<Data, TChildInput, TFinals extends Record<string, unknown>> {
  readonly input: (data: Readonly<Data>) => TChildInput;
  readonly on: CanonicalEmbedOn<Data, TFinals>;
}

interface CanonicalEventDefinition<_Payload, Return = never> {
  readonly __canonicalEventDefinition: true;
  readonly request: [Return] extends [never] ? false : true;
  readonly defaultReturn?: Return;
}

type CanonicalEventPayload<T> =
  T extends CanonicalEventDefinition<infer Payload, unknown> ? Payload : never;

type CanonicalEventReturnValue<T> =
  T extends CanonicalEventDefinition<unknown, infer Return> ? Return : never;

type CanonicalEventReturnField<Data, Payload, Return> = [Return] extends [never]
  ? { readonly return?: never }
  : { readonly return?: (data: Readonly<Data>, payload: Payload) => Return };

type CanonicalEventDirect<Data, Payload, Return> = {
  readonly to?: string;
  readonly route?: never;
  readonly effect?: CanonicalEffect<Data, Payload>;
  readonly reduce?: CanonicalReducer<Data, Payload>;
  readonly actions?: Action | ReadonlyArray<Action>;
} & CanonicalEventReturnField<Data, Payload, Return>;

type CanonicalEventRouteBranch<Data, Payload, Return> = {
  readonly if: (data: Readonly<Data>, payload: Payload) => boolean;
  readonly to?: string;
  readonly effect?: CanonicalEffect<Data, Payload>;
  readonly reduce?: CanonicalReducer<Data, Payload>;
  readonly actions?: Action | ReadonlyArray<Action>;
} & CanonicalEventReturnField<Data, Payload, Return>;

type CanonicalEventRouteCatchAll<Data, Payload, Return> = {
  readonly if?: never;
  readonly to?: string;
  readonly effect?: CanonicalEffect<Data, Payload>;
  readonly reduce?: CanonicalReducer<Data, Payload>;
  readonly actions?: Action | ReadonlyArray<Action>;
} & CanonicalEventReturnField<Data, Payload, Return>;

type CanonicalEventRoute<Data, Payload, Return> = readonly [
  CanonicalEventRouteBranch<Data, Payload, Return>,
  ...CanonicalEventRouteBranch<Data, Payload, Return>[],
  CanonicalEventRouteCatchAll<Data, Payload, Return>,
];

type CanonicalEventRouted<Data, Payload, Return> = {
  readonly to?: never;
  readonly route: CanonicalEventRoute<Data, Payload, Return>;
  readonly effect?: never;
  readonly reduce?: never;
  readonly actions?: never;
} & CanonicalEventReturnField<Data, Payload, never>;

type CanonicalEventHandlerOptions<Data, Payload, Return> =
  | CanonicalEventDirect<Data, Payload, Return>
  | CanonicalEventRouted<Data, Payload, Return>;

type WithMatch<T> = T & { readonly match?: string };
type WithoutMatch<T> = T & { readonly match?: never };

interface BuiltinEventPayloads {
  readonly permissionRequest: PermissionRequestEvent;
  readonly preToolUse: PreToolUseEvent;
  readonly postToolUse: PostToolUseEvent;
  readonly userPromptSubmit: UserPromptSubmitEvent;
}

interface BuiltinEventReturns {
  readonly permissionRequest: PermissionRequestDecision;
  readonly preToolUse: PreToolUseDecision;
  readonly postToolUse: PostToolUseDecision;
  readonly userPromptSubmit: UserPromptSubmitDecision;
}

type BuiltinEventName = keyof BuiltinEventPayloads;

type BuiltinEventHandlerOptions<Data, Name extends BuiltinEventName> = Name extends
  | 'permissionRequest'
  | 'preToolUse'
  | 'postToolUse'
  ? WithMatch<
      CanonicalEventHandlerOptions<Data, BuiltinEventPayloads[Name], BuiltinEventReturns[Name]>
    >
  : WithoutMatch<
      CanonicalEventHandlerOptions<Data, BuiltinEventPayloads[Name], BuiltinEventReturns[Name]>
    >;

type CanonicalTransition<Data> =
  // oxlint-disable-next-line typescript/no-explicit-any
  CanonicalSubmitTransition<Data, any> | CanonicalAwaitTransition<Data>;

type EventCatalog = Readonly<Record<string, CanonicalEventDefinition<unknown, unknown>>>;

type KnownEventOn<Data, Events extends EventCatalog> = {
  readonly [K in keyof Events]?: CanonicalEventHandlerOptions<
    Data,
    CanonicalEventPayload<Events[K]>,
    CanonicalEventReturnValue<Events[K]>
  >;
};

type BuiltinEventOn<Data> = {
  readonly [K in BuiltinEventName]?: BuiltinEventHandlerOptions<Data, K>;
};

// oxlint-disable-next-line typescript/no-explicit-any
type AnyEventHandler<Data> = CanonicalEventHandlerOptions<Data, any, any>;

type BroadEventOn<Data> = Readonly<
  Record<string, CanonicalTransition<Data> | AnyEventHandler<Data>>
>;

type CanonicalOn<Data, Events extends EventCatalog> = KnownEventOn<Data, Events> &
  BuiltinEventOn<Data> &
  BroadEventOn<Data>;

type BadEventCatalogKeys<TEvents extends EventCatalog> = {
  [K in keyof TEvents]: K extends BuiltinEventName
    ? K
    : K extends `SUBMIT__${string}` | `AWAIT__${string}`
      ? K
      : never;
}[keyof TEvents];

type ValidateEventCatalog<TEvents extends EventCatalog> = [BadEventCatalogKeys<TEvents>] extends [
  never,
]
  ? unknown
  : never;

type AwaitKeys<TOn> = {
  // oxlint-disable-next-line typescript/no-explicit-any
  [K in keyof TOn]: TOn[K] extends CanonicalAwaitTransition<any> ? K : never;
}[keyof TOn];

type IsUnion<T, U = T> = [T] extends [never]
  ? false
  : T extends unknown
    ? [U] extends [T]
      ? false
      : true
    : false;

type HasAwait<TOn> = [AwaitKeys<TOn>] extends [never] ? false : true;

type BadCanonicalOnKeys<TOn, Events extends EventCatalog> = {
  [K in keyof TOn]: K extends keyof Events
    ? never
    : K extends BuiltinEventName
      ? never
      : TOn[K] extends CanonicalTransition<DataFromTransition<TOn[K]>>
        ? never
        : K;
}[keyof TOn];

type DataFromTransition<T> =
  // oxlint-disable-next-line typescript/no-explicit-any
  T extends CanonicalTransition<infer Data> ? Data : any;

type ValidateCanonicalOn<TOn, Events extends EventCatalog> = [
  BadCanonicalOnKeys<TOn, Events>,
] extends [never]
  ? TOn
  : never;

type ValidateStateOptions<TOptions, Events extends EventCatalog> = TOptions extends {
  readonly on: infer TOn;
}
  ? TOptions extends { readonly ask: unknown }
    ? HasAwait<TOn> extends true
      ? never
      : IsUnion<AwaitKeys<TOn>> extends true
        ? never
        : ValidateCanonicalOn<TOn, Events> extends never
          ? never
          : TOptions
    : IsUnion<AwaitKeys<TOn>> extends true
      ? never
      : ValidateCanonicalOn<TOn, Events> extends never
        ? never
        : TOptions
  : TOptions;

interface CanonicalStateOptions<Data, Events extends EventCatalog> {
  readonly mode?: 'strict' | 'open';
  readonly main?: boolean;
  readonly prompt: CanonicalText<Data>;
  readonly ask?: CanonicalText<Data>;
  readonly on?: CanonicalOn<Data, Events>;
  readonly entry?: (data: Readonly<Data>, ops: AharnessOps) => void | Promise<void>;
  readonly clearOnEntry?: CanonicalClearOnEntry<Data>;
  readonly guidance?: CanonicalText<Data>;
  readonly skills?: ReadonlyArray<SkillRef>;
  readonly xstate?: Record<string, unknown>;
}

type DataFactoryArgs<TInput> = {
  readonly input: TInput;
  readonly spawn: unknown;
  readonly self: unknown;
};

type CanonicalData<Data, TInput> = Data | ((args: DataFactoryArgs<TInput>) => Data);

type CanonicalMachineConfig<Data, TInput extends Record<string, ArgSentinel>, TStates> = Omit<
  Record<string, unknown>,
  'context' | 'data' | 'input' | 'states'
> & {
  readonly input?: TInput;
  readonly data?: CanonicalData<Data, ResolveInput<TInput>>;
  readonly initial?: string;
  readonly states: TStates;
};

type CompletionInput<T> = Omit<ArgMeta<T>, 'completion'> & {
  readonly complete?: CompletionKind | DynamicComplete;
};

type DynamicComplete = (
  ...args: Parameters<Extract<CompletionKind, { dynamic: unknown }>['dynamic']>
) => ReadonlyArray<string>;

interface CanonicalInputHelpers {
  string(meta?: CompletionInput<string>): ArgSentinel<string>;
  number(meta?: CompletionInput<number>): ArgSentinel<number>;
  path(meta?: CompletionInput<string>): ArgSentinel<string>;
  custom<T>(meta?: CompletionInput<T>): ArgSentinel<T>;
  values(values: ReadonlyArray<string>): Extract<CompletionKind, { values: ReadonlyArray<string> }>;
}

interface CanonicalSkillFacade {
  (name: string, opts?: SkillOptions): SkillRefName;
  path(path: string, opts?: SkillOptions): SkillRefPath;
}

type ArtifactRenderer<Data> = (data: Readonly<Data>) => string | Uint8Array;

interface CanonicalFinalOptions<Data, TOutput = undefined> {
  readonly outcome: 'success' | 'failure';
  readonly main?: boolean;
  readonly output?: (data: Readonly<Data>) => TOutput;
  readonly artifacts?: Readonly<Record<string, ArtifactRenderer<Data>>>;
}

type CanonicalFinalConfig<TOutput> = FinalConfig<TOutput> & {
  readonly meta: FinalConfig<TOutput>['meta'] & {
    readonly aharness: FinalConfig<TOutput>['meta']['aharness'] & {
      readonly artifacts?: Readonly<Record<string, ArtifactRenderer<unknown>>>;
    };
  };
};

interface CreateFsmFactory<Data, Events extends EventCatalog = Record<never, never>> {
  machine<
    const TInput extends Record<string, ArgSentinel> = Record<string, never>,
    const TStates extends Record<string, unknown> = Record<string, never>,
  >(
    config: CanonicalMachineConfig<Data, TInput, TStates>,
  ): AharnessMachine<Data, AnyEventObject, ResolveInput<TInput>, ExtractFinals<TStates>>;
  state<const TOptions extends CanonicalStateOptions<Data, Events>>(
    opts: ValidateStateOptions<TOptions, Events>,
  ): StateConfig;
  event<Payload>(): CanonicalEventDefinition<Payload>;
  event<Payload, Return>(opts: {
    readonly defaultReturn: Return;
  }): CanonicalEventDefinition<Payload, Return>;
  withEvents<const TEvents extends EventCatalog>(
    events: TEvents & ValidateEventCatalog<TEvents>,
  ): CreateFsmFactory<Data, TEvents>;
  submit<Payload>(
    opts: CanonicalSubmitOptions<Data, Payload>,
  ): CanonicalSubmitTransition<Data, Payload>;
  await(opts: CanonicalAwaitOptions<Data>): CanonicalAwaitTransition<Data>;
  embed<TChildFsm extends AnyStateMachine | MinimalChildConfig>(
    child: TChildFsm,
    opts: CanonicalEmbedOptions<Data, InputOf<TChildFsm>, FinalsOf<TChildFsm>>,
  ): EmbeddedCompoundConfig;
  final<TOutput = undefined>(
    opts: CanonicalFinalOptions<Data, TOutput>,
  ): CanonicalFinalConfig<TOutput>;
  passive<TConfig extends Record<string, unknown> = Record<string, never>>(
    config?: TConfig,
  ): TConfig & ReturnType<typeof passive>;
  input: CanonicalInputHelpers;
  skill: CanonicalSkillFacade;
}

function normalizeArgMeta<T>(meta?: CompletionInput<T>): ArgMeta<T> | undefined {
  if (meta === undefined) return undefined;
  const { complete, ...rest } = meta;
  if (complete === undefined) return rest;
  if (typeof complete === 'function') return { ...rest, completion: { dynamic: complete } };
  return { ...rest, completion: complete };
}

function makeInputHelpers(): CanonicalInputHelpers {
  return {
    string: (meta) => arg<string>(normalizeArgMeta(meta)),
    number: (meta) => arg<number>(normalizeArgMeta(meta)),
    path: (meta) => arg<string>(normalizeArgMeta(meta)),
    custom: <T>(meta?: CompletionInput<T>) => arg<T>(normalizeArgMeta(meta)),
    values: (values) => ({ values }),
  };
}

function makeSkillFacade(): CanonicalSkillFacade {
  const facade = ((name: string, opts?: SkillOptions) => skill(name, opts)) as CanonicalSkillFacade;
  facade.path = (path: string, opts?: SkillOptions) => skill({ path, ...opts });
  return facade;
}

function validateEventCatalog(events: EventCatalog): void {
  for (const name of Object.keys(events)) {
    if (isBuiltinEventName(name)) {
      throw new TypeError(`fsm.withEvents(): '${name}' is a reserved built-in hook event name`);
    }
    if (name.startsWith('SUBMIT__') || name.startsWith('AWAIT__')) {
      throw new TypeError(`fsm.withEvents(): '${name}' uses a reserved generated event prefix`);
    }
  }
}

function lowerEmbed<Data, TChildFsm extends AnyStateMachine | MinimalChildConfig>(
  child: TChildFsm,
  opts: CanonicalEmbedOptions<Data, InputOf<TChildFsm>, FinalsOf<TChildFsm>>,
): EmbeddedCompoundConfig {
  const primitiveOn = Object.fromEntries(
    Object.entries(opts.on).map(([finalId, handler]) => [
      finalId,
      { target: (handler as { readonly to: string }).to },
    ]),
  ) as EmbedOptions<MachineContext, InputOf<TChildFsm>, FinalsOf<TChildFsm>>['on'];
  const compound = primitiveEmbed(child, {
    input: ({ context }) => opts.input(context as Readonly<Data>),
    on: primitiveOn,
  });
  (
    compound.meta.aharness.embedded as {
      canonicalOnMap?: Record<string, CanonicalEmbedFinalHandler<Data, unknown>>;
    }
  ).canonicalOnMap = opts.on as Record<string, CanonicalEmbedFinalHandler<Data, unknown>>;
  return compound;
}

function lowerSubmit<Data, Payload>(transition: CanonicalSubmitTransition<Data, Payload>) {
  const options = transition.options;
  validateSubmitOptions(options);
  if ('route' in options && options.route !== undefined) {
    const route = options.route;
    const branches = route.map((branch, index) => {
      const meta = canonicalSubmitBranchMeta(branch);
      return {
        guard: ({ context, event }: { context: unknown; event: { payload: unknown } }) => {
          const selected = canonicalSelectedBranchIndex(event);
          if (selected !== undefined) return selected === index;
          const payload = payloadWithoutCanonicalCommit(event.payload) as Payload;
          const predicateOk =
            branch.if === undefined
              ? true
              : branch.if(cloneCanonicalCallbackData(context as Data), payload);
          if (!predicateOk) return false;
          if (canonicalCommitContext(event) !== undefined) return true;
          if (meta.effect === undefined) return true;
          return runCanonicalEffectSynchronously({
            run: () =>
              meta.effect?.({
                data: cloneCanonicalCallbackData(context as Data),
                payload,
                ops: defaultCanonicalOps(),
              }),
          });
        },
        to: branch.to,
        actions: canonicalActions(meta, branch.actions),
        __aharnessCanonical: meta as unknown as CanonicalSubmitBranchMeta<MachineContext, Payload>,
      };
    }) as ReadonlyArray<SubmitBranch<MachineContext, Payload>>;
    return exit<Payload>({
      when: branches,
      __aharnessCanonical: {
        kind: 'submit',
        branches: route.map((branch) =>
          canonicalSubmitBranchMeta(branch),
        ) as unknown as ReadonlyArray<CanonicalSubmitBranchMeta<MachineContext, Payload>>,
      },
    });
  }
  const meta = canonicalSubmitBranchMeta(options);
  return exit<Payload>({
    to: options.to,
    ...(meta.effect !== undefined
      ? {
          guard: ({ context, event }: { context: unknown; event: { payload: unknown } }) => {
            if (canonicalCommitContext(event) !== undefined) return true;
            const payload = payloadWithoutCanonicalCommit(event.payload) as Payload;
            return runCanonicalEffectSynchronously({
              run: () =>
                meta.effect?.({
                  data: cloneCanonicalCallbackData(context as Data),
                  payload,
                  ops: defaultCanonicalOps(),
                }),
            });
          },
        }
      : {}),
    actions: canonicalActions(meta, options.actions),
    __aharnessCanonical: {
      kind: 'submit',
      branches: [meta] as unknown as ReadonlyArray<
        CanonicalSubmitBranchMeta<MachineContext, Payload>
      >,
    },
  });
}

function lowerAwait<Data>(transition: CanonicalAwaitTransition<Data>): AwaitExitDef {
  const meta = {
    kind: 'await' as const,
    ask: transition.options.ask as string | ((ctx: Data) => string),
    ...(transition.options.effect !== undefined ? { effect: transition.options.effect } : {}),
    ...(transition.options.reduce !== undefined ? { reduce: transition.options.reduce } : {}),
  };
  return {
    kind: 'await',
    to: transition.options.to,
    actions: assign(({ context, event }) => {
      if (isCanonicalDryRun()) return {};
      const ownerReply =
        (event as { payload?: { ownerReply?: unknown } }).payload?.ownerReply ?? '';
      return applyCanonicalAwaitCommitOrReduce({
        context: context as Record<string, unknown>,
        event,
        meta: meta as AwaitExitDef['__aharnessCanonical'] & {
          kind: 'await';
        },
        ownerReply: typeof ownerReply === 'string' ? ownerReply : '',
      });
    }) as NonNullable<AwaitExitDef['actions']>,
    __aharnessCanonical: meta as NonNullable<AwaitExitDef['__aharnessCanonical']>,
  };
}

function lowerStateOptions<Data, Events extends EventCatalog>(
  opts: CanonicalStateOptions<Data, Events>,
  eventCatalog: Events,
): StateConfig {
  const exits: Record<string, ExitDef> = {};
  const canonicalEvents: Record<string, CanonicalEventMeta> = {};
  let awaitExitName: string | null = null;
  for (const [name, transition] of Object.entries((opts.on ?? {}) as Record<string, unknown>)) {
    if (isCanonicalTransition(transition)) {
      if (transition.__canonicalKind === 'await') {
        if (awaitExitName !== null) {
          throw new TypeError(
            `fsm.state(): at most one await exit is allowed (saw '${awaitExitName}' and '${name}')`,
          );
        }
        awaitExitName = name;
      }
      exits[name] =
        transition.__canonicalKind === 'await'
          ? lowerAwait(transition)
          : lowerSubmit(transition as CanonicalSubmitTransition<Data, unknown>);
      continue;
    }

    if (isBuiltinEventName(name)) {
      canonicalEvents[name] = lowerEventMeta(
        name,
        name,
        builtinEventDefinition(name),
        transition as CanonicalEventHandlerOptions<Data, unknown, unknown> & {
          readonly match?: string;
        },
      ) as unknown as CanonicalEventMeta;
      continue;
    }

    if (name in eventCatalog) {
      canonicalEvents[name] = lowerEventMeta(
        name,
        'custom',
        eventCatalog[name] as CanonicalEventDefinition<unknown, unknown>,
        transition as CanonicalEventHandlerOptions<Data, unknown, unknown>,
      ) as unknown as CanonicalEventMeta;
      continue;
    }

    throw new TypeError(
      `fsm.state(): unknown event handler '${name}' must use fsm.submit(...) or fsm.await(...)`,
    );
  }
  if (Object.keys(exits).length === 0 && Object.keys(canonicalEvents).length === 0) {
    throw new TypeError(
      'fsm.state(): at least one submit, await, or canonical event transition is required; use fsm.passive() for XState-native/passive states or fsm.final() for terminal states',
    );
  }

  for (const eventName of Object.keys(canonicalEvents)) {
    if (exits[eventName] !== undefined) {
      throw new TypeError(
        `fsm.state(): event '${eventName}' collides with an exit of the same name`,
      );
    }
  }

  const guidance = opts.guidance;
  const ask = opts.ask;
  const xstateOn = asRecord(opts.xstate?.['on']);
  for (const eventName of Object.keys(canonicalEvents)) {
    if (xstateOn?.[eventName] !== undefined) {
      throw new TypeError(
        `fsm.state(): canonical event '${eventName}' collides with xstate.on['${eventName}']`,
      );
    }
  }
  const loweredEventOn = lowerEventOn(canonicalEvents);
  const stateOpts: Record<string, unknown> = {
    entryPrompt: opts.prompt as Parameters<typeof state>[0]['entryPrompt'],
    exits,
    ...(Object.keys(canonicalEvents).length > 0 ? { canonicalEvents } : {}),
    open: opts.mode === 'open',
    ...(opts.main === true ? { main: true } : {}),
  };
  if (guidance !== undefined) {
    stateOpts['stopGuidance'] = ((ctx) => resolveText(guidance, ctx as Data)) as Parameters<
      typeof state
    >[0]['stopGuidance'];
  }
  if (ask !== undefined) {
    stateOpts['awaitsOwnerText'] = {
      messageToUser: ((ctx) => resolveText(ask, ctx as Data)) as NonNullable<
        Parameters<typeof state>[0]['awaitsOwnerText']
      >['messageToUser'],
    };
  }
  if (opts.entry !== undefined) stateOpts['onEntry'] = opts.entry;
  if (opts.clearOnEntry !== undefined) stateOpts['clearOnEntry'] = opts.clearOnEntry;
  if (opts.skills !== undefined) stateOpts['skills'] = opts.skills;
  const base = state(stateOpts as unknown as Parameters<typeof state>[0]);
  const xstateMeta = asRecord(opts.xstate?.['meta']);
  return {
    ...(opts.xstate ?? {}),
    ...base,
    meta: {
      ...(xstateMeta ?? {}),
      aharness: base.meta.aharness,
    },
    ...(Object.keys(loweredEventOn).length > 0
      ? { on: { ...(xstateOn ?? {}), ...loweredEventOn } }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function lowerEventOn(events: Record<string, CanonicalEventMeta>): Record<string, unknown> {
  const on: Record<string, unknown> = {};
  for (const [eventName, meta] of Object.entries(events)) {
    on[eventName] = meta.branches.map((branch, index) => ({
      ...(branch.to !== undefined ? { target: branch.to } : {}),
      guard: ({ context, event }: { context: unknown; event: { payload?: unknown } }) => {
        const selected = canonicalSelectedBranchIndex(event);
        if (selected !== undefined) return selected === index;
        const payload = payloadWithoutCanonicalCommit(event.payload);
        return branch.predicate === undefined
          ? true
          : branch.predicate(cloneCanonicalCallbackData(context) as Readonly<unknown>, payload);
      },
      actions: canonicalEventActions(branch.actions),
    }));
  }
  return on;
}

function isCanonicalTransition<Data>(value: unknown): value is CanonicalTransition<Data> {
  return (
    value !== null &&
    typeof value === 'object' &&
    ((value as { __canonicalKind?: unknown }).__canonicalKind === 'submit' ||
      (value as { __canonicalKind?: unknown }).__canonicalKind === 'await')
  );
}

function isBuiltinEventName(name: string): name is BuiltinEventName {
  return (
    name === 'permissionRequest' ||
    name === 'preToolUse' ||
    name === 'postToolUse' ||
    name === 'userPromptSubmit'
  );
}

function builtinEventDefinition(
  name: BuiltinEventName,
): CanonicalEventDefinition<unknown, unknown> {
  return {
    __canonicalEventDefinition: true,
    request: true,
    ...(name === 'permissionRequest' ? { defaultReturn: 'delegate' } : {}),
  };
}

function lowerEventMeta<Data, Payload, Return>(
  name: string,
  eventKind: CanonicalEventKind,
  definition: CanonicalEventDefinition<Payload, Return>,
  options: CanonicalEventHandlerOptions<Data, Payload, Return> & { readonly match?: string },
): CanonicalEventMeta<Data, Payload, Return> {
  validateEventOptions(name, eventKind, definition, options);
  const branches =
    'route' in options && options.route !== undefined
      ? options.route.map((branch) => canonicalEventBranchMeta(branch))
      : [canonicalEventBranchMeta(options)];
  return {
    kind: 'event',
    eventKind,
    request: definition.request,
    ...(definition.defaultReturn !== undefined ? { defaultReturn: definition.defaultReturn } : {}),
    ...(options.match !== undefined ? { match: options.match } : {}),
    branches,
  };
}

function canonicalEventBranchMeta<Data, Payload, Return>(
  branch:
    | CanonicalEventDirect<Data, Payload, Return>
    | CanonicalEventRouteBranch<Data, Payload, Return>
    | CanonicalEventRouteCatchAll<Data, Payload, Return>,
): CanonicalEventBranchMeta<Data, Payload, Return> {
  return {
    ...('if' in branch && branch.if !== undefined ? { predicate: branch.if } : {}),
    ...(branch.to !== undefined ? { to: branch.to } : {}),
    ...(branch.effect !== undefined ? { effect: branch.effect } : {}),
    ...(branch.reduce !== undefined ? { reduce: branch.reduce } : {}),
    ...(branch.return !== undefined ? { return: branch.return } : {}),
    ...(branch.actions !== undefined ? { actions: branch.actions } : {}),
  };
}

function validateEventOptions<Data, Payload, Return>(
  name: string,
  eventKind: CanonicalEventKind,
  definition: CanonicalEventDefinition<Payload, Return>,
  options: CanonicalEventHandlerOptions<Data, Payload, Return> & { readonly match?: string },
): void {
  if (name.startsWith('SUBMIT__') || name.startsWith('AWAIT__')) {
    throw new TypeError(`fsm.state(): event '${name}' uses a reserved generated event prefix`);
  }
  if (eventKind === 'custom' && options.match !== undefined) {
    throw new TypeError(`fsm.state(): custom event '${name}' cannot declare match`);
  }
  if (eventKind === 'userPromptSubmit' && options.match !== undefined) {
    throw new TypeError('fsm.state(): userPromptSubmit does not support match');
  }
  if (
    (eventKind === 'permissionRequest' ||
      eventKind === 'preToolUse' ||
      eventKind === 'postToolUse') &&
    options.match !== undefined
  ) {
    validateRegex(name, options.match);
  }
  if (!definition.request && hasReturn(options)) {
    throw new TypeError(`fsm.state(): signal event '${name}' cannot declare return`);
  }
  if ('route' in options && options.route !== undefined) {
    if (
      options.to !== undefined ||
      options.effect !== undefined ||
      options.reduce !== undefined ||
      options.actions !== undefined ||
      options.return !== undefined
    ) {
      throw new TypeError(
        `fsm.state(): routed event '${name}' cannot declare top-level to, effect, reduce, actions, or return`,
      );
    }
    if (!Array.isArray(options.route) || options.route.length < 2) {
      throw new TypeError(`fsm.state(): event '${name}' route must contain at least two branches`);
    }
    for (let i = 0; i < options.route.length; i++) {
      const branch = options.route[i] as
        | Partial<CanonicalEventRouteBranch<Data, Payload, Return>>
        | undefined;
      if (!branch) {
        throw new TypeError(`fsm.state(): event '${name}' route[${i}] must be an object`);
      }
      if (branch.effect !== undefined && branch.actions !== undefined) {
        throw new TypeError(
          `fsm.state(): event '${name}' route[${i}] cannot combine effect and actions`,
        );
      }
      if (i === options.route.length - 1) {
        if (branch.if !== undefined) {
          throw new TypeError(`fsm.state(): event '${name}' final route branch must omit if`);
        }
      } else if (typeof branch.if !== 'function') {
        throw new TypeError(`fsm.state(): event '${name}' route[${i}] must declare if`);
      }
      if (!definition.request && hasReturn(branch)) {
        throw new TypeError(`fsm.state(): signal event '${name}' cannot declare return`);
      }
    }
    return;
  }

  if (options.effect !== undefined && options.actions !== undefined) {
    throw new TypeError(`fsm.state(): event '${name}' cannot combine effect and actions`);
  }
}

function hasReturn(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { return?: unknown }).return !== undefined
  );
}

function validateRegex(name: string, matcher: string): void {
  if (typeof matcher !== 'string' || matcher.length === 0) {
    throw new TypeError(`fsm.state(): event '${name}' match must be a non-empty string`);
  }
  try {
    new RegExp(matcher);
  } catch (e) {
    throw new TypeError(
      `fsm.state(): event '${name}' match is not a valid regex: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function canonicalSubmitBranchMeta<Data, Payload>(
  branch:
    | CanonicalSubmitDirect<Data, Payload>
    | CanonicalSubmitRouteBranch<Data, Payload>
    | CanonicalSubmitRouteCatchAll<Data, Payload>,
): CanonicalSubmitBranchMeta<Data, Payload> {
  return {
    ...('if' in branch && branch.if !== undefined ? { predicate: branch.if } : {}),
    to: branch.to,
    ...(branch.effect !== undefined ? { effect: branch.effect } : {}),
    ...(branch.reduce !== undefined ? { reduce: branch.reduce } : {}),
    ...(branch.actions !== undefined ? { hasActions: true } : {}),
  };
}

function canonicalActions<Data, Payload>(
  meta: CanonicalSubmitBranchMeta<Data, Payload>,
  extra?: Action | ReadonlyArray<Action>,
): Action | ReadonlyArray<Action> {
  const actions: Action[] = [];
  if (extra !== undefined) {
    if (Array.isArray(extra)) {
      for (const action of extra as ReadonlyArray<Action>) actions.push(action);
    } else {
      actions.push(extra as Action);
    }
  }
  if (meta.reduce !== undefined) {
    actions.push(
      assign(({ context, event }) => {
        if (isCanonicalDryRun()) return {};
        const payload = payloadWithoutCanonicalCommit(
          (event as { payload?: unknown }).payload,
        ) as Payload;
        return applyCanonicalCommitOrReduce({
          context: context as Record<string, unknown>,
          event,
          branch: meta as CanonicalSubmitBranchMeta<Record<string, unknown>, Payload>,
          payload,
        });
      }) as Action,
    );
  } else {
    actions.push(
      assign(({ event }) => {
        const precomputed = canonicalCommitContext(event);
        return precomputed ?? {};
      }) as Action,
    );
  }
  return actions;
}

function canonicalEventActions(
  extra?: Action | ReadonlyArray<Action>,
): Action | ReadonlyArray<Action> {
  const actions: Action[] = [
    assign(({ event }) => {
      const precomputed = canonicalCommitContext(event);
      return precomputed ?? {};
    }) as Action,
  ];
  if (extra !== undefined) {
    if (Array.isArray(extra)) {
      for (const action of extra as ReadonlyArray<Action>) actions.push(action);
    } else {
      actions.push(extra as Action);
    }
  }
  return actions;
}

function validateSubmitOptions<Data, Payload>(
  options: CanonicalSubmitOptions<Data, Payload>,
): void {
  if ('route' in options) {
    if (options.to !== undefined) {
      throw new TypeError('fsm.submit(): declare exactly one of to or route');
    }
    if (
      options.effect !== undefined ||
      options.reduce !== undefined ||
      options.actions !== undefined
    ) {
      throw new TypeError(
        'fsm.submit(): routed submits cannot declare top-level effect, reduce, or actions',
      );
    }
    if (!Array.isArray(options.route) || options.route.length < 2) {
      throw new TypeError('fsm.submit(): route must contain at least two branches');
    }
    for (let i = 0; i < options.route.length; i++) {
      const branch = options.route[i] as
        | Partial<CanonicalSubmitRouteBranch<Data, Payload>>
        | undefined;
      if (!branch || typeof branch.to !== 'string' || branch.to.length === 0) {
        throw new TypeError(`fsm.submit(): route[${i}] must declare non-empty to`);
      }
      if (branch.effect !== undefined && branch.actions !== undefined) {
        throw new TypeError(`fsm.submit(): route[${i}] cannot combine effect and actions`);
      }
      if (i === options.route.length - 1) {
        if (branch.if !== undefined) {
          throw new TypeError('fsm.submit(): final route branch must omit if');
        }
      } else if (typeof branch.if !== 'function') {
        throw new TypeError(`fsm.submit(): route[${i}] must declare if`);
      }
    }
    return;
  }
  if (options.route !== undefined) {
    throw new TypeError('fsm.submit(): declare exactly one of to or route');
  }
  if (typeof options.to !== 'string' || options.to.length === 0) {
    throw new TypeError('fsm.submit(): direct submit must declare non-empty to');
  }
  if (options.effect !== undefined && options.actions !== undefined) {
    throw new TypeError('fsm.submit(): direct submit cannot combine effect and actions');
  }
}

function resolveText<Data>(text: CanonicalText<Data>, data: Data): string {
  return typeof text === 'function' ? text(data) : text;
}

/**
 * Create the typed canonical FSM authoring surface.
 *
 * This factory is additive: lower-level `aharness.machine`, `state`, `exit`,
 * `final`, `passive`, `arg`, and `skill` remain supported compatibility
 * primitives. Event, built-in hook authoring, and canonical embed authoring
 * are additive.
 */
export function createFsm<Data>(): CreateFsmFactory<Data> {
  return createFsmFactory<Data, Record<never, never>>({});
}

function createFsmFactory<Data, Events extends EventCatalog>(
  eventCatalog: Events,
): CreateFsmFactory<Data, Events> {
  const input = makeInputHelpers();
  const skillFacade = makeSkillFacade();
  return {
    machine: (
      config: CanonicalMachineConfig<Data, Record<string, ArgSentinel>, Record<string, unknown>>,
    ) => {
      const { data, ...rest } = config;
      const lowered = {
        ...rest,
        context:
          typeof data === 'function'
            ? (args: unknown) => (data as (args: unknown) => Data)(args)
            : data,
      };
      return aharness.machine(lowered as Parameters<typeof aharness.machine>[0]) as AharnessMachine<
        Data,
        AnyEventObject,
        never,
        never
      >;
    },
    state: (opts: unknown) =>
      lowerStateOptions(opts as CanonicalStateOptions<Data, Events>, eventCatalog),
    event: (opts?: { readonly defaultReturn: unknown }) =>
      ({
        __canonicalEventDefinition: true,
        request: opts !== undefined,
        ...(opts !== undefined ? { defaultReturn: opts.defaultReturn } : {}),
      }) as CanonicalEventDefinition<unknown, unknown>,
    withEvents: (events: EventCatalog) => {
      validateEventCatalog(events);
      return createFsmFactory<Data, typeof events>(events);
    },
    submit: (opts: CanonicalSubmitOptions<Data, unknown>) => ({
      __canonicalKind: 'submit',
      options: opts,
    }),
    await: (opts: CanonicalAwaitOptions<Data>) => ({ __canonicalKind: 'await', options: opts }),
    embed: (child: AnyStateMachine | MinimalChildConfig, opts: unknown) =>
      lowerEmbed(
        child,
        opts as CanonicalEmbedOptions<Data, InputOf<typeof child>, FinalsOf<typeof child>>,
      ),
    final: (opts: CanonicalFinalOptions<Data, unknown>) => {
      const node = final({
        outcome: opts.outcome,
        ...(opts.main === true ? { main: true } : {}),
        ...(opts.output !== undefined
          ? {
              output: (({ context }) => opts.output?.(context as Data)) as FinalOutputFn,
            }
          : {}),
      }) as CanonicalFinalConfig<unknown>;
      if (opts.artifacts !== undefined) {
        (node.meta.aharness as { artifacts?: CanonicalFinalOptions<Data>['artifacts'] }).artifacts =
          opts.artifacts;
      }
      return node as CanonicalFinalConfig<never>;
    },
    passive: (config?: Record<string, unknown>) => {
      const { main, ...xstateConfig } = config ?? {};
      if (main !== undefined && typeof main !== 'boolean') {
        throw new TypeError('passive(): main must be a boolean when provided');
      }
      return {
        ...xstateConfig,
        ...passive(main === undefined ? {} : { main }),
      } as (typeof config extends undefined ? Record<string, never> : NonNullable<typeof config>) &
        ReturnType<typeof passive>;
    },
    input,
    skill: skillFacade,
  } as unknown as CreateFsmFactory<Data, Events>;
}
