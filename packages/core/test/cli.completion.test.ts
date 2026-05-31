/**
 * Tests for `aharness completion install|uninstall` (Task 19).
 *
 * Mocking strategy: `vi.mock('@pnpm/tabtab', { spy: true })` is the
 * documented Vitest pattern for spying on ESM modules — `vi.spyOn` on
 * a namespace import fails on ESM because module namespace objects are
 * sealed and cannot be reconfigured. With `{ spy: true }`, every export
 * is wrapped in a spy but the original implementation is preserved
 * unless we explicitly override it via `mockResolvedValue` /
 * `mockImplementation`. That gives Tasks 20+21 the real `parseEnv`
 * (no override) while letting these unit tests intercept `install` /
 * `uninstall` (explicit overrides) so we don't side-effect the real
 * filesystem during `pnpm test`.
 *
 * The integration test runs `runCompletionInstall` in a fresh subprocess
 * with `HOME=tmpdir` so the transitive `untildify` dep — which caches
 * `os.homedir()` at module-load time — captures the redirected home.
 * In-process `process.env.HOME = ...` cannot work because `untildify`
 * is already loaded by the time `beforeEach` runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import * as tabtab from '@pnpm/tabtab';
import { runCompletionInstall, runCompletionUninstall } from '../src/cli/completion.js';
import { enumerateFs, runCompletionBridge } from '../src/cli/completionBridge.js';
import {
  INSTALL_STORE_SCHEMA_VERSION,
  type TrustedCommandIndexEntry,
  type TrustedInstallRecord,
} from '../src/installStore/index.js';

vi.mock('@pnpm/tabtab', { spy: true });

describe('runCompletionInstall', () => {
  beforeEach(() => {
    vi.mocked(tabtab.install).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.mocked(tabtab.install).mockRestore();
  });

  it('forwards default {name, completer} to tabtab.install', async () => {
    const result = await runCompletionInstall({});
    expect(result.exitCode).toBe(0);
    expect(tabtab.install).toHaveBeenCalledWith({ name: 'aharness', completer: 'aharness' });
  });

  it('forwards {shell} when provided', async () => {
    await runCompletionInstall({ shell: 'bash' });
    expect(tabtab.install).toHaveBeenCalledWith({
      name: 'aharness',
      completer: 'aharness',
      shell: 'bash',
    });
  });

  it('returns non-zero when tabtab.install rejects', async () => {
    vi.mocked(tabtab.install).mockRejectedValueOnce(new Error('boom'));
    const result = await runCompletionInstall({});
    expect(result.exitCode).toBe(1);
  });
});

describe('runCompletionUninstall', () => {
  beforeEach(() => {
    vi.mocked(tabtab.uninstall).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.mocked(tabtab.uninstall).mockRestore();
  });

  it('forwards default {name} to tabtab.uninstall', async () => {
    const result = await runCompletionUninstall({});
    expect(result.exitCode).toBe(0);
    expect(tabtab.uninstall).toHaveBeenCalledWith({ name: 'aharness' });
  });
});

const fixture = path.resolve(__dirname, 'fixtures/args/typed-input.fsm.ts');

function makeEnv(line: string, point?: number): NodeJS.ProcessEnv {
  const p = point ?? line.length;
  return {
    COMP_LINE: line,
    COMP_POINT: String(p),
    COMP_CWORD: String(line.split(/\s+/).length - 1),
  } as NodeJS.ProcessEnv;
}

function makeEnvWithHome(line: string, storeRoot: string): NodeJS.ProcessEnv {
  return { ...makeEnv(line), AHARNESS_HOME: storeRoot };
}

async function captureBridge(
  line: string,
  opts: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on('data', (c) => chunks.push(c.toString()));
  await runCompletionBridge({
    env: { ...makeEnv(line), ...opts.env },
    cwd: opts.cwd ?? process.cwd(),
    stdout: out,
  });
  return chunks.join('').split('\n').filter(Boolean);
}

function writeCompletionStore(
  storeRoot: string,
  opts: {
    readonly installs: Record<string, TrustedInstallRecord>;
    readonly commands: Record<string, TrustedCommandIndexEntry>;
    readonly generation: string;
  },
): void {
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(storeRoot, 'installs.json'),
    JSON.stringify({
      schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
      generation: opts.generation,
      installs: opts.installs,
    }),
  );
  fs.writeFileSync(
    path.join(storeRoot, 'commands.json'),
    JSON.stringify({
      schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
      generation: opts.generation,
      commands: opts.commands,
    }),
  );
}

function commandIndexEntry(
  packageName: string,
  commandName: string,
  description?: string,
): TrustedCommandIndexEntry {
  return {
    packageName,
    commandName,
    entry: `${commandName}.fsm.ts`,
    packageRoot: `/virtual/${packageName}`,
    lockFingerprint: `${packageName}-${commandName}-lock`,
    ...(description !== undefined ? { description } : {}),
  };
}

describe('runCompletionBridge — root completion', () => {
  it('emits sorted root subcommands when completing after aharness', async () => {
    const lines = await captureBridge('aharness ');
    expect(lines).toEqual([
      'completion',
      'doctor',
      'init',
      'install',
      'list',
      'run',
      'uninstall',
      'verify',
      'visualize',
    ]);
  });

  it('filters root subcommands by partial', async () => {
    const lines = await captureBridge('aharness ru');
    expect(lines).toEqual(['run']);
  });

  it('delegates path-like first tokens to native file completion', async () => {
    const lines = await captureBridge('aharness ./');
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });
});

describe('runCompletionBridge — run target completion', () => {
  let cwd: string;
  let storeRoot: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-run-completion-cwd-'));
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-run-completion-store-'));
    fs.writeFileSync(path.join(cwd, 'alpha.fsm.ts'), '');
    fs.writeFileSync(path.join(cwd, 'alpha.txt'), '');
    fs.mkdirSync(path.join(cwd, 'nested'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it('includes local .fsm.ts files and directories after run', async () => {
    const lines = await captureBridge('aharness run ', { cwd });
    expect(lines).toContain('alpha.fsm.ts');
    expect(lines).toContain('nested');
    expect(lines).not.toContain('alpha.txt');
  });

  it('filters local run targets by partial', async () => {
    const lines = await captureBridge('aharness run a', { cwd });
    expect(lines).toContain('alpha.fsm.ts');
    expect(lines).not.toContain('nested');
  });

  it('includes local run targets after run flags', async () => {
    const lines = await captureBridge('aharness run --yolo ', { cwd });
    expect(lines).toContain('alpha.fsm.ts');
  });

  it('includes unique bare installed names and fully qualified installed identities', async () => {
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
        '@scope/tools/deploy': commandIndexEntry('@scope/tools', 'deploy'),
      },
    });

    const lines = await captureBridge('aharness run ', {
      cwd,
      env: makeEnvWithHome('aharness run ', storeRoot),
    });
    expect(lines).toContain('build');
    expect(lines).toContain('deploy');
    expect(lines).toContain('@scope/tools/build');
    expect(lines).toContain('@scope/tools/deploy');
  });

  it('filters installed identities by scoped partial', async () => {
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
        '@scope/tools/deploy': commandIndexEntry('@scope/tools', 'deploy'),
      },
    });

    const lines = await captureBridge('aharness run @scope/', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/', storeRoot),
    });
    expect(lines).toContain('@scope/tools/build');
    expect(lines).toContain('@scope/tools/deploy');
  });

  it('omits ambiguous bare installed names and keeps qualified alternatives', async () => {
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
        '@other/tools/build': commandIndexEntry('@other/tools', 'build'),
      },
    });

    const lines = await captureBridge('aharness run b', {
      cwd,
      env: makeEnvWithHome('aharness run b', storeRoot),
    });
    expect(lines).not.toContain('build');
    expect(lines).toContain('@scope/tools/build');
    expect(lines).toContain('@other/tools/build');
  });

  it('suppresses installed bare names that collide with local regular files', async () => {
    fs.writeFileSync(path.join(cwd, 'build'), '');
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
      },
    });

    const lines = await captureBridge('aharness run b', {
      cwd,
      env: makeEnvWithHome('aharness run b', storeRoot),
    });
    expect(lines).not.toContain('build');
    expect(lines).toContain('@scope/tools/build');
  });

  it('omits installed suggestions and does not create or rewrite store files for malformed or missing stores', async () => {
    const missingLines = await captureBridge('aharness run b', {
      cwd,
      env: makeEnvWithHome('aharness run b', storeRoot),
    });
    expect(missingLines).not.toContain('build');
    expect(fs.existsSync(path.join(storeRoot, 'commands.json'))).toBe(false);

    const malformedInstalls = '{ "schemaVersion": 1, "generation": "", "installs": {} }';
    const commands = JSON.stringify({
      schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
      },
    });
    fs.writeFileSync(path.join(storeRoot, 'installs.json'), malformedInstalls);
    fs.writeFileSync(path.join(storeRoot, 'commands.json'), commands);

    const malformedLines = await captureBridge('aharness run b', {
      cwd,
      env: makeEnvWithHome('aharness run b', storeRoot),
    });
    expect(malformedLines).not.toContain('build');
    expect(malformedLines).not.toContain('@scope/tools/build');
    expect(fs.readFileSync(path.join(storeRoot, 'commands.json'), 'utf8')).toBe(commands);
  });
});

describe('runCompletionBridge — flag-name completion', () => {
  it('emits matching --<kebab-name> when cursor is on --<partial>', async () => {
    const lines = await captureBridge(`aharness ${fixture} --id`);
    expect(lines.some((l) => l.startsWith('--ideafile-path'))).toBe(true);
  });

  it('emits all flag names when cursor is on bare --', async () => {
    const lines = await captureBridge(`aharness ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('does not scan later .ts flag values for direct FSM input completion', async () => {
    const lines = await captureBridge(`aharness build --spec ${fixture} --`);
    expect(lines).toEqual([]);
  });

  it('emits all flag names when cursor is empty after fsm path', async () => {
    const lines = await captureBridge(`aharness ${fixture} `);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });
});

describe('runCompletionBridge — FSM path completion', () => {
  it('delegates to shell file completion while completing a direct FSM path', async () => {
    const lines = await captureBridge('aharness packages/core/test/fixtures/args/');
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });

  it('delegates to shell file completion after the visualize subcommand', async () => {
    const lines = await captureBridge('aharness visualize ');
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });
});

describe('runCompletionBridge — static value completion', () => {
  it('emits matching values for completion: {values: [...]}', async () => {
    const lines = await captureBridge(`aharness ${fixture} --choice a`);
    const names = lines.map((l) => l.split(':')[0]);
    expect(names).toContain('a');
  });

  it('delegates file-valued input completion to native file completion', async () => {
    const lines = await captureBridge(`aharness ${fixture} --ideafile-path `);
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });
});

describe('runCompletionBridge — silent on bad input', () => {
  it('emits nothing when no FSM file is in the line', async () => {
    const lines = await captureBridge('aharness --');
    expect(lines).toEqual([]);
  });

  it('emits nothing when FSM file does not exist', async () => {
    const lines = await captureBridge('aharness /nonexistent.fsm.ts --');
    expect(lines).toEqual([]);
  });
});

const dynamicFixture = path.resolve(__dirname, 'fixtures/args/dynamic-completion.fsm.ts');

describe('runCompletionBridge — dynamic value completion', () => {
  it('invokes the dynamic callback and emits matching values', async () => {
    const lines = await captureBridge(`aharness ${dynamicFixture} --project a`);
    const names = lines.map((l) => l.split(':')[0]);
    expect(names).toEqual(['alpha']);
  });

  it('emits empty output when callback throws', async () => {
    // Use the `broken` arg whose dynamic callback throws unconditionally.
    // The bridge's try/catch around the callback invocation should swallow
    // the error and emit nothing.
    const lines = await captureBridge(`aharness ${dynamicFixture} --broken anything`);
    expect(lines).toEqual([]);
  });
});

describe('enumerateFs — dense-directory regression', () => {
  // Regression test for the cap-then-filter bug: in directories with more
  // than FILE_ENUMERATE_CAP (1000) entries where prefix-matching entries
  // sort past position 1000 in readdir order, the previous implementation
  // filled its cap with non-matching entries and emitted nothing. The fix
  // counts the cap against MATCHED entries so the user sees real matches.
  //
  // This populates 1100 `aaa-NNNN.ts` files (which sort before `zzz-*` in
  // alphabetical readdir order) plus 5 `zzz-match-NNN.ts` files. With the
  // cap at 1000, the buggy code would never reach the `zzz-*` entries.
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-enumerate-fs-'));
    for (let i = 1; i <= 1100; i++) {
      fs.writeFileSync(path.join(tmpDir, `aaa-${String(i).padStart(4, '0')}.ts`), '');
    }
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `zzz-match-${String(i).padStart(3, '0')}.ts`), '');
    }
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits prefix matches that sort past the cap', () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on('data', (c) => chunks.push(c.toString()));
    enumerateFs(path.join(tmpDir, 'zzz'), false, out);
    const lines = chunks.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => path.basename(l).startsWith('zzz'))).toBe(true);
    expect(lines.some((l) => path.basename(l).startsWith('zzz-match-'))).toBe(true);
  });
});

describe('runCompletionInstall — integration (real tabtab, redirected HOME via subprocess)', () => {
  it('writes the bridge script under <HOME>/.config/tabtab/', () => {
    // Spawn a fresh `node` so untildify (transitive dep of tabtab) caches
    // tmpHome at its OWN module-load time. In-process HOME redirection
    // cannot work — untildify reads os.homedir() once at load and caches.
    //
    // Node 24+ runs .ts files natively (built-in type stripping), so we
    // can point at the source directly without a build step. If a future
    // Node downgrade breaks this, fall back to spawning against
    // `dist/cli/completion.js` after `pnpm --filter @aharness/core build`.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-completion-'));
    try {
      const completionTs = path.resolve(__dirname, '../src/cli/completion.ts');
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `import(${JSON.stringify(completionTs)}).then(m => m.runCompletionInstall({shell: 'bash'})).then(r => process.exit(r.exitCode));`,
        ],
        {
          env: { ...process.env, HOME: tmpHome },
          encoding: 'utf8',
        },
      );
      expect(child.status, `child stderr:\n${child.stderr}`).toBe(0);
      const tabtabDir = path.join(tmpHome, '.config', 'tabtab');
      expect(fs.existsSync(tabtabDir)).toBe(true);
      const entries = fs.readdirSync(tabtabDir, { recursive: true, encoding: 'utf8' });
      expect(entries.some((e) => String(e).includes('aharness'))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
