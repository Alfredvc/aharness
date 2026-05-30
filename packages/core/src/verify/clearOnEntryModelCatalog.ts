import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AnyStateMachine } from 'xstate';

import { spawnAppServer, type AppServerHandle } from '../appServer/index.js';
import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type {
  ConfigReadParams,
  ConfigReadResponse,
  ModelCatalogEntry,
  ModelListParams,
  ModelListResponse,
} from '../protocol/types.js';
import { DAEMON_PROBE_CLIENT_NAME } from '../protocol/types.js';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import type { StateModelEffort } from '../state/exits.js';
import { connectHeadlessWs } from '../transport/wsClient.js';

export type StateModelCatalogIssueCheck =
  | 'state-model-available'
  | 'state-model-effort-supported'
  | 'state-model-catalog-probe';

export interface StateModelCatalogIssue {
  readonly check: StateModelCatalogIssueCheck;
  readonly stateId: string;
  readonly severity: 'error';
  readonly message: string;
}

export interface CodexConfigModelProvider {
  readConfig(params: ConfigReadParams): Promise<ConfigReadResponse>;
  listModels(params: ModelListParams): Promise<ModelListResponse>;
  close?(): Promise<void>;
}

export type CodexConfigModelProviderFactory = () => Promise<CodexConfigModelProvider>;

export interface VerifyStateModelCatalogOpts {
  readonly machine: AnyStateMachine;
  readonly defaultCwd?: string;
  readonly providerFactory: CodexConfigModelProviderFactory;
}

export interface StateModelCatalogSelection {
  readonly stateId: string;
  readonly model?: string;
  readonly effort?: StateModelEffort;
  readonly cwd?: string;
}

export interface ValidateStateModelCatalogSelectionOpts extends StateModelCatalogSelection {
  readonly provider: CodexConfigModelProvider;
  readonly models?: ReadonlyArray<ModelCatalogEntry>;
  readonly mode?: 'verify' | 'preflight';
}

interface StateModelCatalogDeclaration {
  readonly stateId: string;
  readonly model?: string;
  readonly effort?: StateModelEffort;
}

export async function verifyStateModelCatalog(
  opts: VerifyStateModelCatalogOpts,
): Promise<ReadonlyArray<StateModelCatalogIssue>> {
  const declarations = collectStateModelDeclarations(opts.machine);
  const checks = declarations.filter((decl) => requiresVerifyTimeCatalogCheck(decl));
  if (checks.length === 0) return [];

  let provider: CodexConfigModelProvider;
  try {
    provider = await opts.providerFactory();
  } catch (error) {
    return catalogProbeIssues(
      checks,
      `state-model catalog could not start Codex model catalog probe: ${formatErrorMessage(error)}`,
    );
  }

  try {
    let models: ReadonlyArray<ModelCatalogEntry>;
    try {
      models = await readAllModels(provider);
    } catch (error) {
      return catalogProbeIssues(
        checks,
        `state-model catalog could not read Codex model/list: ${formatErrorMessage(error)}`,
      );
    }
    const issues: StateModelCatalogIssue[] = [];

    for (const decl of checks) {
      issues.push(
        ...(await validateStateModelCatalogSelection({
          provider,
          models,
          mode: 'verify',
          stateId: decl.stateId,
          ...(decl.model !== undefined ? { model: decl.model } : {}),
          ...(decl.effort !== undefined ? { effort: decl.effort } : {}),
        })),
      );
    }

    return issues;
  } finally {
    try {
      await provider.close?.();
    } catch {
      // A cleanup failure should not replace the verifier issue that was already produced.
    }
  }
}

