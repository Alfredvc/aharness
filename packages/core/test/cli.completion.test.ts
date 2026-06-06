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
  computeLockFingerprint,
  INSTALL_STORE_SCHEMA_VERSION,
  type TrustedCommandIndexEntry,
  type TrustedInstallRecord,
} from '../src/installStore/index.js';
import { cachePathsFor, hashSourceTree, type SerializedSidecar } from '../src/loader/cache.js';

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
    expect(tabtab.install).toHaveBeenCalledWith({
      name: 'aharness',
      completer: 'aharness-completion',
    });
  });

  it('forwards {shell} when provided', async () => {
    await runCompletionInstall({ shell: 'bash' });
    expect(tabtab.install).toHaveBeenCalledWith({
      name: 'aharness',
      completer: 'aharness-completion',
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

  it('removes aharness tabtab files while ignoring shells that were never installed', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-completion-uninstall-'));
    const oldHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      const zshTabtabDir = path.join(tmpHome, '.config', 'tabtab', 'zsh');
      fs.mkdirSync(zshTabtabDir, { recursive: true });
      fs.writeFileSync(path.join(zshTabtabDir, 'aharness.zsh'), '# aharness completion\n');
      fs.writeFileSync(path.join(zshTabtabDir, 'ccairgap.zsh'), '# ccairgap completion\n');
      fs.writeFileSync(
        path.join(zshTabtabDir, '__tabtab.zsh'),
        [
          '',
          '# tabtab source for ccairgap package',
          '# uninstall by removing these lines',
          '[[ -f ~/.config/tabtab/zsh/ccairgap.zsh ]] && . ~/.config/tabtab/zsh/ccairgap.zsh || true',
          '',
          '# tabtab source for aharness package',
          '# uninstall by removing these lines',
          '[[ -f ~/.config/tabtab/zsh/aharness.zsh ]] && . ~/.config/tabtab/zsh/aharness.zsh || true',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmpHome, '.zshrc'),
        [
          '# existing zsh config',
          '# tabtab source for packages',
          '# uninstall by removing these lines',
          '[[ -f ~/.config/tabtab/zsh/__tabtab.zsh ]] && . ~/.config/tabtab/zsh/__tabtab.zsh || true',
          '',
        ].join('\n'),
      );

      const result = await runCompletionUninstall({});

      expect(result.exitCode).toBe(0);
      expect(tabtab.uninstall).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpHome, '.config', 'tabtab', 'bash'))).toBe(false);
      expect(fs.existsSync(path.join(zshTabtabDir, 'aharness.zsh'))).toBe(false);
      expect(fs.readFileSync(path.join(zshTabtabDir, '__tabtab.zsh'), 'utf8')).toContain(
        'ccairgap',
      );
      expect(fs.readFileSync(path.join(zshTabtabDir, '__tabtab.zsh'), 'utf8')).not.toContain(
        'aharness',
      );
      expect(fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf8')).toContain('__tabtab.zsh');
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('removes the shell rc tabtab source when aharness was the last package', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-completion-uninstall-'));
    const oldHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      const zshTabtabDir = path.join(tmpHome, '.config', 'tabtab', 'zsh');
      fs.mkdirSync(zshTabtabDir, { recursive: true });
      fs.writeFileSync(path.join(zshTabtabDir, 'aharness.zsh'), '# aharness completion\n');
      fs.writeFileSync(
        path.join(zshTabtabDir, '__tabtab.zsh'),
        [
          '',
          '# tabtab source for aharness package',
          '# uninstall by removing these lines',
          '[[ -f ~/.config/tabtab/zsh/aharness.zsh ]] && . ~/.config/tabtab/zsh/aharness.zsh || true',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmpHome, '.zshrc'),
        [
          '# existing zsh config',
          '# tabtab source for packages',
          '# uninstall by removing these lines',
          '[[ -f ~/.config/tabtab/zsh/__tabtab.zsh ]] && . ~/.config/tabtab/zsh/__tabtab.zsh || true',
          'export OTHER=value',
          '',
        ].join('\n'),
      );

      const result = await runCompletionUninstall({});

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(zshTabtabDir, 'aharness.zsh'))).toBe(false);
      expect(fs.readFileSync(path.join(zshTabtabDir, '__tabtab.zsh'), 'utf8').trim()).toBe('');
      expect(fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf8')).not.toContain('__tabtab.zsh');
      expect(fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf8')).toContain('export OTHER=value');
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('treats already-missing completion files as uninstalled', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-completion-uninstall-'));
    const oldHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      const result = await runCompletionUninstall({});

      expect(result.exitCode).toBe(0);
      expect(tabtab.uninstall).not.toHaveBeenCalled();
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

const fixture = path.resolve(__dirname, 'fixtures/args/typed-input.fsm.ts');
const booleanFixture = path.resolve(__dirname, 'fixtures/args/boolean-input.fsm.ts');

describe('completionBridge module graph', () => {
  it('does not import the broad install-store barrel', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/completionBridge.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/from ['"]\.\.\/installStore\/index\.js['"]/);
  });
});

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

async function writeInstalledCompletionFixture(
  storeRoot: string,
  opts: {
    readonly source: string;
    readonly lockFingerprint?: string;
    readonly commandName?: string;
  },
): Promise<{
  readonly managedProjectRoot: string;
  readonly packageRoot: string;
  readonly entryFile: string;
  readonly lockFingerprint: string;
}> {
  const commandName = opts.commandName ?? 'build';
  const managedProjectRoot = path.join(storeRoot, 'packages');
  const packageRoot = path.join(managedProjectRoot, 'node_modules/@scope/tools');
  const entryFile = path.join(packageRoot, `fsms/${commandName}.fsm.ts`);
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.writeFileSync(entryFile, opts.source);
  fs.writeFileSync(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: {
            '@scope/tools': '1.0.0',
          },
        },
        'node_modules/@scope/tools': {
          version: '1.0.0',
        },
      },
    }),
  );

  const computed = await computeLockFingerprint({
    managedProjectRoot,
    dependencyKey: '@scope/tools',
    packageName: '@scope/tools',
    packageVersion: '1.0.0',
  });
  if (!computed.ok) {
    throw new Error(computed.diagnostics.map((d) => d.message).join('\n'));
  }
  const lockFingerprint = opts.lockFingerprint ?? computed.value;
  const install: TrustedInstallRecord = {
    packageName: '@scope/tools',
    dependencyKey: '@scope/tools',
    requestedSpec: '@scope/tools@1.0.0',
    packageRoot,
    packageVersion: '1.0.0',
    sourceIntentKey: 'registry:@scope/tools@1.0.0',
    lockFingerprint,
    commands: {
      [commandName]: {
        commandName,
        entry: `fsms/${commandName}.fsm.ts`,
      },
    },
  };
  writeCompletionStore(storeRoot, {
    installs: {
      '@scope/tools': install,
    },
    generation: 'test-generation',
    commands: {
      [`@scope/tools/${commandName}`]: {
        packageName: '@scope/tools',
        commandName,
        entry: `fsms/${commandName}.fsm.ts`,
        packageRoot,
        packageVersion: '1.0.0',
        lockFingerprint,
      },
    },
  });

  return { managedProjectRoot, packageRoot, entryFile, lockFingerprint };
}

function staticInstalledFsmSource(prefix = ''): string {
  return `${prefix}
import { aharness, state, exit, final, arg } from '@aharness/core';

export default aharness.machine({
  input: {
    choice: arg<string>({ description: 'Choice', completion: { values: ['alpha', 'beta'] } }),
    topic: arg<string>({ description: 'Topic' }),
  },
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
`;
}

function dynamicInstalledFsmSource(prefix = ''): string {
  return `${prefix}
import { aharness, state, exit, final, arg } from '@aharness/core';

export default aharness.machine({
  input: {
    project: arg<string>({
      description: 'Project',
      completion: {
        dynamic: (partial) => ['alpha', 'beta'].filter((value) => value.startsWith(partial)),
      },
    }),
  },
  initial: 'go',
  states: {
    go: state({
      entryPrompt: 'go',
      exits: { out: exit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: final({ outcome: 'success' }),
  },
});
`;
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
      'view',
      'visualize',
    ]);
  });

  it('filters root subcommands by partial', async () => {
    const lines = await captureBridge('aharness ru');
    expect(lines).toEqual(['run']);
  });

  it('emits no file completion for retired direct path targets', async () => {
    const lines = await captureBridge('aharness ./');
    expect(lines).toEqual([]);
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
    for (const flag of ['--ask', '--yolo', '--no-open']) {
      const lines = await captureBridge(`aharness run ${flag} `, { cwd });
      expect(lines).toContain('alpha.fsm.ts');
    }
  });

  it('includes installed run targets after --ask', async () => {
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
      },
    });

    const lines = await captureBridge('aharness run --ask ', {
      cwd,
      env: makeEnvWithHome('aharness run --ask ', storeRoot),
    });
    expect(lines).toContain('build');
    expect(lines).toContain('@scope/tools/build');
  });

  it('includes installed run targets after --no-open', async () => {
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        '@scope/tools/build': commandIndexEntry('@scope/tools', 'build'),
      },
    });

    const lines = await captureBridge('aharness run --no-open ', {
      cwd,
      env: makeEnvWithHome('aharness run --no-open ', storeRoot),
    });
    expect(lines).toContain('build');
    expect(lines).toContain('@scope/tools/build');
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

  it('keeps installed bare names that collide with non-FSM local regular files', async () => {
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
    expect(lines).toContain('build');
    expect(lines).toContain('@scope/tools/build');
  });

  it('suppresses malformed installed suggestions that collide with exact local .fsm.ts targets', async () => {
    fs.writeFileSync(path.join(cwd, 'build.fsm.ts'), '');
    writeCompletionStore(storeRoot, {
      installs: {},
      generation: 'test-generation',
      commands: {
        // Installed command names are validated before entering the trusted
        // store; this malformed fixture pins collision behavior if a stale or
        // corrupt snapshot ever contains a local-FSM-shaped command name.
        '@scope/tools/build.fsm.ts': commandIndexEntry(
          '@scope/tools',
          'build.fsm.ts',
          'Installed build',
        ),
      },
    });

    const lines = await captureBridge('aharness run build', {
      cwd,
      env: makeEnvWithHome('aharness run build', storeRoot),
    });
    expect(lines).toContain('build.fsm.ts');
    expect(lines).not.toContain('build.fsm.ts:Installed build');
    expect(lines).not.toContain('@scope/tools/build.fsm.ts:Installed build');
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
  it('emits local FSM flags after aharness run <target> --', async () => {
    const lines = await captureBridge(`aharness run ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('emits matching --<kebab-name> when cursor is on --<partial>', async () => {
    const lines = await captureBridge(`aharness run ${fixture} --id`);
    expect(lines.some((l) => l.startsWith('--ideafile-path'))).toBe(true);
  });

  it('emits all flag names when cursor is on bare --', async () => {
    const lines = await captureBridge(`aharness run ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('emits no input completions for retired direct FSM target forms', async () => {
    const lines = await captureBridge(`aharness ${fixture} --`);
    expect(lines).toEqual([]);
  });

  it('emits no input completions for retired relative direct FSM target forms', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-direct-completion-cwd-'));
    try {
      fs.writeFileSync(path.join(cwd, 'workflow.fsm.ts'), fs.readFileSync(fixture, 'utf8'));
      const lines = await captureBridge('aharness ./workflow.fsm.ts --', { cwd });
      expect(lines).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('emits run FSM flags for a cwd-relative .fsm.ts target that is not path-like', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-run-completion-cwd-'));
    try {
      const source = fs.readFileSync(fixture, 'utf8');
      fs.writeFileSync(path.join(cwd, 'workflow.fsm.ts'), source);

      const lines = await captureBridge('aharness run workflow.fsm.ts --', { cwd });
      const names = lines.map((l) => l.split(':')[0]).sort();
      expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('emits run FSM flags after leading --yolo', async () => {
    const lines = await captureBridge(`aharness run --yolo ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('emits run FSM flags after leading --ask', async () => {
    const lines = await captureBridge(`aharness run --ask ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('emits run FSM flags after leading --no-open', async () => {
    const lines = await captureBridge(`aharness run --no-open ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('emits run FSM flags after combined leading runtime flags', async () => {
    const lines = await captureBridge(`aharness run --ask --no-open ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('emits no completions after conflicting leading run permission flags', async () => {
    const lines = await captureBridge(`aharness run --ask --yolo ${fixture} --`);
    expect(lines).toEqual([]);
  });

  it('emits no completions after repeated leading --no-open', async () => {
    const lines = await captureBridge(`aharness run --no-open --no-open ${fixture} --`);
    expect(lines).toEqual([]);
  });

  it('emits no input completions for retired direct post-target permission forms', async () => {
    for (const flag of ['--ask', '--yolo']) {
      const lines = await captureBridge(`aharness ${fixture} ${flag} --`);
      expect(lines).toEqual([]);
    }
  });

  it('rejects post-target runtime permission flags for run and visualize completions', async () => {
    const runLines = await captureBridge(`aharness run ${fixture} --ask --`);
    const visualizeLines = await captureBridge(`aharness visualize ${fixture} --ask --`);
    expect(runLines).toEqual([]);
    expect(visualizeLines).toEqual([]);
  });

  it('rejects post-target --no-open for run and visualize completions', async () => {
    const runLines = await captureBridge(`aharness run ${fixture} --no-open --`);
    const visualizeLines = await captureBridge(`aharness visualize ${fixture} --no-open --`);
    expect(runLines).toEqual([]);
    expect(visualizeLines).toEqual([]);
  });

  it('emits no input completions when retired direct runtime permission flags are mixed', async () => {
    const leadingMix = await captureBridge(`aharness --ask ${fixture} --yolo --`);
    const trailingMix = await captureBridge(`aharness ${fixture} --ask --yolo --`);
    expect(leadingMix).toEqual([]);
    expect(trailingMix).toEqual([]);
  });

  it('emits visualize FSM flags after the target', async () => {
    const lines = await captureBridge(`aharness visualize ${fixture} --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('does not scan later .ts flag values for input completion', async () => {
    const lines = await captureBridge(`aharness build --spec ${fixture} --`);
    expect(lines).toEqual([]);
  });

  it('does not treat a later run --spec value as the run target', async () => {
    const lines = await captureBridge(`aharness run build --spec ./other.fsm.ts --`);
    expect(lines).toEqual([]);
  });

  it('emits nothing for malformed run input flags before the target', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-run-malformed-cwd-'));
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-run-malformed-store-'));
    try {
      await writeInstalledCompletionFixture(storeRoot, {
        source: staticInstalledFsmSource(),
        commandName: 'auth',
      });

      const lines = await captureBridge('aharness run --topic auth --', {
        cwd,
        env: makeEnvWithHome('aharness run --topic auth --', storeRoot),
      });
      expect(lines).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it('emits all flag names when cursor is empty after fsm path', async () => {
    const lines = await captureBridge(`aharness run ${fixture} `);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('serves local static flags from a warm loader cache without sidecar extraction', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-cached-completion-cwd-'));
    try {
      const entry = path.join(cwd, 'workflow.fsm.ts');
      fs.writeFileSync(entry, '// intentionally not an extractable FSM\n');

      const hash = await hashSourceTree(cwd, entry);
      const cachePaths = cachePathsFor(cwd, hash);
      fs.mkdirSync(cachePaths.cacheDir, { recursive: true });
      const sidecar: SerializedSidecar = {
        schemas: {},
        issues: [],
        skillOriginManifest: {
          rootSourceDir: cwd,
          sourceDirPrefixes: [],
          availableSkills: [],
        },
        inputSchema: {
          type: 'object',
          properties: {
            choice: { type: 'string' },
            topic: { type: 'string' },
          },
        },
        inputFlags: {
          choice: { description: 'Choice', completion: { values: ['alpha', 'beta'] } },
          topic: { description: 'Topic' },
        },
      };
      fs.writeFileSync(
        cachePaths.modulePath,
        `export const __sidecar = ${JSON.stringify(sidecar)};\nthrow new Error('cache bundle should not be imported for static completion');\n`,
      );

      const lines = await captureBridge('aharness run workflow.fsm.ts --', { cwd });
      const names = lines.map((l) => l.split(':')[0]).sort();
      expect(names).toEqual(['--choice', '--topic']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hides used flags after their value token', async () => {
    const lines = await captureBridge(`aharness run ${fixture} --topic auth --`);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs']);
  });
});

describe('runCompletionBridge — boolean input completion', () => {
  it('treats bare booleans as consumed and suggests remaining flags', async () => {
    const lines = await captureBridge(`aharness run ${booleanFixture} --worktree `);
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--ideafile-path', '--topic']);
  });

  it('suggests true for boolean value prefix t', async () => {
    const lines = await captureBridge(`aharness run ${booleanFixture} --worktree t`);
    expect(lines).toEqual(['true']);
  });

  it('suggests false for boolean value prefix f', async () => {
    const lines = await captureBridge(`aharness run ${booleanFixture} --worktree f`);
    expect(lines).toEqual(['false']);
  });

  it.each(['true', 'false'])(
    'treats explicit boolean value %s as consumed and suggests remaining flags',
    async (value) => {
      const lines = await captureBridge(`aharness run ${booleanFixture} --worktree ${value} --`);
      const names = lines.map((l) => l.split(':')[0]).sort();
      expect(names).toEqual(['--ideafile-path', '--topic']);
    },
  );

  it('emits no suggestions for invalid explicit boolean values', async () => {
    const lines = await captureBridge(`aharness run ${booleanFixture} --worktree maybe`);
    expect(lines).toEqual([]);
  });
});

describe('runCompletionBridge — installed input completion', () => {
  let cwd: string;
  let storeRoot: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-installed-completion-cwd-'));
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-installed-completion-store-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it('emits installed static input flags after a qualified run target', async () => {
    await writeInstalledCompletionFixture(storeRoot, { source: staticInstalledFsmSource() });

    const lines = await captureBridge('aharness run @scope/tools/build --', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --', storeRoot),
    });
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--topic']);
  });

  it('emits installed static value completion after a qualified run target', async () => {
    await writeInstalledCompletionFixture(storeRoot, { source: staticInstalledFsmSource() });

    const lines = await captureBridge('aharness run @scope/tools/build --choice a', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --choice a', storeRoot),
    });
    expect(lines).toEqual(['alpha']);
  });

  it('uses static sidecar extraction for installed flags and values without importing the FSM', async () => {
    await writeInstalledCompletionFixture(storeRoot, {
      source: staticInstalledFsmSource("throw new Error('top-level import should not run');"),
    });

    const flagLines = await captureBridge('aharness run @scope/tools/build --', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --', storeRoot),
    });
    const valueLines = await captureBridge('aharness run @scope/tools/build --choice a', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --choice a', storeRoot),
    });
    expect(flagLines.map((l) => l.split(':')[0]).sort()).toEqual(['--choice', '--topic']);
    expect(valueLines).toEqual(['alpha']);
  });

  it('emits flags after a unique bare installed command when no local build file exists', async () => {
    await writeInstalledCompletionFixture(storeRoot, { source: staticInstalledFsmSource() });

    const lines = await captureBridge('aharness run build --', {
      cwd,
      env: makeEnvWithHome('aharness run build --', storeRoot),
    });
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--topic']);
  });

  it('uses installed command completion when a non-FSM local file has the same name', async () => {
    fs.writeFileSync(path.join(cwd, 'build'), staticInstalledFsmSource());
    await writeInstalledCompletionFixture(storeRoot, { source: dynamicInstalledFsmSource() });

    const lines = await captureBridge('aharness run build --', {
      cwd,
      env: makeEnvWithHome('aharness run build --', storeRoot),
    });
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--project']);
  });

  it('uses local input completion for .fsm.ts targets before installed command completion', async () => {
    fs.writeFileSync(path.join(cwd, 'build.fsm.ts'), fs.readFileSync(fixture, 'utf8'));
    await writeInstalledCompletionFixture(storeRoot, {
      source: staticInstalledFsmSource(),
      commandName: 'build.fsm.ts',
    });

    const lines = await captureBridge('aharness run build.fsm.ts --', {
      cwd,
      env: makeEnvWithHome('aharness run build.fsm.ts --', storeRoot),
    });
    const names = lines.map((l) => l.split(':')[0]).sort();
    expect(names).toEqual(['--choice', '--ideafile-path', '--runs', '--topic']);
  });

  it('does not fall through to installed completion for missing .fsm.ts run targets', async () => {
    await writeInstalledCompletionFixture(storeRoot, {
      source: staticInstalledFsmSource(),
      commandName: 'missing.fsm.ts',
    });

    const lines = await captureBridge('aharness run missing.fsm.ts --', {
      cwd,
      env: makeEnvWithHome('aharness run missing.fsm.ts --', storeRoot),
    });
    expect(lines).toEqual([]);
  });

  it('emits installed dynamic value completion for a trusted installed command', async () => {
    await writeInstalledCompletionFixture(storeRoot, { source: dynamicInstalledFsmSource() });

    const lines = await captureBridge('aharness run @scope/tools/build --project a', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --project a', storeRoot),
    });
    expect(lines).toEqual(['alpha']);
  });

  it('does not import an installed FSM for dynamic completion when the lock fingerprint mismatches', async () => {
    const marker = path.join(storeRoot, 'imported-marker');
    await writeInstalledCompletionFixture(storeRoot, {
      source: dynamicInstalledFsmSource(
        `import * as fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'imported');`,
      ),
      lockFingerprint: 'stale-lock',
    });

    const lines = await captureBridge('aharness run @scope/tools/build --project a', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --project a', storeRoot),
    });
    expect(lines).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('emits no installed input flags when the lock fingerprint mismatches', async () => {
    await writeInstalledCompletionFixture(storeRoot, {
      source: staticInstalledFsmSource(),
      lockFingerprint: 'stale-lock',
    });

    const lines = await captureBridge('aharness run @scope/tools/build --', {
      cwd,
      env: makeEnvWithHome('aharness run @scope/tools/build --', storeRoot),
    });
    expect(lines).toEqual([]);
  });
});

describe('runCompletionBridge — FSM path completion', () => {
  it('emits no file completion while completing a retired direct FSM path', async () => {
    const lines = await captureBridge('aharness packages/core/test/fixtures/args/');
    expect(lines).toEqual([]);
  });

  it('emits no file completion after retired direct-run --yolo', async () => {
    const lines = await captureBridge('aharness --yolo ');
    expect(lines).toEqual([]);
  });

  it('emits no file completion after retired direct-run --ask', async () => {
    const lines = await captureBridge('aharness --ask ');
    expect(lines).toEqual([]);
  });

  it('emits no file completion after retired direct-run --no-open', async () => {
    const lines = await captureBridge('aharness --no-open ');
    expect(lines).toEqual([]);
  });

  it('emits no file completion while completing a retired direct-run path after --yolo', async () => {
    const lines = await captureBridge('aharness --yolo ./');
    expect(lines).toEqual([]);
  });

  it('emits no file completion while completing a retired direct-run path after --ask', async () => {
    const lines = await captureBridge('aharness --ask ./');
    expect(lines).toEqual([]);
  });

  it('delegates to shell file completion after the visualize subcommand', async () => {
    const lines = await captureBridge('aharness visualize ');
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });

  it('delegates to shell file completion while completing a visualize target path', async () => {
    const lines = await captureBridge('aharness visualize ./');
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });

  it('delegates to shell file completion while completing a verify target path', async () => {
    const lines = await captureBridge('aharness verify ./');
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });

  it('does not delegate to shell file completion after a verify target', async () => {
    const lines = await captureBridge(`aharness verify ${fixture} `);
    expect(lines).toEqual([]);
  });

  it('does not delegate to shell file completion after a visualize target', async () => {
    const lines = await captureBridge(`aharness visualize ${fixture} `);
    expect(lines).not.toContain('__tabtab_complete_files__');
  });
});

describe('runCompletionBridge — static value completion', () => {
  it('emits matching values for completion: {values: [...]}', async () => {
    const lines = await captureBridge(`aharness run ${fixture} --choice a`);
    const names = lines.map((l) => l.split(':')[0]);
    expect(names).toContain('a');
  });

  it('emits no static value completion for retired direct FSM target forms', async () => {
    const lines = await captureBridge(`aharness ${fixture} --choice a`);
    expect(lines).toEqual([]);
  });

  it('delegates file-valued input completion to native file completion', async () => {
    const lines = await captureBridge(`aharness run ${fixture} --ideafile-path `);
    expect(lines).toEqual(['__tabtab_complete_files__']);
  });
});

describe('runCompletionBridge — silent on bad input', () => {
  it('emits nothing when no FSM file is in the line', async () => {
    const lines = await captureBridge('aharness --');
    expect(lines).toEqual([]);
  });

  it('emits nothing for a retired direct FSM target when the file does not exist', async () => {
    const lines = await captureBridge('aharness /nonexistent.fsm.ts --');
    expect(lines).toEqual([]);
  });
});

const dynamicFixture = path.resolve(__dirname, 'fixtures/args/dynamic-completion.fsm.ts');
const canonicalDynamicFixture = path.resolve(
  __dirname,
  'fixtures/args/canonical-dynamic-completion.fsm.ts',
);

describe('runCompletionBridge — dynamic value completion', () => {
  it('invokes the dynamic callback and emits matching values', async () => {
    const lines = await captureBridge(`aharness run ${dynamicFixture} --project a`);
    const names = lines.map((l) => l.split(':')[0]);
    expect(names).toEqual(['alpha']);
  });

  it('serves local dynamic completion from a warm loader cache when available', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-cached-dynamic-completion-cwd-'));
    try {
      const entry = path.join(cwd, 'workflow.fsm.ts');
      fs.writeFileSync(entry, '// intentionally not an extractable FSM\n');

      const hash = await hashSourceTree(cwd, entry);
      const cachePaths = cachePathsFor(cwd, hash);
      fs.mkdirSync(cachePaths.cacheDir, { recursive: true });
      const sidecar: SerializedSidecar = {
        schemas: {},
        issues: [],
        skillOriginManifest: {
          rootSourceDir: cwd,
          sourceDirPrefixes: [],
          availableSkills: [],
        },
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
          },
        },
        inputFlags: {
          project: { description: 'Project', completion: { dynamic: true } },
        },
      };
      fs.writeFileSync(
        cachePaths.modulePath,
        `
export const __sidecar = ${JSON.stringify(sidecar)};
export default {
  config: {
    input: {
      project: {
        meta: {
          completion: {
            dynamic: (partial) => ['alpha', 'beta'].filter((value) => value.startsWith(partial)),
          },
        },
      },
    },
  },
};
`,
      );

      const lines = await captureBridge('aharness run workflow.fsm.ts --project a', { cwd });
      expect(lines).toEqual(['alpha']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('emits no dynamic value completion for retired direct FSM target forms', async () => {
    const lines = await captureBridge(`aharness ${dynamicFixture} --project a`);
    expect(lines).toEqual([]);
  });

  it('emits empty output when callback throws', async () => {
    // Use the `broken` arg whose dynamic callback throws unconditionally.
    // The bridge's try/catch around the callback invocation should swallow
    // the error and emit nothing.
    const lines = await captureBridge(`aharness run ${dynamicFixture} --broken anything`);
    expect(lines).toEqual([]);
  });
});

describe('runCompletionBridge — canonical dynamic value completion', () => {
  it('invokes arrow complete callbacks and emits matching values', async () => {
    const lines = await captureBridge(`aharness run ${canonicalDynamicFixture} --arrow a`);
    expect(lines).toEqual(['alpha']);
  });

  it('invokes function-expression complete callbacks and emits matching values', async () => {
    const lines = await captureBridge(`aharness run ${canonicalDynamicFixture} --named b`);
    expect(lines).toEqual(['bravo', 'beta']);
  });

  it('invokes identifier complete callbacks and emits matching values', async () => {
    const lines = await captureBridge(`aharness run ${canonicalDynamicFixture} --identifier c`);
    expect(lines).toEqual(['charlie']);
  });

  it('emits empty output when a canonical complete callback throws', async () => {
    const lines = await captureBridge(`aharness run ${canonicalDynamicFixture} --broken anything`);
    expect(lines).toEqual([]);
  });

  it('emits empty output when canonical dynamic completion loading fails', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aharness-canonical-load-fail-'));
    try {
      const entry = path.join(cwd, 'load-fail.fsm.ts');
      fs.writeFileSync(
        entry,
        `
import { createFsm } from '@aharness/core';

const fsm = createFsm<{ project: string }>();

export default fsm.machine({
  input: {
    project: fsm.input.string({ complete: (partial) => ['alpha'].filter((value) => value.startsWith(partial)) }),
  },
  data: ({ input }) => input,
  initial: 'go',
  states: {
    go: fsm.state({
      prompt: () => 'go',
      on: { submit: fsm.submit<{ ok: boolean }>({ to: 'done' }) },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});

throw new Error('intentional load failure');
`,
      );

      const lines = await captureBridge(`aharness run ${entry} --project a`);
      expect(lines).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
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
