#!/usr/bin/env node
/// <reference types="node" />
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { METHOD } from '../src/protocol/methodNames.js';
import { DAEMON_PROBE_CLIENT_NAME } from '../src/protocol/types.js';

export const PINNED_CODEX_COMMIT = '7ca611348db9446711ed16ed81c84095e3721cee';
export const DEFAULT_CODEX_CHECKOUT = '/Users/alfredvc/src/codex';
export const CODEX_CHECKOUT_ENV = 'CODEX_CHECKOUT';

const CODEX_PATHS = {
  commonProtocol: 'codex-rs/app-server-protocol/src/protocol/common.rs',
  v2ThreadProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/thread.rs',
  v2TurnProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/turn.rs',
  v2ModelProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/model.rs',
  v2ConfigProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/config.rs',
  v2ItemProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/item.rs',
  v2PermissionsProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/permissions.rs',
  v2PluginProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/plugin.rs',
  v2SharedProtocol: 'codex-rs/app-server-protocol/src/protocol/v2/shared.rs',
  askForApprovalTs: 'codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts',
  permissionGrantScopeTs:
    'codex-rs/app-server-protocol/schema/typescript/v2/PermissionGrantScope.ts',
  commandExecutionApprovalDecisionTs:
    'codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionApprovalDecision.ts',
  fileChangeApprovalDecisionTs:
    'codex-rs/app-server-protocol/schema/typescript/v2/FileChangeApprovalDecision.ts',
  coreProtocol: 'codex-rs/protocol/src/protocol.rs',
  protocolModels: 'codex-rs/protocol/src/models.rs',
  configTypes: 'codex-rs/protocol/src/config_types.rs',
  openaiModels: 'codex-rs/protocol/src/openai_models.rs',
  coreConfig: 'codex-rs/core/src/config/mod.rs',
  configToml: 'codex-rs/config/src/config_toml.rs',
  requestUserInputProtocol: 'codex-rs/protocol/src/request_user_input.rs',
  requestUserInputHandler: 'codex-rs/core/src/tools/handlers/request_user_input.rs',
  requestUserInputTool: 'codex-rs/tools/src/tool_config.rs',
  exec: 'codex-rs/core/src/exec.rs',
  onRequestApprovalPrompt:
    'codex-rs/core/src/context/prompts/permissions/approval_policy/on_request.md',
  cliMain: 'codex-rs/cli/src/main.rs',
} as const;

type MethodKey = keyof typeof METHOD;

const METHOD_LITERAL_SOURCES: ReadonlyArray<{
  readonly key: MethodKey;
  readonly variant: string;
}> = [
  { key: 'threadStart', variant: 'ThreadStart' },
  { key: 'threadResume', variant: 'ThreadResume' },
  { key: 'threadSettingsUpdate', variant: 'ThreadSettingsUpdate' },
  { key: 'threadRollback', variant: 'ThreadRollback' },
  { key: 'threadInjectItems', variant: 'ThreadInjectItems' },
  { key: 'skillsList', variant: 'SkillsList' },
  { key: 'skillsExtraRootsSet', variant: 'SkillsExtraRootsSet' },
  { key: 'threadNameSet', variant: 'ThreadSetName' },
  { key: 'threadUnsubscribe', variant: 'ThreadUnsubscribe' },
  { key: 'turnStart', variant: 'TurnStart' },
  { key: 'turnInterrupt', variant: 'TurnInterrupt' },
  { key: 'commandExecutionRequestApproval', variant: 'CommandExecutionRequestApproval' },
  { key: 'fileChangeRequestApproval', variant: 'FileChangeRequestApproval' },
  { key: 'toolDynamicCall', variant: 'DynamicToolCall' },
  { key: 'toolRequestUserInput', variant: 'ToolRequestUserInput' },
  { key: 'mcpServerElicitationRequest', variant: 'McpServerElicitationRequest' },
  { key: 'permissionsRequestApproval', variant: 'PermissionsRequestApproval' },
  { key: 'threadStarted', variant: 'ThreadStarted' },
  { key: 'turnStarted', variant: 'TurnStarted' },
  { key: 'turnCompleted', variant: 'TurnCompleted' },
  { key: 'itemStarted', variant: 'ItemStarted' },
  { key: 'itemCompleted', variant: 'ItemCompleted' },
  { key: 'fileChangePatchUpdated', variant: 'FileChangePatchUpdated' },
  { key: 'serverRequestResolved', variant: 'ServerRequestResolved' },
  { key: 'hookStarted', variant: 'HookStarted' },
  { key: 'hookCompleted', variant: 'HookCompleted' },
  { key: 'agentMessageDelta', variant: 'AgentMessageDelta' },
  { key: 'rawResponseItemCompleted', variant: 'RawResponseItemCompleted' },
  { key: 'threadTokenUsageUpdated', variant: 'ThreadTokenUsageUpdated' },
  { key: 'mcpServerStatusList', variant: 'McpServerStatusList' },
  { key: 'modelList', variant: 'ModelList' },
  { key: 'configRead', variant: 'ConfigRead' },
];

