import { isAbsolute, resolve } from 'node:path';

import { METHOD } from '../protocol/methodNames.js';
import type {
  AgentMessageDeltaNotification,
  FileChangePatchUpdatedNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  RawResponseItemCompletedNotification,
  ServerNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from '../protocol/notifications.js';
import type {
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  ImageDetail,
  UserInput,
} from '../protocol/types.js';
import {
  CODEX_SIDECAR_DEFAULT_TURN_TIMEOUT_MS,
  CodexSidecarError,
  type CodexSidecarBoundaryResult,
  type CodexSidecarEvent,
  type CodexSidecarFailureBoundary,
  type CodexSidecarFailureReason,
  type CodexSidecarInput,
  type CodexSidecarInputRequest,
  type CodexSidecarInputRequestQuestion,
  type CodexSidecarOps,
  type CodexSidecarThread,
  type CodexSidecarThreadOptions,
  type CodexSidecarTurn,
} from '../state/codexSidecar.js';
import type { StateModelEffort } from '../state/exits.js';

import type { ResolvedRuntimeSkill } from './skillCatalog.js';
import { selectThreadSkillInput } from './skillInjection.js';

export type CodexSidecarNotificationHandler = (params: unknown) => void;

export interface CodexSidecarClient {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  onNotification(method: string, handler: CodexSidecarNotificationHandler): () => void;
}

export interface CodexSidecarManagerDiagnostic {
  readonly type: string;
  readonly key?: string;
  readonly label?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly message?: string;
  readonly data?: unknown;
}

export interface CodexSidecarThreadMetadata {
  readonly key: string;
  readonly threadId: string;
  readonly label?: string;
}

type Timer = ReturnType<typeof setTimeout>;

export interface CodexSidecarTimeoutClock {
  readonly setTimeout: (handler: () => void, timeoutMs: number) => Timer;
  readonly clearTimeout: (timer: Timer) => void;
}

export interface CreateCodexSidecarManagerOptions {
  readonly client: CodexSidecarClient;
  readonly defaultCwd: string;
  readonly resolvedSkills: ReadonlyArray<ResolvedRuntimeSkill>;
  readonly getActiveStateData: () => unknown;
  readonly getActiveStateSourceDir: () => string;
  readonly clock?: CodexSidecarTimeoutClock;
  readonly onDiagnostic?: (diagnostic: CodexSidecarManagerDiagnostic) => void;
}

export interface CodexSidecarManager extends CodexSidecarOps {
  readonly handleRequestUserInput: (
    params: ToolRequestUserInputParams,
  ) => Promise<ToolRequestUserInputResponse> | undefined;
  readonly ownsThread: (threadId: string) => boolean;
  readonly threadMetadata: (threadId: string) => CodexSidecarThreadMetadata | undefined;
  readonly markAppServerClosed: () => void;
  readonly shutdown: () => Promise<void>;
}

type ManagedSidecar = {
  readonly key: string;
  readonly threadId: string;
  readonly label?: string;
  readonly defaultTurnTimeoutMs: number;
  readonly initialSkillItems: ReadonlyArray<UserInput>;
  readonly handle: CodexSidecarThread;
  closed: boolean;
  closeStarted: boolean;
  firstTurnCommitted: boolean;
  active: ActiveOperation | undefined;
  pendingInput: PendingInputRequest | undefined;
  ignoredTurnIds: Set<string>;
};

type ActiveOperation = {
  readonly kind: 'send' | 'answer';
  readonly sidecar: ManagedSidecar;
  readonly timeoutMs: number;
  readonly events: CodexSidecarEvent[];
  readonly artifactsChanged: Set<string>;
  readonly promise: Promise<CodexSidecarBoundaryResult>;
  readonly resolve: (result: CodexSidecarBoundaryResult) => void;
  assistantText: string;
  tokenUsage?: unknown;
  turnId?: string;
  timer?: Timer;
  done: boolean;
};

type PendingInputRequest = {
  readonly id: string;
  readonly params: ToolRequestUserInputParams;
  readonly request: CodexSidecarInputRequest;
  readonly resolve: (response: ToolRequestUserInputResponse) => void;
  readonly promise: Promise<ToolRequestUserInputResponse>;
};

const stateModelEfforts = new Set<StateModelEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

const notificationMethods = [
  METHOD.turnStarted,
  METHOD.turnCompleted,
  METHOD.itemStarted,
  METHOD.itemCompleted,
  METHOD.fileChangePatchUpdated,
  METHOD.agentMessageDelta,
  METHOD.rawResponseItemCompleted,
  METHOD.threadTokenUsageUpdated,
] as const;

export function createCodexSidecarManager(
  opts: CreateCodexSidecarManagerOptions,
): CodexSidecarManager {
  const byKey = new Map<string, ManagedSidecar>();
  const byThreadId = new Map<string, ManagedSidecar>();
  const closedSidecarsForDiagnostics = new Map<
    string,
    {
      readonly key: string;
      readonly threadId: string;
      readonly ignoredTurnIds: ReadonlySet<string>;
    }
  >();
  let appServerClosed = false;
  const clock = opts.clock ?? {
    setTimeout: (handler: () => void, timeoutMs: number) => setTimeout(handler, timeoutMs),
    clearTimeout: (timer: Timer) => clearTimeout(timer),
  };
  const unsubscribers = notificationMethods.map((method) =>
    opts.client.onNotification(method, (params) => {
      handleNotification(method, params);
    }),
  );

  const manager: CodexSidecarManager = {
    async createThread<Data = unknown>(
      key: string,
      options?: CodexSidecarThreadOptions<Data>,
    ): Promise<CodexSidecarThread> {
      const normalizedKey = validateThreadKey(key);
      const owner = `Codex sidecar thread '${normalizedKey}'`;
      const existing = byKey.get(normalizedKey);
      if (existing !== undefined && !existing.closed) {
        throw new Error(`Codex sidecar thread key '${normalizedKey}' is already live`);
      }
      const prepared = prepareThreadOptions<Data>({
        owner,
        options,
        defaultCwd: opts.defaultCwd,
        activeData: opts.getActiveStateData(),
        sourceDir: opts.getActiveStateSourceDir(),
        resolvedSkills: opts.resolvedSkills,
      });
      const response = await opts.client.request<ThreadStartResponse>(METHOD.threadStart, {
        ...prepared.threadStartParams,
      } satisfies ThreadStartParams);
      const threadId = validateStartedThreadId(owner, response);
      const sidecar = createManagedSidecar({
        key: normalizedKey,
        threadId,
        ...(prepared.label !== undefined ? { label: prepared.label } : {}),
        defaultTurnTimeoutMs: prepared.defaultTurnTimeoutMs,
        initialSkillItems: prepared.initialSkillItems,
      });
      byKey.set(normalizedKey, sidecar);
      byThreadId.set(threadId, sidecar);
      emitDiagnostic({
        type: 'sidecar.thread.started',
        key: normalizedKey,
        threadId,
        ...(prepared.label !== undefined ? { label: prepared.label } : {}),
      });
      return sidecar.handle;
    },

    thread(key: string): CodexSidecarThread {
      const normalizedKey = validateThreadKey(key);
      const sidecar = byKey.get(normalizedKey);
      if (sidecar === undefined || sidecar.closed) {
        throw new Error(`Codex sidecar thread key '${normalizedKey}' is not live`);
      }
      return sidecar.handle;
    },

    handleRequestUserInput(params: ToolRequestUserInputParams) {
      if (!isToolRequestUserInputParams(params)) return undefined;
      const sidecar = byThreadId.get(params.threadId);
      if (sidecar === undefined || sidecar.closed) return undefined;
      if (sidecar.pendingInput !== undefined) {
        return Promise.resolve({ answers: {} });
      }
      const active = sidecar.active;
      if (active === undefined || active.done) {
        return Promise.resolve({ answers: {} });
      }
      if (active.turnId !== undefined && active.turnId !== params.turnId) {
        return Promise.resolve({ answers: {} });
      }
      active.turnId = params.turnId;
      const pending = createPendingInputRequest(params);
      sidecar.pendingInput = pending;
      appendEvent(
        active,
        {
          type: 'sidecar.input_request.created',
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          data: { requestId: pending.id, questions: params.questions },
        },
        emitDiagnostic,
      );
      finishOperation(active, {
        ok: true,
        kind: 'needsInput',
        request: pending.request,
        events: [...active.events],
      });
      return pending.promise;
    },

    ownsThread(threadId: string): boolean {
      return byThreadId.has(threadId);
    },

    threadMetadata(threadId: string): CodexSidecarThreadMetadata | undefined {
      const sidecar = byThreadId.get(threadId);
      if (sidecar === undefined) return undefined;
      return {
        key: sidecar.key,
        threadId: sidecar.threadId,
        ...(sidecar.label !== undefined ? { label: sidecar.label } : {}),
      };
    },

    markAppServerClosed(): void {
      if (appServerClosed) return;
      appServerClosed = true;
      for (const sidecar of byKey.values()) {
        if (sidecar.active !== undefined) {
          const active = sidecar.active;
          finishOperation(
            active,
            failureBoundary(sidecar, {
              reason: 'app_server_closed',
              message: `Codex sidecar thread '${sidecar.key}' app-server closed during ${active.kind}`,
              ...(active.turnId !== undefined ? { turnId: active.turnId } : {}),
              events: active.events,
            }),
          );
        }
        if (sidecar.pendingInput !== undefined) {
          sidecar.pendingInput.resolve({ answers: {} });
          sidecar.pendingInput = undefined;
        }
      }
    },

    async shutdown(): Promise<void> {
      for (const sidecar of [...byKey.values()]) {
        if (!sidecar.closed) {
          await closeSidecar(sidecar);
        }
      }
      for (const unsubscribe of unsubscribers) unsubscribe();
      closedSidecarsForDiagnostics.clear();
    },
  };

  return manager;

  function createManagedSidecar(input: {
    readonly key: string;
    readonly threadId: string;
    readonly label?: string;
    readonly defaultTurnTimeoutMs: number;
    readonly initialSkillItems: ReadonlyArray<UserInput>;
  }): ManagedSidecar {
    const sidecar = {
      key: input.key,
      threadId: input.threadId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      defaultTurnTimeoutMs: input.defaultTurnTimeoutMs,
      initialSkillItems: input.initialSkillItems,
      closed: false,
      closeStarted: false,
      firstTurnCommitted: false,
      active: undefined,
      pendingInput: undefined,
      ignoredTurnIds: new Set<string>(),
    } as ManagedSidecar;
    const handle: CodexSidecarThread = Object.freeze({
      key: input.key,
      threadId: input.threadId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      send: (
        turnInput: string | readonly CodexSidecarInput[],
        turnOptions?: { readonly timeoutMs?: number },
      ) => sendSidecar(sidecar, turnInput, turnOptions),
      sendOrThrow: async (
        turnInput: string | readonly CodexSidecarInput[],
        turnOptions?: { readonly timeoutMs?: number },
      ) => {
        const result = await sendSidecar(sidecar, turnInput, turnOptions);
        if (result.ok) return result;
        throw new CodexSidecarError(result);
      },
      answer: (
        requestId: string,
        answers: Readonly<Record<string, string | readonly string[]>>,
        turnOptions?: { readonly timeoutMs?: number },
      ) => answerSidecar(sidecar, requestId, answers, turnOptions),
      close: () => closeSidecar(sidecar),
    });
    return Object.assign(sidecar, { handle });
  }

  async function sendSidecar(
    sidecar: ManagedSidecar,
    turnInput: string | readonly CodexSidecarInput[],
    turnOptions: { readonly timeoutMs?: number } | undefined,
  ): Promise<CodexSidecarBoundaryResult> {
    const unavailable = unavailableBoundary(sidecar);
    if (unavailable !== undefined) return unavailable;
    const overlap = overlappingBoundary(sidecar);
    if (overlap !== undefined) return overlap;

    let input: ReadonlyArray<UserInput>;
    try {
      const userInput = normalizeTurnInput(sidecar, turnInput);
      input = sidecar.firstTurnCommitted ? userInput : [...sidecar.initialSkillItems, ...userInput];
    } catch (error) {
      return failureBoundary(sidecar, {
        reason: 'error',
        message: normalizeError(error).message,
        events: [],
      });
    }

    const timeoutMs = validateOperationTimeout(sidecar, turnOptions?.timeoutMs);
    const active = beginOperation(sidecar, 'send', timeoutMs);
    try {
      const response = await opts.client.request<TurnStartResponse>(METHOD.turnStart, {
        threadId: sidecar.threadId,
        input,
      } satisfies TurnStartParams);
      active.turnId = response.turn.id;
      sidecar.firstTurnCommitted = true;
      startOperationTimer(active);
    } catch (error) {
      finishOperation(
        active,
        failureBoundary(sidecar, {
          reason: errorReasonFromRequestError(error),
          message: requestFailureMessage(sidecar, 'send', error),
          events: active.events,
          cause: error,
        }),
      );
    }
    return active.promise;
  }

  async function answerSidecar(
    sidecar: ManagedSidecar,
    requestId: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
    turnOptions: { readonly timeoutMs?: number } | undefined,
  ): Promise<CodexSidecarBoundaryResult> {
    const unavailable = unavailableBoundary(sidecar);
    if (unavailable !== undefined) return unavailable;
    const activeOverlap = activeOperationBoundary(sidecar);
    if (activeOverlap !== undefined) return activeOverlap;
    const pending = sidecar.pendingInput;
    if (pending === undefined || pending.id !== requestId) {
      return failureBoundary(sidecar, {
        reason: 'error',
        message: `Codex sidecar thread '${sidecar.key}' is not waiting for sidecar input request '${requestId}'`,
        events: [],
      });
    }

    const timeoutMs = validateOperationTimeout(sidecar, turnOptions?.timeoutMs);
    let response: ToolRequestUserInputResponse;
    try {
      response = normalizeAnswerPayload(sidecar, answers);
    } catch (error) {
      return failureBoundary(sidecar, {
        reason: 'error',
        message: normalizeError(error).message,
        turnId: pending.params.turnId,
        events: [],
      });
    }

    const active = beginOperation(sidecar, 'answer', timeoutMs);
    active.turnId = pending.params.turnId;
    appendEvent(
      active,
      {
        type: 'sidecar.input_request.resolved',
        threadId: sidecar.threadId,
        turnId: pending.params.turnId,
        itemId: pending.params.itemId,
        data: { requestId },
      },
      emitDiagnostic,
    );
    startOperationTimer(active);
    sidecar.pendingInput = undefined;
    pending.resolve(response);
    return active.promise;
  }

  async function closeSidecar(sidecar: ManagedSidecar): Promise<void> {
    if (sidecar.closeStarted) return;
    sidecar.closeStarted = true;
    sidecar.closed = true;
    byKey.delete(sidecar.key);

    const active = sidecar.active;
    if (active !== undefined && !active.done) {
      if (active.turnId !== undefined) {
        sidecar.ignoredTurnIds.add(active.turnId);
        await interruptTurn(sidecar, active.turnId);
      }
      finishOperation(
        active,
        failureBoundary(sidecar, {
          reason: 'thread_closed',
          message: `Codex sidecar thread '${sidecar.key}' was closed during ${active.kind}`,
          ...(active.turnId !== undefined ? { turnId: active.turnId } : {}),
          events: active.events,
        }),
      );
    }
    if (sidecar.pendingInput !== undefined) {
      sidecar.pendingInput.resolve({ answers: {} });
      sidecar.pendingInput = undefined;
    }
    if (sidecar.ignoredTurnIds.size > 0) {
      closedSidecarsForDiagnostics.set(sidecar.threadId, {
        key: sidecar.key,
        threadId: sidecar.threadId,
        ignoredTurnIds: new Set(sidecar.ignoredTurnIds),
      });
    }

    try {
      await opts.client.request<ThreadUnsubscribeResponse>(METHOD.threadUnsubscribe, {
        threadId: sidecar.threadId,
      } satisfies ThreadUnsubscribeParams);
    } catch (error) {
      emitDiagnostic({
        type: 'sidecar.thread.close.warning',
        key: sidecar.key,
        threadId: sidecar.threadId,
        message: normalizeError(error).message,
      });
    }
    byThreadId.delete(sidecar.threadId);
    emitDiagnostic({
      type: 'sidecar.thread.closed',
      key: sidecar.key,
      ...(sidecar.label !== undefined ? { label: sidecar.label } : {}),
      threadId: sidecar.threadId,
    });
  }

  function handleNotification(method: string, params: unknown): void {
    const notification = normalizeNotification(method, params);
    if (notification === undefined) return;
    const sidecar = byThreadId.get(notification.threadId);
    if (sidecar === undefined) {
      const closed = closedSidecarsForDiagnostics.get(notification.threadId);
      if (
        closed !== undefined &&
        notification.turnId !== undefined &&
        closed.ignoredTurnIds.has(notification.turnId)
      ) {
        emitIgnoredNotificationDiagnostic({
          key: closed.key,
          threadId: closed.threadId,
          turnId: notification.turnId,
          ...(notification.itemId !== undefined ? { itemId: notification.itemId } : {}),
          method,
          params,
        });
      }
      return;
    }
    if (notification.turnId !== undefined && sidecar.ignoredTurnIds.has(notification.turnId)) {
      emitIgnoredNotificationDiagnostic({
        key: sidecar.key,
        threadId: sidecar.threadId,
        turnId: notification.turnId,
        ...(notification.itemId !== undefined ? { itemId: notification.itemId } : {}),
        method,
        params,
      });
      return;
    }
    const active = sidecar.active;
    if (active === undefined || active.done) return;
    if (notification.turnId !== undefined) {
      if (active.turnId !== undefined && active.turnId !== notification.turnId) return;
      active.turnId = notification.turnId;
    }
    appendEvent(active, notification.event, emitDiagnostic);
    if (notification.assistantDelta !== undefined) {
      active.assistantText += notification.assistantDelta;
    }
    if (notification.tokenUsage !== undefined) {
      active.tokenUsage = notification.tokenUsage;
    }
    for (const artifact of notification.artifactsChanged) {
      active.artifactsChanged.add(artifact);
    }
    if (notification.completed) {
      finishOperation(active, {
        ok: true,
        kind: 'completed',
        turn: buildCompletedTurn(active),
      });
    }
  }

  function beginOperation(
    sidecar: ManagedSidecar,
    kind: ActiveOperation['kind'],
    timeoutMs: number,
  ): ActiveOperation {
    let resolveResult: (result: CodexSidecarBoundaryResult) => void = () => undefined;
    const promise = new Promise<CodexSidecarBoundaryResult>((resolvePromise) => {
      resolveResult = resolvePromise;
    });
    const active: ActiveOperation = {
      kind,
      sidecar,
      timeoutMs,
      events: [],
      artifactsChanged: new Set<string>(),
      promise,
      resolve: resolveResult,
      assistantText: '',
      done: false,
    };
    sidecar.active = active;
    return active;
  }

  function startOperationTimer(active: ActiveOperation): void {
    if (active.done || active.timer !== undefined) return;
    active.timer = clock.setTimeout(() => {
      void timeoutOperation(active);
    }, active.timeoutMs);
  }

  async function timeoutOperation(active: ActiveOperation): Promise<void> {
    if (active.done) return;
    if (active.turnId !== undefined) {
      active.sidecar.ignoredTurnIds.add(active.turnId);
      await interruptTurn(active.sidecar, active.turnId);
    }
    emitDiagnostic({
      type: 'sidecar.turn.timeout',
      key: active.sidecar.key,
      threadId: active.sidecar.threadId,
      ...(active.turnId !== undefined ? { turnId: active.turnId } : {}),
    });
    finishOperation(
      active,
      failureBoundary(active.sidecar, {
        reason: 'timeout',
        message: `Codex sidecar thread '${active.sidecar.key}' ${active.kind} timed out after ${String(active.timeoutMs)}ms`,
        ...(active.turnId !== undefined ? { turnId: active.turnId } : {}),
        events: active.events,
      }),
    );
  }

  async function interruptTurn(sidecar: ManagedSidecar, turnId: string): Promise<void> {
    try {
      await opts.client.request<TurnInterruptResponse>(METHOD.turnInterrupt, {
        threadId: sidecar.threadId,
        turnId,
      } satisfies TurnInterruptParams);
    } catch (error) {
      emitDiagnostic({
        type: 'sidecar.turn.interrupt.warning',
        key: sidecar.key,
        threadId: sidecar.threadId,
        turnId,
        message: normalizeError(error).message,
      });
    }
  }

  function finishOperation(active: ActiveOperation, result: CodexSidecarBoundaryResult): void {
    if (active.done) return;
    active.done = true;
    if (active.timer !== undefined) clock.clearTimeout(active.timer);
    if (active.sidecar.active === active) {
      active.sidecar.active = undefined;
    }
    active.resolve(result);
  }

  function emitDiagnostic(diagnostic: CodexSidecarManagerDiagnostic): void {
    opts.onDiagnostic?.(diagnostic);
  }

  function emitIgnoredNotificationDiagnostic(input: {
    readonly key: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId?: string;
    readonly method: string;
    readonly params: unknown;
  }): void {
    emitDiagnostic({
      type: 'sidecar.notification.ignored',
      key: input.key,
      threadId: input.threadId,
      turnId: input.turnId,
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      data: { method: input.method, params: input.params },
    });
  }
}

function prepareThreadOptions<Data>(input: {
  readonly owner: string;
  readonly options: CodexSidecarThreadOptions<Data> | undefined;
  readonly defaultCwd: string;
  readonly activeData: unknown;
  readonly sourceDir: string;
  readonly resolvedSkills: ReadonlyArray<ResolvedRuntimeSkill>;
}): {
  readonly threadStartParams: ThreadStartParams;
  readonly defaultTurnTimeoutMs: number;
  readonly initialSkillItems: ReadonlyArray<UserInput>;
  readonly label?: string;
} {
  const options: CodexSidecarThreadOptions<Data> = input.options ?? {};
  if (!isObjectValue(options)) {
    throw new Error(`${input.owner} options must be an object`);
  }
  const cwd = resolveSidecarCwd<Data>({
    owner: input.owner,
    cwd: options.cwd,
    defaultCwd: input.defaultCwd,
    sourceDir: input.sourceDir,
    activeData: input.activeData as Readonly<Data>,
  });
  const defaultTurnTimeoutMs = validateTimeoutValue(
    input.owner,
    'defaultTurnTimeoutMs',
    options.defaultTurnTimeoutMs ?? CODEX_SIDECAR_DEFAULT_TURN_TIMEOUT_MS,
  );
  const initialSkills = options.initialSkills ?? [];
  if (!Array.isArray(initialSkills)) {
    throw new Error(`${input.owner} initialSkills must be an array of threadSkills keys`);
  }
  const initialSkillItems = selectThreadSkillInput({
    owner: input.owner,
    initialSkills,
    resolvedSkills: input.resolvedSkills,
  }).skillItems;
  const label = validateOptionalString(input.owner, 'label', options.label, {
    nonEmpty: true,
  });
  const model = validateModelOptions(input.owner, options.model);
  const instructions = validateInstructionOptions(input.owner, options.instructions);
  return {
    threadStartParams: {
      cwd,
      ...(model.name !== undefined ? { model: model.name } : {}),
      ...(model.effort !== undefined ? { config: { model_reasoning_effort: model.effort } } : {}),
      ...(instructions.base !== undefined ? { baseInstructions: instructions.base } : {}),
      ...(instructions.developer !== undefined
        ? { developerInstructions: instructions.developer }
        : {}),
    },
    defaultTurnTimeoutMs,
    initialSkillItems,
    ...(label !== undefined ? { label } : {}),
  };
}

function validateThreadKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Codex sidecar thread key must be a non-empty string');
  }
  return key;
}