export async function createCodexConfigModelProvider(): Promise<CodexConfigModelProvider> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'aharness-verify-codex-'));
  const sockPath = join(tmpRoot, 'codex.sock');
  let appServer: AppServerHandle | undefined;
  let client: JsonRpcClient | undefined;
  let closeWs: (() => Promise<void>) | undefined;
  try {
    appServer = await spawnAppServer({ sockPath });
    const connected = await connectHeadlessWs({
      sockPath,
      clientInfo: { name: DAEMON_PROBE_CLIENT_NAME, version: '0.1.0' },
    });
    client = connected.client;
    closeWs = connected.close;
  } catch (error) {
    await appServer?.close();
    await rm(tmpRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    readConfig(params) {
      return requireClient(client).request<ConfigReadResponse>(METHOD.configRead, params);
    },
    listModels(params) {
      return requireClient(client).request<ModelListResponse>(METHOD.modelList, params);
    },
    async close() {
      try {
        await closeWs?.();
      } finally {
        try {
          await appServer?.close();
        } finally {
          await rm(tmpRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

export async function validateStateModelCatalogSelection(
  opts: ValidateStateModelCatalogSelectionOpts,
): Promise<ReadonlyArray<StateModelCatalogIssue>> {
  if (opts.model === undefined && opts.effort === undefined) return [];
  const effort = opts.effort;

  if (opts.model !== undefined) {
    const models = opts.models ?? (await readAllModels(opts.provider));
    const model = models.find((entry) => entry.model === opts.model);
    if (model === undefined) {
      return [
        {
          check: 'state-model-available',
          severity: 'error',
          stateId: opts.stateId,
          message: `state.model name "${opts.model}" is not available in Codex model/list`,
        },
      ];
    }
    return validateEffort(
      {
        stateId: opts.stateId,
        model: opts.model,
        ...(effort !== undefined ? { effort } : {}),
      },
      model,
    );
  }

  if (opts.mode === 'verify') return [];
  if (effort === undefined) return [];

  const cwd = opts.cwd;
  if (cwd === undefined) {
    return [
      {
        check: 'state-model-catalog-probe',
        severity: 'error',
        stateId: opts.stateId,
        message: `state.model.effort "${effort}" cannot be validated because cwd is data-dependent`,
      },
    ];
  }

  const config = await readConfigIssueSafe(opts.provider, {
    stateId: opts.stateId,
    cwd,
    effort,
  });
  if ('issue' in config) return [config.issue];

  const models = opts.models ?? (await readAllModels(opts.provider));
  const targetModel = resolveEffectiveModel(config.response, models);
  if (targetModel === undefined) {
    return [
      {
        check: 'state-model-catalog-probe',
        severity: 'error',
        stateId: opts.stateId,
        message:
          `state.model.effort "${effort}" cannot be validated ` +
          'because Codex config/read did not return a model and model/list returned no default',
      },
    ];
  }

  const model = models.find((entry) => entry.model === targetModel);
  if (model === undefined) {
    return [
      {
        check: 'state-model-available',
        severity: 'error',
        stateId: opts.stateId,
        message:
          `state.model.effort "${effort}" resolved model ` +
          `"${targetModel}", but that model is not available in Codex model/list`,
      },
    ];
  }

  return validateEffort(
    {
      stateId: opts.stateId,
      model: targetModel,
      effort,
    },
    model,
  );
}

function collectStateModelDeclarations(
  machine: AnyStateMachine,
): ReadonlyArray<StateModelCatalogDeclaration> {
  const declarations: StateModelCatalogDeclaration[] = [];
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta || meta.kind !== 'stateful' || meta.model === undefined) continue;
    const model = meta.model;
    const modelName = model.name;
    const modelEffort = model.effort;
    if (modelName === undefined && modelEffort === undefined) continue;
    declarations.push({
      stateId: stateKeyPath(node),
      ...(modelName !== undefined ? { model: modelName } : {}),
      ...(modelEffort !== undefined ? { effort: modelEffort } : {}),
    });
  }
  return declarations;
}

function requiresVerifyTimeCatalogCheck(decl: StateModelCatalogDeclaration): boolean {
  return decl.model !== undefined;
}

function catalogProbeIssues(
  declarations: ReadonlyArray<StateModelCatalogDeclaration>,
  message: string,
): ReadonlyArray<StateModelCatalogIssue> {
  return declarations.map((decl) => ({
    check: 'state-model-catalog-probe',
    severity: 'error',
    stateId: decl.stateId,
    message,
  }));
}

async function readAllModels(
  provider: CodexConfigModelProvider,
): Promise<ReadonlyArray<ModelCatalogEntry>> {
  const models: ModelCatalogEntry[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await provider.listModels({
      includeHidden: true,
      ...(cursor ? { cursor } : {}),
    });
    models.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return models;
}

async function readConfigIssueSafe(
  provider: CodexConfigModelProvider,
  decl: {
    readonly stateId: string;
    readonly cwd: string;
    readonly effort: StateModelEffort;
  },
): Promise<{ readonly response: ConfigReadResponse } | { readonly issue: StateModelCatalogIssue }> {
  try {
    return {
      response: await provider.readConfig({
        cwd: decl.cwd,
      }),
    };
  } catch (error) {
    return {
      issue: {
        check: 'state-model-catalog-probe',
        severity: 'error',
        stateId: decl.stateId,
        message:
          `state.model.effort "${decl.effort}" could not read ` +
          `Codex config for cwd "${decl.cwd}": ${formatErrorMessage(error)}`,
      },
    };
  }
}

function resolveEffectiveModel(
  response: ConfigReadResponse,
  models: ReadonlyArray<ModelCatalogEntry>,
): string | undefined {
  const configModel = response.config.model;
  if (typeof configModel === 'string' && configModel.length > 0) {
    return configModel;
  }
  return models.find((model) => model.isDefault)?.model ?? models[0]?.model;
}

function validateEffort(
  decl: {
    readonly stateId: string;
    readonly model: string;
    readonly effort?: StateModelEffort;
  },
  model: ModelCatalogEntry,
): ReadonlyArray<StateModelCatalogIssue> {
  if (decl.effort === undefined) return [];
  const supported = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (supported.includes(decl.effort)) return [];
  return [
    {
      check: 'state-model-effort-supported',
      severity: 'error',
      stateId: decl.stateId,
      message:
        `state.model.effort "${decl.effort}" is not supported by model ` +
        `"${decl.model}"; supported values: ${formatSupportedEfforts(supported)}`,
    },
  ];
}

function formatSupportedEfforts(values: ReadonlyArray<string>): string {
  return values.length > 0 ? values.join(', ') : '(none advertised)';
}

function requireClient(client: JsonRpcClient | undefined): JsonRpcClient {
  if (client === undefined) throw new Error('Codex model catalog provider is closed');
  return client;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
