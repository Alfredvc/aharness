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
import type { ClearOnEntryMeta, ClearOnEntryReasoningEffort } from '../state/exits.js';
import { connectHeadlessWs } from '../transport/wsClient.js';

export type ClearOnEntryCatalogIssueCheck =
  | 'clearOnEntry-model-available'
  | 'clearOnEntry-reasoning-effort-supported'
  | 'clearOnEntry-model-catalog-probe';

export interface ClearOnEntryCatalogIssue {
  readonly check: ClearOnEntryCatalogIssueCheck;
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

export interface VerifyClearOnEntryModelCatalogOpts {
  readonly machine: AnyStateMachine;
  readonly defaultCwd: string;
  readonly providerFactory: CodexConfigModelProviderFactory;
}

export interface ClearOnEntryModelCatalogSelection {
  readonly stateId: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly reasoningEffort?: ClearOnEntryReasoningEffort;
}

export interface ValidateClearOnEntryModelCatalogSelectionOpts extends ClearOnEntryModelCatalogSelection {
  readonly provider: CodexConfigModelProvider;
  readonly models?: ReadonlyArray<ModelCatalogEntry>;
}

interface CatalogDeclaration {
  readonly stateId: string;
  readonly model?: string;
  readonly reasoningEffort?: ClearOnEntryReasoningEffort;
  readonly cwd: { readonly kind: 'static'; readonly value: string } | { readonly kind: 'dynamic' };
}

export async function verifyClearOnEntryModelCatalog(
  opts: VerifyClearOnEntryModelCatalogOpts,
): Promise<ReadonlyArray<ClearOnEntryCatalogIssue>> {
  const declarations = collectCatalogDeclarations(opts.machine, opts.defaultCwd);
  const checks = declarations.filter((decl) => requiresVerifyTimeCatalogCheck(decl));
  if (checks.length === 0) return [];

  let provider: CodexConfigModelProvider;
  try {
    provider = await opts.providerFactory();
  } catch (error) {
    return catalogProbeIssues(
      checks,
      `clearOnEntry model catalog could not start Codex model catalog probe: ${formatErrorMessage(
        error,
      )}`,
    );
  }

  try {
    let models: ReadonlyArray<ModelCatalogEntry>;
    try {
      models = await readAllModels(provider);
    } catch (error) {
      return catalogProbeIssues(
        checks,
        `clearOnEntry model catalog could not read Codex model/list: ${formatErrorMessage(error)}`,
      );
    }
    const issues: ClearOnEntryCatalogIssue[] = [];

    for (const decl of checks) {
      issues.push(
        ...(await validateClearOnEntryModelCatalogSelection({
          provider,
          models,
          stateId: decl.stateId,
          ...(decl.cwd.kind === 'static' ? { cwd: decl.cwd.value } : {}),
          ...(decl.model !== undefined ? { model: decl.model } : {}),
          ...(decl.reasoningEffort !== undefined ? { reasoningEffort: decl.reasoningEffort } : {}),
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

export async function validateClearOnEntryModelCatalogSelection(
  opts: ValidateClearOnEntryModelCatalogSelectionOpts,
): Promise<ReadonlyArray<ClearOnEntryCatalogIssue>> {
  if (opts.model === undefined && opts.reasoningEffort === undefined) return [];

  if (opts.model !== undefined) {
    const models = opts.models ?? (await readAllModels(opts.provider));
    const model = models.find((entry) => entry.model === opts.model);
    if (model === undefined) {
      return [
        {
          check: 'clearOnEntry-model-available',
          severity: 'error',
          stateId: opts.stateId,
          message: `clearOnEntry.model "${opts.model}" is not available in Codex model/list`,
        },
      ];
    }
    return validateReasoningEffort(
      {
        stateId: opts.stateId,
        model: opts.model,
        ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
        cwd: opts.cwd !== undefined ? { kind: 'static', value: opts.cwd } : { kind: 'dynamic' },
      },
      model,
    );
  }

  if (opts.reasoningEffort === undefined) return [];
  if (opts.cwd === undefined) {
    return [
      {
        check: 'clearOnEntry-model-catalog-probe',
        severity: 'error',
        stateId: opts.stateId,
        message:
          `clearOnEntry.reasoningEffort "${opts.reasoningEffort}" cannot be validated ` +
          'because clearOnEntry.cwd is data-dependent',
      },
    ];
  }

  const config = await readConfigIssueSafe(opts.provider, {
    stateId: opts.stateId,
    cwd: opts.cwd,
    reasoningEffort: opts.reasoningEffort,
  });
  if ('issue' in config) return [config.issue];

  const models = opts.models ?? (await readAllModels(opts.provider));
  const targetModel = resolveEffectiveModel(config.response, models);
  if (targetModel === undefined) {
    return [
      {
        check: 'clearOnEntry-model-catalog-probe',
        severity: 'error',
        stateId: opts.stateId,
        message:
          `clearOnEntry.reasoningEffort "${opts.reasoningEffort}" cannot be validated ` +
          'because Codex config/read did not return a model and model/list returned no default',
      },
    ];
  }
  const model = models.find((entry) => entry.model === targetModel);
  if (model === undefined) {
    return [
      {
        check: 'clearOnEntry-model-available',
        severity: 'error',
        stateId: opts.stateId,
        message:
          `clearOnEntry.reasoningEffort "${opts.reasoningEffort}" resolved model ` +
          `"${targetModel}", but that model is not available in Codex model/list`,
      },
    ];
  }
  return validateReasoningEffort(
    {
      stateId: opts.stateId,
      model: targetModel,
      reasoningEffort: opts.reasoningEffort,
      cwd: { kind: 'static', value: opts.cwd },
    },
    model,
  );
}

function collectCatalogDeclarations(
  machine: AnyStateMachine,
  defaultCwd: string,
): ReadonlyArray<CatalogDeclaration> {
  const declarations: CatalogDeclaration[] = [];
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (!meta || meta.kind !== 'stateful') continue;
    const clearOnEntry = meta.clearOnEntry;
    if (clearOnEntry === undefined || clearOnEntry === true) continue;
    const model = clearOnEntry.model;
    const reasoningEffort = clearOnEntry.reasoningEffort;
    if (model === undefined && reasoningEffort === undefined) continue;
    declarations.push({
      stateId: stateKeyPath(node),
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      cwd: resolveStaticCwd(clearOnEntry, defaultCwd),
    });
  }
  return declarations;
}

function resolveStaticCwd(
  clearOnEntry: Exclude<ClearOnEntryMeta, true>,
  defaultCwd: string,
): CatalogDeclaration['cwd'] {
  if (!Object.prototype.hasOwnProperty.call(clearOnEntry, 'cwd')) {
    return { kind: 'static', value: defaultCwd };
  }
  const cwd = clearOnEntry.cwd;
  if (typeof cwd === 'function') return { kind: 'dynamic' };
  return { kind: 'static', value: cwd ?? defaultCwd };
}

function requiresVerifyTimeCatalogCheck(decl: CatalogDeclaration): boolean {
  if (decl.model !== undefined) return true;
  return decl.reasoningEffort !== undefined && decl.cwd.kind === 'static';
}

function catalogProbeIssues(
  declarations: ReadonlyArray<CatalogDeclaration>,
  message: string,
): ReadonlyArray<ClearOnEntryCatalogIssue> {
  return declarations.map((decl) => ({
    check: 'clearOnEntry-model-catalog-probe',
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
    readonly reasoningEffort?: ClearOnEntryReasoningEffort;
  },
): Promise<
  { readonly response: ConfigReadResponse } | { readonly issue: ClearOnEntryCatalogIssue }
> {
  try {
    return {
      response: await provider.readConfig({
        cwd: decl.cwd,
      }),
    };
  } catch (error) {
    return {
      issue: {
        check: 'clearOnEntry-model-catalog-probe',
        severity: 'error',
        stateId: decl.stateId,
        message:
          `clearOnEntry.reasoningEffort "${decl.reasoningEffort}" could not read ` +
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

function validateReasoningEffort(
  decl: CatalogDeclaration & { readonly model: string },
  model: ModelCatalogEntry,
): ReadonlyArray<ClearOnEntryCatalogIssue> {
  if (decl.reasoningEffort === undefined) return [];
  const supported = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (supported.includes(decl.reasoningEffort)) return [];
  return [
    {
      check: 'clearOnEntry-reasoning-effort-supported',
      severity: 'error',
      stateId: decl.stateId,
      message:
        `clearOnEntry.reasoningEffort "${decl.reasoningEffort}" is not supported by model ` +
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
