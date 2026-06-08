import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  spawnAppServer as realSpawnAppServer,
  type AppServerHandle,
  type SpawnAppServerOptions,
} from '../appServer/index.js';
import { checkCodexVersion, type VersionGateResult } from '../appServer/version.js';
import { resolveCodexAuthFile } from '../codexHome/index.js';
import { loadFsm, loadInstalledFsm } from '../loader/index.js';
import type { RunEventEnvelope } from '../runEvents/index.js';
import { connectHeadlessWs } from '../transport/wsClient.js';
import { launchBrowser } from '../ui/browserLauncher.js';
import type {
  BrowserReplyController,
  BrowserReplyPayload,
  BrowserReplyResult,
} from '../ui/reply.js';
import { startUiServer } from '../ui/server.js';

import {
  runLiveRunEngine,
  type LiveRunAuthPrecheckResult,
  type LiveRunCancellationRequest,
  type LiveRunCancellationSignal,
  type LiveRunEngineOptions,
  type LiveRunEngineResult,
  type LiveRunInputResult,
  type LiveRunLoadedFsm,
  type LiveRunReporter,
} from './liveRunEngine.js';
import { normalizeProgrammaticRunInput } from './runInput.js';
import {
  buildInstalledFsmLoadOptions,
  resolveFsmTarget,
  type ResolveFsmTargetOptions,
  type ResolvedFsmTarget,
} from './runTarget.js';

const exec = promisify(execFile);

export type AharnessRunPermissionMode = 'autoReview' | 'ask' | 'yolo';

export type AharnessRunUiOption =
  | boolean
  | {
      readonly open?: boolean;
    };

export interface StartAharnessRunOptions {
  readonly target: string;
  readonly cwd?: string;
  readonly input?: Record<string, unknown>;
  readonly permissionMode?: AharnessRunPermissionMode;
  readonly ui?: AharnessRunUiOption;
  readonly onEvent?: (event: AharnessRunEvent, run: AharnessRunHandle) => void | Promise<void>;
}

export type AharnessRunEvent = RunEventEnvelope;

export interface AharnessOwnerChoiceInput {
  readonly state: string;
  readonly visitCount: number;
  readonly label: string;
}

export interface AharnessOwnerInputAnswer {
  readonly requestId: string;
  readonly answers: Record<string, string>;
}

export type AharnessApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface AharnessApprovalResolution {
  readonly requestId: string;
  readonly decision: AharnessApprovalDecision;
}

export interface AharnessPermissionResolution {
  readonly requestId: string;
  readonly decision: AharnessApprovalDecision;
}

export type AharnessElicitationAction = 'accept' | 'decline' | 'cancel';

export interface AharnessElicitationResolution {
  readonly requestId: string;
  readonly action: AharnessElicitationAction;
  readonly values?: Record<string, unknown>;
}

export interface AharnessRunReplyResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

export type AharnessRunStatus = 'completed' | 'failed' | 'cancelled';

export interface AharnessRunResult {
  readonly status: AharnessRunStatus;
  readonly exitCode: number;
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly terminalState?: string;
  readonly terminalOutcome?: string;
  readonly reason?: string;
}

export interface AharnessRunHandle {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly uiUrl?: string | undefined;

  subscribe(
    listener: (event: AharnessRunEvent, run: AharnessRunHandle) => void | Promise<void>,
  ): () => void;

  sendText(text: string): Promise<AharnessRunReplyResult>;
  chooseOwnerOption(input: AharnessOwnerChoiceInput): Promise<AharnessRunReplyResult>;
  answerOwnerInput(input: AharnessOwnerInputAnswer): Promise<AharnessRunReplyResult>;
  resolveApproval(input: AharnessApprovalResolution): Promise<AharnessRunReplyResult>;
  resolvePermission(input: AharnessPermissionResolution): Promise<AharnessRunReplyResult>;
  resolveElicitation(input: AharnessElicitationResolution): Promise<AharnessRunReplyResult>;

  cancel(reason?: string): Promise<void>;
  result(): Promise<AharnessRunResult>;
}

interface RunHandleInfo {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
}

interface ProgrammaticTargetRuntime {
  readonly targetLabel: string;
  readonly metadata: {
    readonly filePath: string;
    readonly repoRoot: string;
  };
  readonly verify: LiveRunEngineOptions['verify'];
  readonly loadFsm: LiveRunEngineOptions['loadFsm'];
}

interface DiagnosticBuffer {
  readonly stream: NodeJS.WritableStream;
  text(): string;
}