type Env = Record<string, string | undefined>;

export interface ResolveCodexCheckoutOptions {
  argv?: readonly string[];
  env?: Env;
}

export interface ReadPinnedCodexFileOptions {
  checkoutPath: string;
  filePath: string;
  pinnedCommit?: string;
}

export interface CodexBumpContext {
  checkoutPath: string;
  pinnedCommit: string;
  readFile(filePath: string): Promise<string>;
}

export interface CodexBumpCheck {
  name: string;
  run(context: CodexBumpContext): Promise<readonly string[] | void> | readonly string[] | void;
}

export interface CodexBumpFailure {
  check: string;
  message: string;
}

export interface CodexBumpResult {
  checkoutPath: string;
  pinnedCommit: string;
  failures: CodexBumpFailure[];
}

export interface RunNamedChecksOptions {
  checkoutPath: string;
  pinnedCommit?: string;
  checks: readonly CodexBumpCheck[];
}

export interface PinnedFileContainsCheckOptions {
  name: string;
  filePath: string;
  expected: string | readonly string[];
}

export interface RunCodexBumpCliOptions {
  argv?: readonly string[];
  env?: Env;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  checks?: readonly CodexBumpCheck[];
  pinnedCommit?: string;
}

function parseCheckoutArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--checkout') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --checkout');
      }
      return value;
    }
    if (arg.startsWith('--checkout=')) {
      const value = arg.slice('--checkout='.length);
      if (value.length === 0) {
        throw new Error('Missing value for --checkout');
      }
      return value;
    }
    if (!arg.startsWith('--')) {
      return arg;
    }
  }
  return undefined;
}

export function resolveCodexCheckoutPath(options: ResolveCodexCheckoutOptions = {}): string {
  const checkoutArg = parseCheckoutArg(options.argv ?? []);
  const env = options.env ?? process.env;
  return resolve(checkoutArg ?? env[CODEX_CHECKOUT_ENV] ?? DEFAULT_CODEX_CHECKOUT);
}

async function git(checkoutPath: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolveOutput, reject) => {
    execFile(
      'git',
      ['-C', checkoutPath, ...args],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(String(stderr || error.message).trim()));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingSnippetMessages(
  filePath: string,
  source: string,
  snippets: readonly string[],
  pinnedCommit: string,
): string[] {
  return snippets
    .filter((snippet) => !source.includes(snippet))
    .map((snippet) => `${filePath} at ${pinnedCommit} is missing ${JSON.stringify(snippet)}`);
}

function extractRequiredSpan(
  source: string,
  start: string,
  end: string,
  filePath: string,
): string | string[] {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) {
    return [`${filePath} is missing span start ${JSON.stringify(start)}`];
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex === -1) {
    return [
      `${filePath} is missing span end ${JSON.stringify(end)} after ${JSON.stringify(start)}`,
    ];
  }
  return source.slice(startIndex, endIndex);
}