function validateStartedThreadId(owner: string, response: ThreadStartResponse): string {
  const threadId = response.thread?.id;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error(`${owner} thread/start returned no thread id`);
  }
  return threadId;
}

function resolveSidecarCwd<Data>(input: {
  readonly owner: string;
  readonly cwd: CodexSidecarThreadOptions<Data>['cwd'] | undefined;
  readonly defaultCwd: string;
  readonly sourceDir: string;
  readonly activeData: Readonly<Data>;
}): string {
  if (input.cwd === undefined) return resolve(input.defaultCwd);
  let raw: string;
  if (typeof input.cwd === 'function') {
    try {
      raw = input.cwd(input.activeData);
    } catch (error) {
      const cause = normalizeError(error);
      throw new Error(`${input.owner} cwd function threw: ${cause.message}`, { cause: error });
    }
  } else {
    raw = input.cwd;
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${input.owner} cwd must resolve to a non-empty string`);
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(input.sourceDir, raw);
}

function validateModelOptions(
  owner: string,
  model: CodexSidecarThreadOptions<unknown>['model'],
): { readonly name?: string; readonly effort?: StateModelEffort } {
  if (model === undefined) return {};
  if (!isObjectValue(model)) {
    throw new Error(`${owner} model must be an object`);
  }
  const name = validateOptionalString(owner, 'model.name', model.name, { nonEmpty: true });
  const effort = model.effort;
  if (effort !== undefined && (typeof effort !== 'string' || !stateModelEfforts.has(effort))) {
    throw new Error(
      `${owner} model.effort must be one of: none, minimal, low, medium, high, xhigh`,
    );
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

function validateInstructionOptions(
  owner: string,
  instructions: CodexSidecarThreadOptions<unknown>['instructions'],
): { readonly base?: string; readonly developer?: string } {
  if (instructions === undefined) return {};
  if (!isObjectValue(instructions)) {
    throw new Error(`${owner} instructions must be an object`);
  }
  const base = validateOptionalString(owner, 'instructions.base', instructions.base);
  const developer = validateOptionalString(owner, 'instructions.developer', instructions.developer);
  return {
    ...(base !== undefined ? { base } : {}),
    ...(developer !== undefined ? { developer } : {}),
  };
}

function validateOptionalString(
  owner: string,
  name: string,
  value: unknown,
  opts: { readonly nonEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${owner} ${name} must be a string`);
  }
  if (opts.nonEmpty && value.length === 0) {
    throw new Error(`${owner} ${name} must be a non-empty string`);
  }
  return value;
}