interface EventSubscription {
  readonly listener: (event: AharnessRunEvent, run: AharnessRunHandle) => void | Promise<void>;
  closed: boolean;
  queue: Promise<void>;
}

interface ProgrammaticCancellationController {
  readonly signal: LiveRunCancellationSignal;
  readonly request: (reason?: string) => boolean;
  readonly current: () => LiveRunCancellationRequest | null;
}

export interface StartAharnessRunTestHooks {
  readonly resolveFsmTargetImpl?: typeof resolveFsmTarget;
  readonly verify?: LiveRunEngineOptions['verify'];
  readonly versionGate?: () => Promise<VersionGateResult>;
  readonly loadFsmImpl?: typeof loadFsm;
  readonly loadInstalledFsmImpl?: typeof loadInstalledFsm;
  readonly authJsonExists?: () => boolean;
  readonly spawnAppServer?: (opts: SpawnAppServerOptions) => Promise<AppServerHandle>;
  readonly connectHeadlessWsImpl?: typeof connectHeadlessWs;
  readonly startUiServerImpl?: typeof startUiServer;
  readonly launchBrowserImpl?: typeof launchBrowser;
  readonly runLiveRunEngineImpl?: typeof runLiveRunEngine;
  readonly diagnostics?: NodeJS.WritableStream;
  readonly resolveTargetOptions?: ResolveFsmTargetOptions;
}

export function startAharnessRun(options: StartAharnessRunOptions): Promise<AharnessRunHandle> {
  return startAharnessRunInternal(options, {});
}

export function startAharnessRunForTest(
  options: StartAharnessRunOptions,
  hooks: StartAharnessRunTestHooks = {},
): Promise<AharnessRunHandle> {
  return startAharnessRunInternal(options, hooks);
}

