import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_CHECKOUT_ENV,
  DEFAULT_CODEX_CHECKOUT,
  createClearOnEntryModelContractCheck,
  createPinnedFileContainsCheck,
  readPinnedCodexFile,
  resolveCodexCheckoutPath,
  runCodexBumpCli,
  runNamedChecks,
} from '../scripts/verify-codex-bump.js';

interface FixtureRepo {
  path: string;
  commit: string;
}

const tempRoots: string[] = [];

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolveOutput, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolveOutput(stdout.trim());
    });
  });
}

async function writeRepoFile(repo: string, filePath: string, contents: string): Promise<void> {
  const absolutePath = join(repo, filePath);
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

async function createFixtureRepo(files: Record<string, string>): Promise<FixtureRepo> {
  const repo = await fs.mkdtemp(join(tmpdir(), 'codex-bump-fixture-'));
  tempRoots.push(repo);

  await new Promise<void>((resolveInit, reject) => {
    execFile('git', ['init', '--quiet', repo], (error, _stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolveInit();
    });
  });

  for (const [filePath, contents] of Object.entries(files)) {
    await writeRepoFile(repo, filePath, contents);
  }

  await runGit(repo, ['add', '--all']);
  await runGit(repo, [
    '-c',
    'user.email=codex-bump@example.test',
    '-c',
    'user.name=Codex Bump Test',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  return { path: repo, commit: await runGit(repo, ['rev-parse', 'HEAD']) };
}

function modelContractFixtureFiles(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  const files = {
    'codex-rs/app-server-protocol/src/protocol/common.rs': `
client_request_definitions! {
    ConfigRead => "config/read" {
        params: v2::ConfigReadParams,
        serialization: global("config"),
        response: v2::ConfigReadResponse,
    },
    ModelList => "model/list" {
        params: v2::ModelListParams,
        serialization: None,
        response: v2::ModelListResponse,
    },
}
`,
    'codex-rs/app-server-protocol/src/protocol/v2/thread.rs': `
pub struct ThreadStartParams {
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub config: Option<HashMap<String, JsonValue>>,
}

pub struct MockExperimentalMethodParams {}
`,
    'codex-rs/app-server-protocol/src/protocol/v2/config.rs': `
pub struct Config {
    pub model: Option<String>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
}

pub struct ConfigLayerMetadata {}

pub struct ConfigReadParams {
    pub include_layers: bool,
    pub cwd: Option<String>,
}

pub struct ConfigReadResponse {
    pub config: Config,
}

pub struct ConfigRequirements {}

`,
    'codex-rs/app-server-protocol/src/protocol/v2/model.rs': `
pub struct ModelListParams {
    pub include_hidden: Option<bool>,
}

pub struct Model {
    pub model: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
    pub default_reasoning_effort: ReasoningEffort,
    pub is_default: bool,
}
pub struct ReasoningEffortOption {
    pub reasoning_effort: ReasoningEffort,
}

pub struct ModelListResponse {
    pub data: Vec<Model>,
    pub next_cursor: Option<String>,
}

pub struct CollaborationModeListParams {}
`,
    'codex-rs/protocol/src/openai_models.rs': `
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
}

impl FromStr for ReasoningEffort {}
`,
  };
  return { ...files, ...overrides };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('resolveCodexCheckoutPath', () => {
  it('prefers --checkout over env and the default path', () => {
    expect(
      resolveCodexCheckoutPath({
        argv: ['--checkout', '/tmp/from-cli'],
        env: { [CODEX_CHECKOUT_ENV]: '/tmp/from-env' },
      }),
    ).toBe('/tmp/from-cli');
  });

  it('uses the env var before the local default', () => {
    expect(
      resolveCodexCheckoutPath({
        argv: [],
        env: { [CODEX_CHECKOUT_ENV]: '/tmp/from-env' },
      }),
    ).toBe('/tmp/from-env');
  });

  it('falls back to the documented local checkout path', () => {
    expect(resolveCodexCheckoutPath({ argv: [], env: {} })).toBe(DEFAULT_CODEX_CHECKOUT);
  });
});

describe('readPinnedCodexFile', () => {
  it('reads from the pinned commit, not the mutable checkout worktree', async () => {
    const fixture = await createFixtureRepo({
      'codex-like/methodNames.ts': 'export const METHOD = "pinned";\n',
    });
    await writeRepoFile(
      fixture.path,
      'codex-like/methodNames.ts',
      'export const METHOD = "dirty";\n',
    );

    await expect(
      readPinnedCodexFile({
        checkoutPath: fixture.path,
        pinnedCommit: fixture.commit,
        filePath: 'codex-like/methodNames.ts',
      }),
    ).resolves.toContain('"pinned"');
  });
});

describe('runNamedChecks', () => {
  it('passes a named check against a Codex-like fixture repo', async () => {
    const fixture = await createFixtureRepo({
      'packages/core/src/protocol/methodNames.ts':
        'export const REQUEST_USER_INPUT = "item/tool/requestUserInput";\n',
    });

    const result = await runNamedChecks({
      checkoutPath: fixture.path,
      pinnedCommit: fixture.commit,
      checks: [
        createPinnedFileContainsCheck({
          name: 'request-user-input-method',
          filePath: 'packages/core/src/protocol/methodNames.ts',
          expected: 'item/tool/requestUserInput',
        }),
      ],
    });

    expect(result.failures).toEqual([]);
  });

  it('reports drift from a named check against a Codex-like fixture repo', async () => {
    const fixture = await createFixtureRepo({
      'packages/core/src/protocol/methodNames.ts':
        'export const REQUEST_USER_INPUT = "item/tool/renamed";\n',
    });

    const result = await runNamedChecks({
      checkoutPath: fixture.path,
      pinnedCommit: fixture.commit,
      checks: [
        createPinnedFileContainsCheck({
          name: 'request-user-input-method',
          filePath: 'packages/core/src/protocol/methodNames.ts',
          expected: 'item/tool/requestUserInput',
        }),
      ],
    });

    expect(result.failures).toEqual([
      {
        check: 'request-user-input-method',
        message: expect.stringContaining('item/tool/requestUserInput'),
      },
    ]);
  });

  it('checks the clearOnEntry model and reasoning-effort Codex contract', async () => {
    const fixture = await createFixtureRepo(modelContractFixtureFiles());

    const result = await runNamedChecks({
      checkoutPath: fixture.path,
      pinnedCommit: fixture.commit,
      checks: [createClearOnEntryModelContractCheck()],
    });

    expect(result.failures).toEqual([]);
  });

  it('reports drift in the clearOnEntry model contract', async () => {
    const fixture = await createFixtureRepo(
      modelContractFixtureFiles({
        'codex-rs/app-server-protocol/src/protocol/v2/thread.rs': `
pub struct ThreadStartParams {
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub config: Option<HashMap<String, JsonValue>>,
}

pub struct MockExperimentalMethodParams {}
`,
        'codex-rs/app-server-protocol/src/protocol/v2/config.rs': `
pub struct Config {
    pub model: Option<String>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
}

pub struct ConfigLayerMetadata {}

pub struct ConfigReadParams {
    pub include_layers: bool,
    pub cwd: Option<String>,
}

pub struct ConfigReadResponse {
    pub config: Config,
}

pub struct ConfigRequirements {}
`,
        'codex-rs/app-server-protocol/src/protocol/v2/model.rs': `
pub struct ModelListParams {
    pub include_hidden: Option<bool>,
}

pub struct Model {
    pub model: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
    pub default_reasoning_effort: ReasoningEffort,
    pub is_default: bool,
}

pub struct ReasoningEffortOption {
    pub description: String,
}

pub struct ModelListResponse {
    pub data: Vec<Model>,
    pub next_cursor: Option<String>,
}

pub struct CollaborationModeListParams {}
`,
      }),
    );

    const result = await runNamedChecks({
      checkoutPath: fixture.path,
      pinnedCommit: fixture.commit,
      checks: [createClearOnEntryModelContractCheck()],
    });

    expect(result.failures).toContainEqual({
      check: 'clear-on-entry-model-contract',
      message: expect.stringContaining('pub reasoning_effort: ReasoningEffort'),
    });
  });
});

describe('runCodexBumpCli', () => {
  it('returns 1 and prints a readable failure list when checks fail', async () => {
    const fixture = await createFixtureRepo({
      'packages/core/src/protocol/methodNames.ts': 'export const METHOD = "drifted";\n',
    });
    const stderr: string[] = [];

    const exitCode = await runCodexBumpCli({
      argv: ['--checkout', fixture.path],
      env: {},
      pinnedCommit: fixture.commit,
      stderr: (line) => stderr.push(line),
      stdout: () => undefined,
      checks: [
        createPinnedFileContainsCheck({
          name: 'method-table',
          filePath: 'packages/core/src/protocol/methodNames.ts',
          expected: 'item/tool/requestUserInput',
        }),
      ],
    });

    expect(exitCode).toBe(1);
    expect(stderr[0]).toContain('verify-codex-bump: 1 failure(s)');
    expect(stderr).toContainEqual(expect.stringContaining('- method-table:'));
    expect(stderr).toContainEqual(expect.stringContaining('item/tool/requestUserInput'));
  });
});