function forbiddenSnippetMessages(
  filePath: string,
  source: string,
  snippets: readonly string[],
): string[] {
  return snippets
    .filter((snippet) => source.includes(snippet))
    .map((snippet) => `${filePath} unexpectedly contains ${JSON.stringify(snippet)}`);
}

function missingSpanSnippetMessages(
  filePath: string,
  source: string,
  start: string,
  end: string,
  snippets: readonly string[],
  pinnedCommit: string,
): string[] {
  const span = extractRequiredSpan(source, start, end, filePath);
  if (Array.isArray(span)) {
    return span;
  }
  return missingSnippetMessages(filePath, span, snippets, pinnedCommit);
}

function missingCheckoutMessage(checkoutPath: string): string {
  return `Codex checkout not found at ${checkoutPath}. Pass --checkout <path> or set ${CODEX_CHECKOUT_ENV}.`;
}

export async function readPinnedCodexFile(options: ReadPinnedCodexFileOptions): Promise<string> {
  const pinnedCommit = options.pinnedCommit ?? PINNED_CODEX_COMMIT;
  if (!existsSync(options.checkoutPath)) {
    throw new Error(missingCheckoutMessage(options.checkoutPath));
  }

  try {
    return await git(options.checkoutPath, ['show', `${pinnedCommit}:${options.filePath}`]);
  } catch (error) {
    throw new Error(
      `Unable to read ${options.filePath} at ${pinnedCommit} from ${options.checkoutPath}: ${formatUnknownError(
        error,
      )}`,
      { cause: error },
    );
  }
}

export async function assertPinnedCommitAvailable(context: CodexBumpContext): Promise<void> {
  if (!existsSync(context.checkoutPath)) {
    throw new Error(missingCheckoutMessage(context.checkoutPath));
  }
  await git(context.checkoutPath, ['cat-file', '-e', `${context.pinnedCommit}^{commit}`]);
}

export function createPinnedFileContainsCheck(
  options: PinnedFileContainsCheckOptions,
): CodexBumpCheck {
  const expected = Array.isArray(options.expected) ? options.expected : [options.expected];

  return {
    name: options.name,
    async run(context) {
      const source = await context.readFile(options.filePath);
      return missingSnippetMessages(options.filePath, source, expected, context.pinnedCommit);
    },
  };
}

export function createMethodLiteralCheck(): CodexBumpCheck {
  return {
    name: 'method-literals',
    async run(context) {
      const source = await context.readFile(CODEX_PATHS.commonProtocol);
      return METHOD_LITERAL_SOURCES.flatMap(({ key, variant }) => {
        const literal = METHOD[key];
        const expected = `${variant} => "${literal}"`;
        return missingSnippetMessages(
          CODEX_PATHS.commonProtocol,
          source,
          [expected],
          context.pinnedCommit,
        ).map((message) => `${key}: ${message}`);
      });
    },
  };
}