function createProgrammaticCancellationController(): ProgrammaticCancellationController {
  let currentRequest: LiveRunCancellationRequest | null = null;
  const listeners = new Set<(request: LiveRunCancellationRequest) => void>();

  const signal: LiveRunCancellationSignal = {
    current() {
      return currentRequest;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    signal,
    request(reason) {
      if (currentRequest !== null) return false;
      currentRequest = {
        ...(reason !== undefined ? { reason } : {}),
      };
      for (const listener of listeners) {
        listener(currentRequest);
      }
      return true;
    },
    current() {
      return currentRequest;
    },
  };
}

async function startAharnessRunInternal(
  options: StartAharnessRunOptions,
  hooks: StartAharnessRunTestHooks,
): Promise<AharnessRunHandle> {
  const cwd = options.cwd ?? process.cwd();
  const diagnostics = createDiagnosticBuffer(hooks.diagnostics ?? process.stderr);
  const target = await resolveProgrammaticTarget(options.target, cwd, hooks, diagnostics.stream);
  const ui = normalizeUiOption(options.ui);

  let runInfo: RunHandleInfo | undefined;
  let uiUrl: string | undefined;
  let browserReplyController: BrowserReplyController | undefined;
  let replyQueue: Promise<void> = Promise.resolve();
  const subscriptions = new Set<EventSubscription>();
  const cancellation = createProgrammaticCancellationController();

  let resolveReady!: (handle: AharnessRunHandle) => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  let uiReady = !ui.serve;

  const readyPromise = new Promise<AharnessRunHandle>((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = (handle) => {
      if (readySettled) return;
      readySettled = true;
      resolveReadyPromise(handle);
    };
    rejectReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      rejectReadyPromise(error);
    };
  });

  const engineResultRef: { current?: Promise<AharnessRunResult> } = {};

  const requireRunInfo = (): RunHandleInfo => {
    if (runInfo === undefined) {
      throw new Error('aharness run handle is not ready');
    }
    return runInfo;
  };

  const handle: AharnessRunHandle = {
    get runId() {
      return requireRunInfo().runId;
    },
    get runDir() {
      return requireRunInfo().runDir;
    },
    get eventsPath() {
      return requireRunInfo().eventsPath;
    },
    get uiUrl() {
      return uiUrl;
    },
    subscribe(listener) {
      const subscription: EventSubscription = {
        listener,
        closed: false,
        queue: Promise.resolve(),
      };
      subscriptions.add(subscription);
      return () => {
        subscription.closed = true;
        subscriptions.delete(subscription);
      };
    },
    sendText(text) {
      return submitReply({ kind: 'user-prompt', text });
    },
    chooseOwnerOption(input) {
      return submitReply({ kind: 'owner-choice', ...input });
    },
    answerOwnerInput(input) {
      return submitReply({ kind: 'owner-input', ...input });
    },
    resolveApproval(input) {
      return submitReply({ kind: 'approval', ...input });
    },
    resolvePermission(input) {
      return submitReply({ kind: 'permission', ...input });
    },
    resolveElicitation(input) {
      return submitReply({ kind: 'elicitation', ...input });
    },
    cancel(reason) {
      if (cancellation.request(reason)) {
        browserReplyController?.close();
      }
      return Promise.resolve();
    },
    result() {
      if (engineResultRef.current === undefined) {
        return Promise.reject(new Error('aharness run engine has not started'));
      }
      return engineResultRef.current;
    },
  };

  if (options.onEvent !== undefined) {
    handle.subscribe(options.onEvent);
  }

  const publishToSubscribers = (event: AharnessRunEvent): void => {
    for (const subscription of subscriptions) {
      enqueueEvent(subscription, event);
    }
  };

  const maybeResolveReady = (): void => {
    if (runInfo === undefined || !uiReady) return;
    resolveReady(handle);
  };

  const engineOptions: LiveRunEngineOptions = {
    target: target.metadata,
    verify: target.verify,
    versionGate: hooks.versionGate ?? defaultVersionGate,
    loadFsm: target.loadFsm,
    authPrecheck: () => programmaticAuthPrecheck(cwd, hooks),
    resolveInput: (loaded) => resolveProgrammaticInput(target.targetLabel, options.input, loaded),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ui,
    diagnostics: diagnostics.stream,
    createReporter: () => createProgrammaticReporter(),
    spawnAppServer: hooks.spawnAppServer ?? realSpawnAppServer,
    connectHeadlessWs: hooks.connectHeadlessWsImpl ?? connectHeadlessWs,
    startUiServer: hooks.startUiServerImpl ?? startUiServer,
    launchBrowser: hooks.launchBrowserImpl ?? launchBrowser,
    onRunReady: (info) => {
      runInfo = {
        runId: info.runId,
        runDir: info.runDir,
        eventsPath: info.eventsPath,
      };
      maybeResolveReady();
    },
    onUiReady: (info) => {
      uiUrl = info.url;
      uiReady = true;
      maybeResolveReady();
    },
    onCanonicalAppend: (entry) => {
      publishToSubscribers(entry.event);
    },
    onBrowserReplyController: (controller) => {
      browserReplyController = controller;
    },
    cancellation: cancellation.signal,
    beforeAppServerOpen: waitForReadyHandleContinuation,
  };

  const runEngine = hooks.runLiveRunEngineImpl ?? runLiveRunEngine;
  engineResultRef.current = Promise.resolve()
    .then(() => runEngine(engineOptions))
    .then(
      (result) => {
        if (!readySettled) {
          rejectReady(createPreHandleFailure(result, diagnostics));
        }
        return mapEngineResult(result, () => runInfo ?? runInfoFromEngineResult(result));
      },
      (error: unknown) => {
        const err = asError(error);
        if (!readySettled) {
          rejectReady(err);
        }
        const cancellationRequest = cancellation.current();
        if (cancellationRequest !== null) {
          return mapEngineCancellationError(
            cancellationRequest,
            () => runInfo ?? emptyRunInfo(),
            diagnostics.stream,
          );
        }
        return mapEngineError(err, () => runInfo ?? emptyRunInfo(), diagnostics.stream);
      },
    );

  function enqueueEvent(subscription: EventSubscription, event: AharnessRunEvent): void {
    subscription.queue = subscription.queue
      .then(async () => {
        if (subscription.closed) return;
        await subscription.listener(event, handle);
      })
      .catch((error: unknown) => {
        const err = asError(error);
        diagnostics.stream.write(
          `aharness: programmatic event listener failed for ${event.type}: ${err.message}\n`,
        );
      });
  }

  function submitReply(payload: BrowserReplyPayload): Promise<AharnessRunReplyResult> {
    const currentCancellationRequest = cancellation.current();
    if (currentCancellationRequest !== null) {
      return Promise.resolve(wrapReplyResult(runClosedReplyResult(currentCancellationRequest)));
    }

    const runReply = replyQueue.then(async () => {
      const cancellationRequest = cancellation.current();
      if (cancellationRequest !== null) {
        return wrapReplyResult(runClosedReplyResult(cancellationRequest));
      }

      const controller = browserReplyController;
      if (controller === undefined) {
        return wrapReplyResult({
          status: 503,
          body: { error: 'reply-handler-unavailable' },
        });
      }

      try {
        return wrapReplyResult(await controller.handleReply(payload));
      } catch (error: unknown) {
        const err = asError(error);
        diagnostics.stream.write(
          `aharness: programmatic reply handler failed for ${payload.kind}: ${err.message}\n`,
        );
        return wrapReplyResult({
          status: 500,
          body: { error: 'reply-handler-error', message: err.message },
        });
      }
    });
    replyQueue = runReply.then(
      () => undefined,
      () => undefined,
    );
    return runReply;
  }

  return readyPromise;
}

