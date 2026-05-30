import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';
import type {
  ConfigReadParams,
  ConfigReadResponse,
  ModelListParams,
  ModelListResponse,
} from '../protocol/types.js';
import type { StateModelEffort } from '../state/exits.js';
import {
  validateStateModelCatalogSelection,
  type CodexConfigModelProvider,
} from '../verify/clearOnEntryModelCatalog.js';

export interface PreflightStateModelOpts {
  readonly client: Pick<JsonRpcClient, 'request'>;
  readonly stateId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: StateModelEffort;
}

export async function preflightStateModel(opts: PreflightStateModelOpts): Promise<void> {
  if (opts.model === undefined && opts.effort === undefined) return;

  const issues = await validateStateModelCatalogSelection({
    provider: createRuntimeCodexConfigModelProvider(opts.client),
    stateId: opts.stateId,
    cwd: opts.cwd,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  });
  if (issues.length === 0) return;

  throw new Error(issues.map((issue) => `state "${issue.stateId}" ${issue.message}`).join('; '));
}

function createRuntimeCodexConfigModelProvider(
  client: Pick<JsonRpcClient, 'request'>,
): CodexConfigModelProvider {
  return {
    readConfig(params: ConfigReadParams): Promise<ConfigReadResponse> {
      return client.request<ConfigReadResponse>(METHOD.configRead, params);
    },
    listModels(params: ModelListParams): Promise<ModelListResponse> {
      return client.request<ModelListResponse>(METHOD.modelList, params);
    },
  };
}
