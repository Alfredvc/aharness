/**
 * `runVerifyCli` end-to-end test. Compiles a tiny FSM via `loadFsm` and
 * runs the codex-side verifier through the CLI entry point.
 *
 * The two fixtures under `./fixtures/` exercise the pass/fail paths:
 *   - `single-state.fsm.ts` — one stateful state with a submit exit and
 *     a paired `on` handler reaching a terminal final state. Verify ok.
 *   - `black-hole.fsm.ts` — a passive state with no `always`/`after`/
 *     `invoke.onDone` trigger, so the actor would be stuck on entry.
 *     Trips `no-black-hole-non-terminals` (and `terminal-reachability`).
 *
 * A fresh tmpdir is used as `repoRoot` for each test so `.aharness/cache/`
 * does not bleed across cases (loadFsm writes the bundled `.mjs` there).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runVerifyCli } from '../src/cli/verifyCli.js';
import type { CodexConfigModelProvider } from '../src/verify/clearOnEntryModelCatalog.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('runVerifyCli', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('exits 0 on a passing FSM', async () => {
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'single-state.fsm.ts'),
      repoRoot,
      log,
    });
    expect(r.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('verify: ok'));
  });

  it('exits 1 and prints issues on a failing FSM', async () => {
    const provider = fakeCatalogProvider();
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'black-hole.fsm.ts'),
      repoRoot,
      log,
      modelCatalogProvider: provider,
    });
    expect(r.exitCode).toBe(1);
    // At least one issue line should name a real check id from the verifier.
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('no-black-hole-non-terminals'))).toBe(true);
    expect(lines).toContainEqual(
      expect.stringContaining(`${join(fixtureDir, 'black-hole.fsm.ts')}:22:`),
    );
    expect(provider.listModels).not.toHaveBeenCalled();
    expect(provider.readConfig).not.toHaveBeenCalled();
  });

  it('prints replacement guidance for retired canonical ask', async () => {
    const fsmPath = await writeRetiredOwnerDecisionFixture('ask');
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('per-state-data-schema-resolvable'));
    expect(lines).toContainEqual(expect.stringContaining('`ask` has been retired'));
    expect(lines).toContainEqual(expect.stringContaining('fsm.choice'));
    expect(lines).toContainEqual(expect.stringContaining('open state'));
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('prints replacement guidance for retired canonical fsm.await', async () => {
    const fsmPath = await writeRetiredOwnerDecisionFixture('await');
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('fsm.await has been retired'));
    expect(lines).toContainEqual(expect.stringContaining('fsm.choice'));
    expect(lines).toContainEqual(expect.stringContaining('open state'));
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('does not probe the catalog when no state-level model is declared', async () => {
    const provider = fakeCatalogProvider();
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'single-state.fsm.ts'),
      repoRoot,
      log,
      modelCatalogProvider: provider,
    });
    expect(r.exitCode).toBe(0);
    expect(provider.listModels).not.toHaveBeenCalled();
    expect(provider.readConfig).not.toHaveBeenCalled();
  });

  it('passes when a declared state model name is present in model/list', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'gpt-5.1-codex' }`);
    const provider = fakeCatalogProvider({
      models: [
        {
          model: 'gpt-5.1-codex',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
      ],
    });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(0);
    expect(provider.listModels).toHaveBeenCalledWith({ includeHidden: true });
    expect(provider.readConfig).not.toHaveBeenCalled();
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('rejects a declared state model name absent from model/list', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'missing-model' }`);
    const provider = fakeCatalogProvider({
      models: [
        {
          model: 'gpt-5.1-codex',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
          defaultReasoningEffort: 'medium',
          isDefault: true,
        },
      ],
    });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('state-model-available (clear):'));
    expect(lines).toContainEqual(expect.stringContaining('"missing-model" is not available'));
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('skips Codex model catalog checks in CI', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'missing-model', effort: 'xhigh' }`);
    const providerFactory = vi.fn(async () => {
      throw new Error('Codex should not start in CI');
    });
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath,
      repoRoot,
      log,
      env: { CI: 'true' },
      modelCatalogProviderFactory: providerFactory,
    });
    expect(r.exitCode).toBe(0);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('verify: ok (0 warnings)');
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('returns a verifier issue when the catalog provider cannot start', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'gpt-5.1-codex' }`);
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath,
      repoRoot,
      log,
      modelCatalogProviderFactory: async () => {
        throw new Error('spawn unavailable');
      },
    });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('state-model-catalog-probe (clear):'));
    expect(lines).toContainEqual(expect.stringContaining('spawn unavailable'));
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('returns a verifier issue when model/list fails', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'gpt-5.1-codex' }`);
    const provider = fakeCatalogProvider({ listModelsError: new Error('rpc model/list failed') });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('state-model-catalog-probe (clear):'));
    expect(lines).toContainEqual(expect.stringContaining('could not read Codex model/list'));
    expect(lines).toContainEqual(expect.stringContaining('rpc model/list failed'));
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('rejects unsupported reasoning effort for a declared model', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'gpt-5.1-codex', effort: 'xhigh' }`);
    const provider = fakeCatalogProvider({
      models: [
        {
          model: 'gpt-5.1-codex',
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
          defaultReasoningEffort: 'low',
          isDefault: true,
        },
      ],
    });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('state-model-effort-supported (clear):'));
    expect(lines).toContainEqual(expect.stringContaining('model "gpt-5.1-codex"'));
    expect(lines).toContainEqual(expect.stringContaining('supported values: low'));
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('does not over-validate effort-only declarations at verify time', async () => {
    const fsmPath = await writeStateModelFixture(`{ effort: 'high' }`);
    const provider = fakeCatalogProvider({
      configModel: 'configured-model',
      models: [
        {
          model: 'configured-model',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
          defaultReasoningEffort: 'high',
          isDefault: false,
        },
      ],
    });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(0);
    expect(provider.readConfig).not.toHaveBeenCalled();
    expect(provider.listModels).not.toHaveBeenCalled();
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('does not validate effort-only declarations when config/read cannot infer a model', async () => {
    const fsmPath = await writeStateModelFixture(`{ effort: 'minimal' }`);
    const provider = fakeCatalogProvider({
      configModel: null,
      models: [
        {
          model: 'first-model',
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
          defaultReasoningEffort: 'low',
          isDefault: false,
        },
        {
          model: 'default-model',
          supportedReasoningEfforts: [{ reasoningEffort: 'minimal', description: 'Minimal' }],
          defaultReasoningEffort: 'minimal',
          isDefault: true,
        },
      ],
    });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(0);
    expect(provider.readConfig).not.toHaveBeenCalled();
    expect(provider.listModels).not.toHaveBeenCalled();
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('defers effort-only validation when cwd is data-dependent', async () => {
    const fsmPath = await writeStateModelFixture(`{ effort: 'high' }`);
    const provider = fakeCatalogProvider();
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(0);
    expect(provider.listModels).not.toHaveBeenCalled();
    expect(provider.readConfig).not.toHaveBeenCalled();
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('reads paginated model/list results with includeHidden', async () => {
    const fsmPath = await writeStateModelFixture(`{ name: 'second-page-model' }`);
    const provider = fakeCatalogProvider({
      pages: [
        {
          data: [
            {
              model: 'first-page-model',
              supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
              defaultReasoningEffort: 'medium',
              isDefault: true,
            },
          ],
          nextCursor: 'page-2',
        },
        {
          data: [
            {
              model: 'second-page-model',
              supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
              defaultReasoningEffort: 'high',
              isDefault: false,
            },
          ],
          nextCursor: null,
        },
      ],
    });
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath, repoRoot, log, modelCatalogProvider: provider });
    expect(r.exitCode).toBe(0);
    expect(provider.listModels).toHaveBeenNthCalledWith(1, { includeHidden: true });
    expect(provider.listModels).toHaveBeenNthCalledWith(2, {
      includeHidden: true,
      cursor: 'page-2',
    });
    await fs.rm(dirname(fsmPath), { recursive: true, force: true });
  });

  it('flags missing path-form skill refs while leaving name-form refs to catalog preflight', async () => {
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'skills.fsm.ts'),
      repoRoot,
      log,
    });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    const skillLines = lines.filter((l) => l.includes('skill-must-resolve'));
    expect(skillLines).toHaveLength(1);
    expect(skillLines.some((l) => l.includes('not-installed'))).toBe(false);
    expect(skillLines.some((l) => l.includes('local/SKILL.md'))).toBe(true);
  });

  it('passes skill-must-resolve when the skill file exists alongside the FSM', async () => {
    // Materialise a sibling `skills/local/SKILL.md` alongside the fixture by
    // copying the FSM into a tmp dir whose `skills/local/SKILL.md` exists.
    const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-skill-pass-'));
    const tmpFsmPath = join(tmpFsmDir, 'skills.fsm.ts');
    // We need a fixture that only declares a path-form skill (the
    // name-form would still miss). Inline a minimal one.
    const minimal = `import { aharness, state, terminal, exit, skill } from '@aharness/core';
interface P { q: string }
export const machine = aharness.machine({
  id: 'pass',
  initial: 'a',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    a: state({ entryPrompt: 'x', skills: [skill({ path: './skills/local/SKILL.md' })], exits: { ok: exit<P>({ to: 'done' }) } }),
    done: terminal('success'),
  },
});
export default machine;
`;
    await fs.writeFile(tmpFsmPath, minimal, 'utf8');
    await fs.mkdir(join(tmpFsmDir, 'skills', 'local'), { recursive: true });
    await fs.writeFile(join(tmpFsmDir, 'skills', 'local', 'SKILL.md'), '# local\nbody.\n');
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath: tmpFsmPath, repoRoot, log });
    expect(r.exitCode).toBe(0);
    await fs.rm(tmpFsmDir, { recursive: true, force: true });
  });

  it('flags missing path-form threadSkills refs', async () => {
    const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-thread-skill-'));
    const tmpFsmPath = join(tmpFsmDir, 'thread-skills.fsm.ts');
    const source = `import { aharness, state, terminal, exit, skill } from '@aharness/core';
interface P { q: string }
export default aharness.machine({
  id: 'thread-skill-miss',
  threadSkills: {
    helper: skill({ path: './skills/missing/SKILL.md' }),
  },
  initial: 'a',
  states: {
    a: state({ entryPrompt: 'x', exits: { ok: exit<P>({ to: 'done' }) } }),
    done: terminal('success'),
  },
});
`;
    await fs.writeFile(tmpFsmPath, source, 'utf8');

    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath: tmpFsmPath, repoRoot, log });

    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('[error] thread-skill-must-resolve'));
    expect(lines).toContainEqual(expect.stringContaining("threadSkills['helper']"));
    await fs.rm(tmpFsmDir, { recursive: true, force: true });
  });

  it('downgrades optional skill misses to warning (does not block run)', async () => {
    const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-skill-opt-'));
    const tmpFsmPath = join(tmpFsmDir, 'skills.fsm.ts');
    const minimal = `import { aharness, state, terminal, exit, skill } from '@aharness/core';
interface P { q: string }
export const machine = aharness.machine({
  id: 'opt',
  initial: 'a',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    a: state({ entryPrompt: 'x', skills: [skill({ path: './skills/missing/SKILL.md', optional: true })], exits: { ok: exit<P>({ to: 'done' }) } }),
    done: terminal('success'),
  },
});
export default machine;
`;
    await fs.writeFile(tmpFsmPath, minimal, 'utf8');
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath: tmpFsmPath, repoRoot, log });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining(`${tmpFsmPath}:8:`));
    expect(lines).toContainEqual(expect.stringContaining('[warning] skill-must-resolve (a):'));
    expect(lines.at(-1)).toBe('verify: ok (1 warnings)');
    await fs.rm(tmpFsmDir, { recursive: true, force: true });
  });
});

async function writeStateModelFixture(stateModel: string): Promise<string> {
  const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-clear-'));
  const tmpFsmPath = join(tmpFsmDir, 'clear.fsm.ts');
  const source = `import { aharness, state, terminal, exit } from '@aharness/core';
interface P { value: string }
export const machine = aharness.machine({
  id: 'clear-catalog',
  initial: 'start',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    start: state({
      entryPrompt: 'Start.',
      exits: { next: exit<P>({ to: 'clear' }) },
    }),
    clear: state({
      entryPrompt: 'Clear.',
      model: ${stateModel},
      exits: { done: exit<P>({ to: 'done' }) },
    }),
    done: terminal('success'),
  },
});
export default machine;
`;
  await fs.writeFile(tmpFsmPath, source, 'utf8');
  return tmpFsmPath;
}

async function writeRetiredOwnerDecisionFixture(kind: 'ask' | 'await'): Promise<string> {
  const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-retired-'));
  const tmpFsmPath = join(tmpFsmDir, `${kind}.fsm.ts`);
  const stateBody =
    kind === 'ask'
      ? `fsm.state({
      prompt: 'Start.',
      ask: 'Continue?',
      on: { done: fsm.submit<P>({ to: 'done' }) },
    })`
      : `fsm.state({
      prompt: 'Start.',
      on: { done: fsm.await({ ask: 'Continue?', to: 'done' }) },
    })`;
  const source = `// @ts-nocheck
import { createFsm } from '@aharness/core';
interface Data { ok: boolean }
interface P { ok: boolean }
const fsm = createFsm<Data>();
export default fsm.machine({
  id: 'retired-${kind}',
  data: () => ({ ok: false }),
  initial: 'start',
  states: {
    start: ${stateBody},
    done: fsm.final({ outcome: 'success' }),
  },
});
`;
  await fs.writeFile(tmpFsmPath, source, 'utf8');
  return tmpFsmPath;
}

type ModelListResponse = Awaited<ReturnType<CodexConfigModelProvider['listModels']>>;

type FakeCatalogProviderOpts = {
  readonly configModel?: string | null;
  readonly models?: ModelListResponse['data'];
  readonly pages?: ReadonlyArray<ModelListResponse>;
  readonly listModelsError?: unknown;
};

function fakeCatalogProvider(opts: FakeCatalogProviderOpts = {}): CodexConfigModelProvider & {
  readonly readConfig: ReturnType<typeof vi.fn<CodexConfigModelProvider['readConfig']>>;
  readonly listModels: ReturnType<typeof vi.fn<CodexConfigModelProvider['listModels']>>;
} {
  const pages = opts.pages ?? [
    {
      data: opts.models ?? [],
      nextCursor: null,
    },
  ];
  return {
    readConfig: vi.fn(async () => ({
      config: {
        ...(opts.configModel !== undefined ? { model: opts.configModel } : {}),
      },
    })),
    listModels: vi.fn(async ({ cursor }) => {
      if (opts.listModelsError !== undefined) {
        throw opts.listModelsError;
      }
      if (cursor === undefined || cursor === null) {
        return pages[0] ?? { data: [], nextCursor: null };
      }
      const pageNumber = Number(cursor.replace('page-', ''));
      return pages[pageNumber - 1] ?? { data: [], nextCursor: null };
    }),
  };
}