async function resolveProgrammaticTarget(
  token: string,
  cwd: string,
  hooks: StartAharnessRunTestHooks,
  diagnostics: NodeJS.WritableStream,
): Promise<ProgrammaticTargetRuntime> {
  const resolved = await (hooks.resolveFsmTargetImpl ?? resolveFsmTarget)(token, {
    ...(hooks.resolveTargetOptions?.env !== undefined
      ? { env: hooks.resolveTargetOptions.env }
      : {}),
    ...(hooks.resolveTargetOptions?.homeDir !== undefined
      ? { homeDir: hooks.resolveTargetOptions.homeDir }
      : {}),
    ...(hooks.resolveTargetOptions?.readSnapshotImpl !== undefined
      ? { readSnapshotImpl: hooks.resolveTargetOptions.readSnapshotImpl }
      : {}),
    ...(hooks.resolveTargetOptions?.checkLockFingerprintImpl !== undefined
      ? { checkLockFingerprintImpl: hooks.resolveTargetOptions.checkLockFingerprintImpl }
      : {}),
  });

  if (resolved.kind === 'invalid') {
    throw new Error(formatTargetDiagnostics('aharness run failed', resolved));
  }

  if (resolved.kind === 'local') {
    return {
      targetLabel: token,
      metadata: {
        filePath: resolve(cwd, resolved.target),
        repoRoot: cwd,
      },
      verify: hooks.verify ?? ((input) => defaultVerify(input, diagnostics)),
      loadFsm: hooks.loadFsmImpl ?? loadFsm,
    };
  }

  const loadInstalledFsmImpl = hooks.loadInstalledFsmImpl ?? loadInstalledFsm;
  return {
    targetLabel: token,
    metadata: {
      filePath: resolved.entryFile,
      repoRoot: cwd,
    },
    verify: () => Promise.resolve({ exitCode: 0 }),
    loadFsm: () => loadInstalledFsmImpl(buildInstalledFsmLoadOptions(resolved)),
  };
}

function normalizeUiOption(ui: AharnessRunUiOption | undefined): LiveRunEngineOptions['ui'] {
  if (ui === undefined || ui === false) {
    return { serve: false, openBrowser: false };
  }
  if (ui === true) {
    return { serve: true, openBrowser: false };
  }
  return { serve: true, openBrowser: ui.open === true };
}

function resolveProgrammaticInput(
  targetLabel: string,
  input: Record<string, unknown> | undefined,
  loaded: LiveRunLoadedFsm,
): LiveRunInputResult {
  const result = normalizeProgrammaticRunInput({
    targetLabel,
    ...(input !== undefined ? { input } : {}),
    ...(loaded.inputSchema !== undefined ? { inputSchema: loaded.inputSchema } : {}),
    ...(loaded.inputFlags !== undefined ? { inputFlags: loaded.inputFlags } : {}),
  });
  if (result.ok) {
    return { ok: true, input: result.input };
  }
  return {
    ok: false,
    diagnostic: `aharness: ${result.message}\n`,
    failureReason: result.message,
    exitCode: 2,
  };
}

function programmaticAuthPrecheck(
  cwd: string,
  hooks: StartAharnessRunTestHooks,
): LiveRunAuthPrecheckResult {
  if (hooks.authJsonExists !== undefined) {
    if (hooks.authJsonExists()) return { ok: true };
    const message = '~/.codex/auth.json not found. Run `codex login` first.';
    return {
      ok: false,
      diagnostic: `aharness: ${message}\n`,
      failureReason: message,
      exitCode: 1,
    };
  }

  const auth = resolveCodexAuthFile({ cwd });
  if (auth.ok) return { ok: true };
  return {
    ok: false,
    diagnostic: auth.message,
    failureReason: auth.message,
    exitCode: 1,
  };
}

function createProgrammaticReporter(): LiveRunReporter {
  return {
    runStarting: () => undefined,
    browserReady: () => undefined,
    codexLaunching: () => undefined,
    codexReady: () => undefined,
    transition: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
  };
}