export function createRequestUserInputSourceCheck(): CodexBumpCheck {
  return {
    name: 'request-user-input-source',
    async run(context) {
      const [protocolSource, toolSource, handlerSource] = await Promise.all([
        context.readFile(CODEX_PATHS.requestUserInputProtocol),
        context.readFile(CODEX_PATHS.requestUserInputTool),
        context.readFile(CODEX_PATHS.requestUserInputHandler),
      ]);

      return [
        ...missingSnippetMessages(
          CODEX_PATHS.requestUserInputProtocol,
          protocolSource,
          [
            'pub struct RequestUserInputArgs',
            'pub questions: Vec<RequestUserInputQuestion>',
            'pub struct RequestUserInputResponse',
            'pub answers: HashMap<String, RequestUserInputAnswer>',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.requestUserInputTool,
          toolSource,
          [
            'pub fn request_user_input_available_modes(features: &Features) -> Vec<ModeKind>',
            'Feature::DefaultModeRequestUserInput',
            'mode.allows_request_user_input()',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.requestUserInputHandler,
          handlerSource,
          [
            'pub struct RequestUserInputHandler',
            'impl ToolExecutor<ToolInvocation> for RequestUserInputHandler',
            'impl CoreToolRuntime for RequestUserInputHandler',
            'request_user_input_unavailable_message',
            '.request_user_input(turn.as_ref(), call_id, args)',
          ],
          context.pinnedCommit,
        ),
      ];
    },
  };
}

export function createApprovalSandboxEnumCheck(): CodexBumpCheck {
  return {
    name: 'approval-sandbox-enums',
    async run(context) {
      const [
        askForApprovalTs,
        permissionGrantScopeTs,
        commandDecisionTs,
        fileDecisionTs,
        sharedSource,
        itemSource,
        permissionsSource,
        coreProtocolSource,
        configTypesSource,
        coreConfigSource,
        configTomlSource,
        modelSource,
        execSource,
        onRequestPrompt,
      ] = await Promise.all([
        context.readFile(CODEX_PATHS.askForApprovalTs),
        context.readFile(CODEX_PATHS.permissionGrantScopeTs),
        context.readFile(CODEX_PATHS.commandExecutionApprovalDecisionTs),
        context.readFile(CODEX_PATHS.fileChangeApprovalDecisionTs),
        context.readFile(CODEX_PATHS.v2SharedProtocol),
        context.readFile(CODEX_PATHS.v2ItemProtocol),
        context.readFile(CODEX_PATHS.v2PermissionsProtocol),
        context.readFile(CODEX_PATHS.coreProtocol),
        context.readFile(CODEX_PATHS.configTypes),
        context.readFile(CODEX_PATHS.coreConfig),
        context.readFile(CODEX_PATHS.configToml),
        context.readFile(CODEX_PATHS.protocolModels),
        context.readFile(CODEX_PATHS.exec),
        context.readFile(CODEX_PATHS.onRequestApprovalPrompt),
      ]);

      return [
        ...missingSnippetMessages(
          CODEX_PATHS.askForApprovalTs,
          askForApprovalTs,
          ['"untrusted"', '"on-failure"', '"on-request"', '"never"'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.permissionGrantScopeTs,
          permissionGrantScopeTs,
          ['"turn"', '"session"'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.commandExecutionApprovalDecisionTs,
          commandDecisionTs,
          ['"accept"', '"acceptForSession"', '"decline"', '"cancel"'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.fileChangeApprovalDecisionTs,
          fileDecisionTs,
          ['"accept"', '"acceptForSession"', '"decline"', '"cancel"'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.v2SharedProtocol,
          sharedSource,
          ['#[serde(rename_all = "kebab-case")]', 'pub enum AskForApproval', 'OnRequest'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.v2ItemProtocol,
          itemSource,
          ['pub enum CommandExecutionApprovalDecision', 'pub enum FileChangeApprovalDecision'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.v2PermissionsProtocol,
          permissionsSource,
          ['pub enum PermissionGrantScope from CorePermissionGrantScope'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.coreProtocol,
          coreProtocolSource,
          [
            'pub enum AskForApproval',
            'OnRequest',
            '`with_additional_permissions` and `require_escalated` requests',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.configTypes,
          configTypesSource,
          [
            'pub enum ApprovalsReviewer',
            '#[serde(rename = "user")]',
            'User',
            'AutoReview',
            'auto_review',
            'Configures who approval requests are routed to for review',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.coreConfig,
          coreConfigSource,
          [
            'use codex_config::types::ApprovalsReviewer',
            'pub approvals_reviewer: ApprovalsReviewer',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.configToml,
          configTomlSource,
          ['pub approvals_reviewer: Option<ApprovalsReviewer>'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.protocolModels,
          modelSource,
          [
            '#[serde(rename_all = "snake_case")]',
            'pub enum SandboxPermissions',
            'UseDefault',
            'RequireEscalated',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.exec,
          execSource,
          ['pub sandbox_permissions: SandboxPermissions', 'SandboxPermissions::UseDefault'],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.onRequestApprovalPrompt,
          onRequestPrompt,
          ['sandbox_permissions', '"require_escalated"'],
          context.pinnedCommit,
        ),
      ];
    },
  };
}

export function createAppServerCliSurfaceCheck(): CodexBumpCheck {
  return {
    name: 'app-server-cli-surface',
    async run(context) {
      const source = await context.readFile(CODEX_PATHS.cliMain);
      const appServerSpan = extractRequiredSpan(
        source,
        'struct AppServerCommand',
        'struct AppServerProxyCommand',
        CODEX_PATHS.cliMain,
      );
      const spanFailures = Array.isArray(appServerSpan) ? appServerSpan : [];
      const appServerSpecificSource = Array.isArray(appServerSpan) ? '' : appServerSpan;

      return [
        ...spanFailures,
        ...missingSnippetMessages(
          CODEX_PATHS.cliMain,
          source,
          [
            'struct AppServerCommand',
            'long = "listen"',
            'enum AppServerSubcommand',
            'GenerateTs(GenerateTsCommand)',
            'GenerateJsonSchema(GenerateJsonSchemaCommand)',
            'GenerateInternalJsonSchema(GenerateInternalJsonSchemaCommand)',
            'codex_app_server_protocol::generate_ts_with_options',
            'codex_app_server_protocol::generate_json_with_experimental',
            'codex_app_server_protocol::generate_internal_json_schema',
          ],
          context.pinnedCommit,
        ),
        ...forbiddenSnippetMessages(CODEX_PATHS.cliMain, appServerSpecificSource, [
          'approval_policy',
          'approval-policy',
          'ApprovalModeCliArg',
        ]),
      ];
    },
  };
}

export function createClearOnEntryModelContractCheck(): CodexBumpCheck {
  return {
    name: 'clear-on-entry-model-contract',
    async run(context) {
      const [commonSource, threadSource, modelSource, configSource, openaiModelsSource] =
        await Promise.all([
          context.readFile(CODEX_PATHS.commonProtocol),
          context.readFile(CODEX_PATHS.v2ThreadProtocol),
          context.readFile(CODEX_PATHS.v2ModelProtocol),
          context.readFile(CODEX_PATHS.v2ConfigProtocol),
          context.readFile(CODEX_PATHS.openaiModels),
        ]);

      return [
        ...missingSnippetMessages(
          CODEX_PATHS.commonProtocol,
          commonSource,
          [
            'ConfigRead => "config/read"',
            'params: v2::ConfigReadParams',
            'response: v2::ConfigReadResponse',
            'ModelList => "model/list"',
            'params: v2::ModelListParams',
            'response: v2::ModelListResponse',
          ],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2ThreadProtocol,
          threadSource,
          'pub struct ThreadStartParams {',
          'pub struct MockExperimentalMethodParams {',
          [
            'pub model: Option<String>',
            'pub cwd: Option<String>',
            'pub config: Option<HashMap<String, JsonValue>>',
          ],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2ConfigProtocol,
          configSource,
          'pub struct Config {',
          'pub struct ConfigLayerMetadata {',
          ['pub model: Option<String>', 'pub model_reasoning_effort: Option<ReasoningEffort>'],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2ConfigProtocol,
          configSource,
          'pub struct ConfigReadParams {',
          'pub struct ConfigRequirements {',
          [
            'pub include_layers: bool',
            'pub cwd: Option<String>',
            'pub struct ConfigReadResponse',
            'pub config: Config',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.v2ModelProtocol,
          modelSource,
          [
            'pub include_hidden: Option<bool>',
            'pub struct Model',
            'pub model: String',
            'pub supported_reasoning_efforts: Vec<ReasoningEffortOption>',
            'pub default_reasoning_effort: ReasoningEffort',
            'pub is_default: bool',
            'pub struct ReasoningEffortOption',
            'pub reasoning_effort: ReasoningEffort',
            'pub struct ModelListResponse',
            'pub data: Vec<Model>',
            'pub next_cursor: Option<String>',
          ],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.openaiModels,
          openaiModelsSource,
          '#[serde(rename_all = "lowercase")]',
          'impl FromStr for ReasoningEffort',
          [
            '#[serde(rename_all = "lowercase")]',
            'None',
            'Minimal',
            'Low',
            'Medium',
            'High',
            'XHigh',
          ],
          context.pinnedCommit,
        ),
      ];
    },
  };
}

export function createThreadSettingsUpdateContractCheck(): CodexBumpCheck {
  return {
    name: 'thread-settings-update-contract',
    async run(context) {
      const [commonSource, threadSource] = await Promise.all([
        context.readFile(CODEX_PATHS.commonProtocol),
        context.readFile(CODEX_PATHS.v2ThreadProtocol),
      ]);

      return [
        ...missingSpanSnippetMessages(
          CODEX_PATHS.commonProtocol,
          commonSource,
          'ThreadSettingsUpdate',
          'ThreadMemoryModeSet',
          [
            'ThreadSettingsUpdate => "thread/settings/update"',
            'params: v2::ThreadSettingsUpdateParams',
            'response: v2::ThreadSettingsUpdateResponse',
          ],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2ThreadProtocol,
          threadSource,
          'pub struct ThreadSettingsUpdateParams {',
          'pub struct ThreadSettings {',
          [
            'pub thread_id: String',
            'pub model: Option<String>',
            'pub effort: Option<ReasoningEffort>',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.v2ThreadProtocol,
          threadSource,
          ['pub struct ThreadSettingsUpdateResponse {}'],
          context.pinnedCommit,
        ),
      ];
    },
  };
}

export function createSkillsProtocolContractCheck(): CodexBumpCheck {
  return {
    name: 'skills-protocol-contract',
    async run(context) {
      const [commonSource, pluginSource, turnSource] = await Promise.all([
        context.readFile(CODEX_PATHS.commonProtocol),
        context.readFile(CODEX_PATHS.v2PluginProtocol),
        context.readFile(CODEX_PATHS.v2TurnProtocol),
      ]);

      return [
        ...missingSnippetMessages(
          CODEX_PATHS.commonProtocol,
          commonSource,
          [
            'SkillsList => "skills/list"',
            'params: v2::SkillsListParams',
            'response: v2::SkillsListResponse',
            'SkillsExtraRootsSet => "skills/extraRoots/set"',
            'params: v2::SkillsExtraRootsSetParams',
            'response: v2::SkillsExtraRootsSetResponse',
          ],
          context.pinnedCommit,
        ),
        ...missingSnippetMessages(
          CODEX_PATHS.v2PluginProtocol,
          pluginSource,
          [
            'pub struct SkillsListParams',
            'pub cwds: Vec<PathBuf>',
            'pub force_reload: bool',
            'pub struct SkillsListResponse',
            'pub data: Vec<SkillsListEntry>',
            'pub struct SkillsExtraRootsSetParams',
            'pub extra_roots: Vec<AbsolutePathBuf>',
            'pub struct SkillsExtraRootsSetResponse {}',
            'pub struct SkillsListEntry',
            'pub cwd: PathBuf',
            'pub skills: Vec<SkillMetadata>',
            'pub errors: Vec<SkillErrorInfo>',
            'pub struct SkillMetadata',
            'pub name: String',
            'pub path: AbsolutePathBuf',
            'pub enabled: bool',
            'pub struct SkillErrorInfo',
            'pub path: PathBuf',
            'pub message: String',
          ],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2ThreadProtocol,
          turnSource,
          'pub enum UserInput {',
          'impl UserInput {',
          ['Skill {', 'name: String', 'path: PathBuf'],
          context.pinnedCommit,
        ),
      ];
    },
  };
}

export function createSidecarProtocolContractCheck(): CodexBumpCheck {
  return {
    name: 'sidecar-protocol-contract',
    async run(context) {
      const [threadSource, turnSource] = await Promise.all([
        context.readFile(CODEX_PATHS.v2ThreadProtocol),
        context.readFile(CODEX_PATHS.v2TurnProtocol),
      ]);

      return [
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2ThreadProtocol,
          threadSource,
          'pub struct ThreadStartParams {',
          'pub struct MockExperimentalMethodParams {',
          [
            'pub cwd: Option<String>',
            'pub model: Option<String>',
            'pub config: Option<HashMap<String, JsonValue>>',
            'pub base_instructions: Option<String>',
            'pub developer_instructions: Option<String>',
          ],
          context.pinnedCommit,
        ),
        ...missingSpanSnippetMessages(
          CODEX_PATHS.v2TurnProtocol,
          turnSource,
          'pub enum UserInput {',
          'impl UserInput {',
          [
            'Text {',
            'text: String',
            'text_elements: Vec<TextElement>',
            'Image {',
            'url: String',
            'LocalImage {',
            'path: PathBuf',
            'Skill {',
            'name: String',
            'Mention {',
            'path: String',
          ],
          context.pinnedCommit,
        ),
      ];
    },
  };
}

export function createDaemonProbeClientNameCheck(): CodexBumpCheck {
  return {
    name: 'daemon-probe-client-name',
    run() {
      if (DAEMON_PROBE_CLIENT_NAME === 'codex_app_server_daemon') {
        return [];
      }
      return [
        `DAEMON_PROBE_CLIENT_NAME is ${JSON.stringify(
          DAEMON_PROBE_CLIENT_NAME,
        )}, expected "codex_app_server_daemon"`,
      ];
    },
  };
}

export const DEFAULT_CHECKS: readonly CodexBumpCheck[] = [
  {
    name: 'pinned-commit-available',
    async run(context) {
      await assertPinnedCommitAvailable(context);
    },
  },
  createMethodLiteralCheck(),
  createRequestUserInputSourceCheck(),
  createApprovalSandboxEnumCheck(),
  createAppServerCliSurfaceCheck(),
  createClearOnEntryModelContractCheck(),
  createThreadSettingsUpdateContractCheck(),
  createSkillsProtocolContractCheck(),
  createSidecarProtocolContractCheck(),
  createDaemonProbeClientNameCheck(),
];

export async function runNamedChecks(options: RunNamedChecksOptions): Promise<CodexBumpResult> {
  const pinnedCommit = options.pinnedCommit ?? PINNED_CODEX_COMMIT;
  const context: CodexBumpContext = {
    checkoutPath: options.checkoutPath,
    pinnedCommit,
    readFile: (filePath) =>
      readPinnedCodexFile({
        checkoutPath: options.checkoutPath,
        pinnedCommit,
        filePath,
      }),
  };
  const failures: CodexBumpFailure[] = [];

  for (const check of options.checks) {
    try {
      const messages = await check.run(context);
      for (const message of messages ?? []) {
        failures.push({ check: check.name, message });
      }
    } catch (error) {
      failures.push({ check: check.name, message: formatUnknownError(error) });
    }
  }

  return {
    checkoutPath: options.checkoutPath,
    pinnedCommit,
    failures,
  };
}

function hasHelpArg(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

function usage(): string {
  return [
    'Usage: verify-codex-bump [--checkout <path>]',
    '',
    `Defaults to ${DEFAULT_CODEX_CHECKOUT}; override with --checkout or ${CODEX_CHECKOUT_ENV}.`,
  ].join('\n');
}

export async function runCodexBumpCli(options: RunCodexBumpCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const checks = options.checks ?? DEFAULT_CHECKS;
  const pinnedCommit = options.pinnedCommit ?? PINNED_CODEX_COMMIT;

  if (hasHelpArg(argv)) {
    stdout(usage());
    return 0;
  }

  let checkoutPath: string;
  try {
    checkoutPath = resolveCodexCheckoutPath({ argv, env });
  } catch (error) {
    stderr(`verify-codex-bump: ${formatUnknownError(error)}`);
    stderr(usage());
    return 2;
  }

  const result = await runNamedChecks({ checkoutPath, pinnedCommit, checks });

  if (result.failures.length === 0) {
    stdout(`verify-codex-bump: ok (${checks.length} checks)`);
    return 0;
  }

  stderr(
    `verify-codex-bump: ${result.failures.length} failure(s) against ${result.pinnedCommit} in ${result.checkoutPath}`,
  );
  for (const failure of result.failures) {
    stderr(`- ${failure.check}: ${failure.message}`);
  }
  return 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath !== undefined && realpathSync(invokedPath) === realpathSync(modulePath)) {
  runCodexBumpCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`verify-codex-bump: ${formatUnknownError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