function validateOperationTimeout(sidecar: ManagedSidecar, timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return sidecar.defaultTurnTimeoutMs;
  return validateTimeoutValue(`Codex sidecar thread '${sidecar.key}'`, 'timeoutMs', timeoutMs);
}

function validateTimeoutValue(owner: string, name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${owner} ${name} must be a positive finite number`);
  }
  return value;
}

function normalizeTurnInput(
  sidecar: ManagedSidecar,
  input: string | readonly CodexSidecarInput[],
): ReadonlyArray<UserInput> {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!Array.isArray(input)) {
    throw new Error(`Codex sidecar thread '${sidecar.key}' send input must be a string or array`);
  }
  const mapped: UserInput[] = [];
  input.forEach((item, index) => {
    if (!isPlainObject(item) || typeof item['type'] !== 'string') {
      throw new Error(
        `Codex sidecar thread '${sidecar.key}' send input[${String(index)}] must be a typed input object`,
      );
    }
    const type = item['type'];
    switch (type) {
      case 'text': {
        const text = item['text'];
        if (typeof text !== 'string') {
          throw new Error(
            `Codex sidecar thread '${sidecar.key}' send input[${String(index)}].text must be a string`,
          );
        }
        mapped.push({ type: 'text', text });
        break;
      }
      case 'image': {
        const url = item['url'];
        const detail = normalizeImageDetail(sidecar, index, item['detail']);
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error(
            `Codex sidecar thread '${sidecar.key}' send input[${String(index)}].url must be a non-empty string`,
          );
        }
        mapped.push({
          type: 'image',
          url,
          ...(detail !== undefined ? { detail } : {}),
        });
        break;
      }
      case 'localImage': {
        const path = item['path'];
        const detail = normalizeImageDetail(sidecar, index, item['detail']);
        if (typeof path !== 'string' || path.length === 0) {
          throw new Error(
            `Codex sidecar thread '${sidecar.key}' send input[${String(index)}].path must be a non-empty string`,
          );
        }
        mapped.push({
          type: 'localImage',
          path,
          ...(detail !== undefined ? { detail } : {}),
        });
        break;
      }
      case 'mention': {
        const name = item['name'];
        const path = item['path'];
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error(
            `Codex sidecar thread '${sidecar.key}' send input[${String(index)}].name must be a non-empty string`,
          );
        }
        if (typeof path !== 'string' || path.length === 0) {
          throw new Error(
            `Codex sidecar thread '${sidecar.key}' send input[${String(index)}].path must be a non-empty string`,
          );
        }
        mapped.push({ type: 'mention', name, path });
        break;
      }
      default:
        throw new Error(
          `Codex sidecar thread '${sidecar.key}' send input[${String(index)}] has unsupported type '${type}'`,
        );
    }
  });
  return mapped;
}

function normalizeImageDetail(
  sidecar: ManagedSidecar,
  index: number,
  value: unknown,
): ImageDetail | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'low' || value === 'high' || value === 'original') {
    return value;
  }
  throw new Error(
    `Codex sidecar thread '${sidecar.key}' send input[${String(index)}].detail must be one of: auto, low, high, original`,
  );
}

function createPendingInputRequest(params: ToolRequestUserInputParams): PendingInputRequest {
  const id = `sidecar-input:${params.threadId}:${params.turnId}:${params.itemId}`;
  let resolveReply: (response: ToolRequestUserInputResponse) => void = () => undefined;
  const promise = new Promise<ToolRequestUserInputResponse>((resolvePromise) => {
    resolveReply = resolvePromise;
  });
  return {
    id,
    params,
    request: {
      id,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      questions: params.questions.map(normalizeInputQuestion),
    },
    resolve: resolveReply,
    promise,
  };
}

function normalizeInputQuestion(
  question: ToolRequestUserInputParams['questions'][number],
): CodexSidecarInputRequestQuestion {
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    isOther: question.isOther,
    isSecret: question.isSecret,
    ...(question.options !== undefined
      ? {
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
        }
      : {}),
  };
}

function normalizeAnswerPayload(
  sidecar: ManagedSidecar,
  answers: Readonly<Record<string, string | readonly string[]>>,
): ToolRequestUserInputResponse {
  if (!isPlainObject(answers)) {
    throw new Error(`Codex sidecar thread '${sidecar.key}' answers must be an object`);
  }
  const normalized: ToolRequestUserInputResponse['answers'] = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === 'string') {
      normalized[questionId] = { answers: [value] };
      continue;
    }
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      throw new Error(
        `Codex sidecar thread '${sidecar.key}' answer '${questionId}' must be a string or string array`,
      );
    }
    normalized[questionId] = { answers: [...value] };
  }
  return { answers: normalized };
}

function unavailableBoundary(sidecar: ManagedSidecar): CodexSidecarBoundaryResult | undefined {
  if (!sidecar.closed) return undefined;
  return failureBoundary(sidecar, {
    reason: 'thread_closed',
    message: `Codex sidecar thread '${sidecar.key}' is closed`,
    events: [],
  });
}

function overlappingBoundary(sidecar: ManagedSidecar): CodexSidecarBoundaryResult | undefined {
  const activeOverlap = activeOperationBoundary(sidecar);
  if (activeOverlap !== undefined) return activeOverlap;
  if (sidecar.pendingInput !== undefined) {
    return failureBoundary(sidecar, {
      reason: 'error',
      message: `Codex sidecar thread '${sidecar.key}' is waiting for sidecar input request '${sidecar.pendingInput.id}'`,
      events: [],
    });
  }
  return undefined;
}

function activeOperationBoundary(sidecar: ManagedSidecar): CodexSidecarBoundaryResult | undefined {
  if (sidecar.active === undefined) return undefined;
  return failureBoundary(sidecar, {
    reason: 'error',
    message: `Codex sidecar thread '${sidecar.key}' already has an active operation`,
    events: [],
  });
}

function failureBoundary(
  sidecar: ManagedSidecar,
  input: {
    readonly reason: CodexSidecarFailureReason;
    readonly message: string;
    readonly events: ReadonlyArray<CodexSidecarEvent>;
    readonly turnId?: string;
    readonly cause?: unknown;
  },
): CodexSidecarFailureBoundary {
  return {
    ok: false,
    reason: input.reason,
    message: input.message,
    threadId: sidecar.threadId,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    events: input.events,
    ...(input.reason === 'error' && input.cause !== undefined ? { cause: input.cause } : {}),
  } as CodexSidecarFailureBoundary;
}

function requestFailureMessage(
  sidecar: ManagedSidecar,
  operation: ActiveOperation['kind'],
  error: unknown,
): string {
  if (errorReasonFromRequestError(error) === 'app_server_closed') {
    return `Codex sidecar thread '${sidecar.key}' app-server closed during ${operation}`;
  }
  return `Codex sidecar thread '${sidecar.key}' ${operation} failed: ${normalizeError(error).message}`;
}

function errorReasonFromRequestError(error: unknown): CodexSidecarFailureReason {
  return isAppServerClosedError(error) ? 'app_server_closed' : 'error';
}

function isAppServerClosedError(error: unknown): boolean {
  const message = normalizeError(error).message;
  return /jsonrpc: (client closed|transport closed|closed before response)/.test(message);
}

function appendEvent(
  active: ActiveOperation,
  event: CodexSidecarEvent,
  emitDiagnostic: (diagnostic: CodexSidecarManagerDiagnostic) => void,
): void {
  active.events.push(event);
  const data = isPlainObject(event.data) ? event.data : undefined;
  const requestId =
    typeof data?.['requestId'] === 'string' && data['requestId'].length > 0
      ? data['requestId']
      : undefined;
  emitDiagnostic({
    type: event.type,
    key: active.sidecar.key,
    ...(active.sidecar.label !== undefined ? { label: active.sidecar.label } : {}),
    threadId: event.threadId,
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(event.message !== undefined ? { message: event.message } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
  });
}

function buildCompletedTurn(active: ActiveOperation): CodexSidecarTurn {
  return {
    threadId: active.sidecar.threadId,
    turnId: active.turnId ?? '',
    assistantText: active.assistantText,
    events: [...active.events],
    ...(active.tokenUsage !== undefined ? { tokenUsage: active.tokenUsage } : {}),
    ...(active.artifactsChanged.size > 0
      ? { artifactsChanged: [...active.artifactsChanged].sort() }
      : {}),
  };
}

function normalizeNotification(
  method: string,
  params: unknown,
):
  | {
      readonly threadId: string;
      readonly turnId?: string;
      readonly itemId?: string;
      readonly event: CodexSidecarEvent;
      readonly completed: boolean;
      readonly assistantDelta?: string;
      readonly tokenUsage?: unknown;
      readonly artifactsChanged: readonly string[];
    }
  | undefined {
  if (!isPlainObject(params)) return undefined;
  switch (method) {
    case METHOD.turnStarted: {
      const p = params as TurnStartedNotification['params'];
      if (!isThreadTurnSnapshotParams(p)) return undefined;
      return {
        threadId: p.threadId,
        turnId: p.turn.id,
        event: { type: 'sidecar.turn.started', threadId: p.threadId, turnId: p.turn.id },
        completed: false,
        artifactsChanged: [],
      };
    }
    case METHOD.turnCompleted: {
      const p = params as TurnCompletedNotification['params'];
      if (!isThreadTurnSnapshotParams(p)) return undefined;
      return {
        threadId: p.threadId,
        turnId: p.turn.id,
        event: { type: 'sidecar.turn.completed', threadId: p.threadId, turnId: p.turn.id },
        completed: true,
        artifactsChanged: [],
      };
    }
    case METHOD.itemStarted: {
      const p = params as ItemStartedNotification['params'];
      if (!isThreadTurnItemParams(p)) return undefined;
      if (typeof p.item.id !== 'string') return undefined;
      const itemId = p.item.id;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId,
        event: {
          type: 'sidecar.item.started',
          threadId: p.threadId,
          turnId: p.turnId,
          itemId,
          data: { item: p.item },
        },
        completed: false,
        artifactsChanged: [],
      };
    }
    case METHOD.itemCompleted: {
      const p = params as ItemCompletedNotification['params'];
      if (!isThreadTurnItemParams(p)) return undefined;
      if (typeof p.item.id !== 'string') return undefined;
      const itemId = p.item.id;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId,
        event: {
          type: 'sidecar.item.completed',
          threadId: p.threadId,
          turnId: p.turnId,
          itemId,
          data: { item: p.item },
        },
        completed: false,
        artifactsChanged: fileChangePaths(p.item),
      };
    }
    case METHOD.fileChangePatchUpdated: {
      const p = params as FileChangePatchUpdatedNotification['params'];
      if (!isFileChangePatchUpdatedParams(p)) return undefined;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        event: {
          type: 'sidecar.item.fileChange.patchUpdated',
          threadId: p.threadId,
          turnId: p.turnId,
          itemId: p.itemId,
          data: { changes: p.changes },
        },
        completed: false,
        artifactsChanged: p.changes.map((change) => change.path),
      };
    }
    case METHOD.agentMessageDelta: {
      const p = params as AgentMessageDeltaNotification['params'];
      if (!isAgentMessageDeltaParams(p)) return undefined;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        event: {
          type: 'sidecar.agentMessage.delta',
          threadId: p.threadId,
          turnId: p.turnId,
          itemId: p.itemId,
          message: p.delta,
        },
        completed: false,
        assistantDelta: p.delta,
        artifactsChanged: [],
      };
    }
    case METHOD.rawResponseItemCompleted: {
      const p = params as RawResponseItemCompletedNotification['params'];
      if (!isRawResponseItemCompletedParams(p)) return undefined;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        event: {
          type: 'sidecar.rawResponseItem.completed',
          threadId: p.threadId,
          turnId: p.turnId,
          data: { item: p.item },
        },
        completed: false,
        artifactsChanged: [],
      };
    }
    case METHOD.threadTokenUsageUpdated: {
      const p = params as ThreadTokenUsageUpdatedNotification['params'];
      if (!isThreadTokenUsageUpdatedParams(p)) return undefined;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        event: {
          type: 'sidecar.token.updated',
          threadId: p.threadId,
          turnId: p.turnId,
          data: { tokenUsage: p.tokenUsage },
        },
        completed: false,
        tokenUsage: p.tokenUsage,
        artifactsChanged: [],
      };
    }
    default:
      method satisfies Exclude<string, ServerNotification['method']>;
      return undefined;
  }
}

function fileChangePaths(item: ItemCompletedNotification['params']['item']): readonly string[] {
  const changes = item.type === 'fileChange' ? item.changes : undefined;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change: unknown) =>
    isPlainObject(change) && typeof change['path'] === 'string' ? [change['path']] : [],
  );
}

function isToolRequestUserInputParams(value: unknown): value is ToolRequestUserInputParams {
  if (!isPlainObject(value)) return false;
  const record = value;
  return (
    typeof record['threadId'] === 'string' &&
    typeof record['turnId'] === 'string' &&
    typeof record['itemId'] === 'string' &&
    Array.isArray(record['questions'])
  );
}

function isThreadTurnSnapshotParams(
  value: unknown,
): value is TurnStartedNotification['params'] | TurnCompletedNotification['params'] {
  if (!isPlainObject(value) || !isPlainObject(value['turn'])) return false;
  const turn = value['turn'];
  return typeof value['threadId'] === 'string' && typeof turn['id'] === 'string';
}

function isThreadTurnItemParams(
  value: unknown,
): value is ItemStartedNotification['params'] | ItemCompletedNotification['params'] {
  if (!isPlainObject(value) || !isPlainObject(value['item'])) return false;
  const item = value['item'];
  return (
    typeof value['threadId'] === 'string' &&
    typeof value['turnId'] === 'string' &&
    typeof item['id'] === 'string'
  );
}

function isFileChangePatchUpdatedParams(
  value: unknown,
): value is FileChangePatchUpdatedNotification['params'] {
  return (
    isPlainObject(value) &&
    typeof value['threadId'] === 'string' &&
    typeof value['turnId'] === 'string' &&
    typeof value['itemId'] === 'string' &&
    Array.isArray(value['changes'])
  );
}

function isAgentMessageDeltaParams(
  value: unknown,
): value is AgentMessageDeltaNotification['params'] {
  return (
    isPlainObject(value) &&
    typeof value['threadId'] === 'string' &&
    typeof value['turnId'] === 'string' &&
    typeof value['itemId'] === 'string' &&
    typeof value['delta'] === 'string'
  );
}

function isRawResponseItemCompletedParams(
  value: unknown,
): value is RawResponseItemCompletedNotification['params'] {
  return (
    isPlainObject(value) &&
    typeof value['threadId'] === 'string' &&
    typeof value['turnId'] === 'string' &&
    isPlainObject(value['item'])
  );
}

function isThreadTokenUsageUpdatedParams(
  value: unknown,
): value is ThreadTokenUsageUpdatedNotification['params'] {
  return (
    isPlainObject(value) &&
    typeof value['threadId'] === 'string' &&
    typeof value['turnId'] === 'string' &&
    isPlainObject(value['tokenUsage'])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isObjectValue(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