async function defaultVerify(
  o: {
    readonly fsmPath: string;
    readonly repoRoot: string;
  },
  diagnostics: NodeJS.WritableStream,
): Promise<{ readonly exitCode: number }> {
  const { runVerifyCli } = await import('../cli/verifyCli.js');
  const r = await runVerifyCli({
    fsmPath: o.fsmPath,
    repoRoot: o.repoRoot,
    log: (line) => diagnostics.write(`${line}\n`),
  });
  return { exitCode: r.exitCode };
}

async function defaultVersionGate(): Promise<VersionGateResult> {
  return checkCodexVersion(async (cmd, args) => {
    const r = await exec(cmd, args.slice());
    return { stdout: r.stdout, status: 0 };
  });
}

function wrapReplyResult(result: BrowserReplyResult): AharnessRunReplyResult {
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    body: result.body,
  };
}

function runClosedReplyResult(request: LiveRunCancellationRequest): BrowserReplyResult {
  return {
    status: 409,
    body: {
      error: 'run-closed',
      status: 'cancelled',
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    },
  };
}

function waitForReadyHandleContinuation(): Promise<void> {
  return new Promise((resolveWait) => {
    setImmediate(resolveWait);
  });
}

function mapEngineResult(
  result: LiveRunEngineResult,
  requireRunInfo: () => RunHandleInfo,
): AharnessRunResult {
  const info = requireRunInfo();
  const status: AharnessRunStatus =
    result.status === 'cancelled' || result.terminalOutcome === 'cancelled'
      ? 'cancelled'
      : result.exitCode === 0 && result.terminalOutcome !== 'failure'
        ? 'completed'
        : 'failed';
  return {
    status,
    exitCode: result.exitCode,
    runId: info.runId,
    runDir: info.runDir,
    eventsPath: info.eventsPath,
    ...(result.terminalState !== undefined ? { terminalState: result.terminalState } : {}),
    ...(result.terminalOutcome !== undefined ? { terminalOutcome: result.terminalOutcome } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}

function mapEngineError(
  error: Error,
  requireRunInfo: () => RunHandleInfo,
  diagnostics: NodeJS.WritableStream,
): AharnessRunResult {
  diagnostics.write(`aharness: programmatic run engine failed: ${error.message}\n`);
  const info = requireRunInfo();
  return {
    status: 'failed',
    exitCode: 1,
    runId: info.runId,
    runDir: info.runDir,
    eventsPath: info.eventsPath,
    reason: error.message,
  };
}

function mapEngineCancellationError(
  request: LiveRunCancellationRequest,
  requireRunInfo: () => RunHandleInfo,
  diagnostics: NodeJS.WritableStream,
): AharnessRunResult {
  diagnostics.write('aharness: programmatic run engine stopped after cancellation\n');
  const info = requireRunInfo();
  return {
    status: 'cancelled',
    exitCode: 130,
    runId: info.runId,
    runDir: info.runDir,
    eventsPath: info.eventsPath,
    terminalOutcome: 'cancelled',
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  };
}

function createPreHandleFailure(result: LiveRunEngineResult, diagnostics: DiagnosticBuffer): Error {
  const text = diagnostics.text().trim();
  if (text.length > 0) {
    return new Error(text);
  }
  return new Error(`aharness run failed before handle was ready (exit code ${result.exitCode})`);
}

function runInfoFromEngineResult(result: LiveRunEngineResult): RunHandleInfo {
  return {
    runId: result.runId ?? '',
    runDir: result.runDir ?? '',
    eventsPath: result.eventsPath ?? '',
  };
}

function emptyRunInfo(): RunHandleInfo {
  return { runId: '', runDir: '', eventsPath: '' };
}

function createDiagnosticBuffer(delegate: NodeJS.WritableStream): DiagnosticBuffer {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        chunks.push(text);
        delegate.write(text);
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

function formatTargetDiagnostics(
  heading: string,
  resolved: Extract<ResolvedFsmTarget, { kind: 'invalid' }>,
): string {
  const lines = [`${heading}:`];
  for (const diagnostic of resolved.diagnostics) {
    const where =
      diagnostic.field ??
      diagnostic.path ??
      diagnostic.commandName ??
      diagnostic.alternatives?.join(', ');
    lines.push(`  - ${where ? `${where}: ` : ''}[${diagnostic.code}] ${diagnostic.message}`);
  }
  return lines.join('\n');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
