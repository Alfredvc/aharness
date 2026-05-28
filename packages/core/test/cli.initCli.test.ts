/**
 * `runInitCli` tests. Inject `runCommand` so no real git/npm/pnpm is
 * spawned; inject `templatesDir` to point at the source-tree templates
 * (works whether tests run uncompiled against `src/` or compiled).
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';

import { runInitCli, type RunCommandResult } from '../src/cli/initCli.js';
import { runVerifyCli } from '../src/cli/verifyCli.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(here, '..', 'templates');
const retiredVizPackageName = ['harness', 'viz'].join('-');

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'harness-init-test-'));
}

function noopRunCommand(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
}

describe('runInitCli — file scaffold', () => {
  it('writes all 7 template files into the target dir', async () => {
    const root = tmp();
    const target = join(root, 'my-app');
    const stdout = captureStream();
    const stderr = captureStream();
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: stdout.stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(target, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(target, '.prettierrc.json'))).toBe(true);
    expect(existsSync(join(target, '.gitignore'))).toBe(true);
    expect(existsSync(join(target, 'hello.fsm.ts'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
  });

  it('substitutes __HARNESS_VERSION__ and __PROJECT_NAME__ in package.json', async () => {
    const root = tmp();
    const target = join(root, 'my-fsm');
    const stdout = captureStream();
    const stderr = captureStream();
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: stdout.stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-fsm');
    expect(pkg.dependencies['@aharness/core']).toBe('1.2.3');
    expect(Object.keys(pkg.devDependencies)).not.toContain(retiredVizPackageName);
    // Non-placeholder dep pins survive substitution unchanged (regression
    // guard: a too-greedy replace would corrupt them).
    expect(pkg.dependencies['xstate']).toBe('^5.19.0');
    expect(pkg.devDependencies['typescript']).toMatch(/^\^/);
    // README's literal `<your-pm>` placeholder is NOT touched (it is example
    // text for the user to read, not a substitution token).
    const readme = readFileSync(join(target, 'README.md'), 'utf8');
    expect(readme).toContain('<your-pm>');
  });

  it('substitutes __PROJECT_NAME__ in README.md', async () => {
    const root = tmp();
    const target = join(root, 'cool-fsm');
    const stdout = captureStream();
    const stderr = captureStream();
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: stdout.stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    const readme = readFileSync(join(target, 'README.md'), 'utf8');
    expect(readme).toMatch(/^# cool-fsm/m);
    expect(readme).not.toContain('__PROJECT_NAME__');
  });

  it('refuses non-empty target dir without --force', async () => {
    const root = tmp();
    const target = join(root, 'taken');
    mkdirSync(target);
    writeFileSync(join(target, 'something.txt'), 'pre-existing');
    const stderr = captureStream();
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    expect(r.exitCode).toBe(2);
    expect(stderr.text()).toMatch(/not empty/);
    expect(existsSync(join(target, 'package.json'))).toBe(false);
  });

  it('refuses on collision even with --force', async () => {
    const root = tmp();
    const target = join(root, 'collide');
    mkdirSync(target);
    writeFileSync(join(target, 'package.json'), '{}');
    const stderr = captureStream();
    const r = await runInitCli({
      dir: target,
      force: true,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    expect(r.exitCode).toBe(2);
    expect(stderr.text()).toMatch(/package\.json/);
    // Pre-existing file untouched.
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe('{}');
  });

  it('writes into a non-empty dir with --force when no template paths collide', async () => {
    const root = tmp();
    const target = join(root, 'extras-allowed');
    mkdirSync(target);
    writeFileSync(join(target, 'NOTES.txt'), 'preexisting note');
    const r = await runInitCli({
      dir: target,
      force: true,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(readFileSync(join(target, 'NOTES.txt'), 'utf8')).toBe('preexisting note');
  });

  it('sanitises uppercase / spaces in dir basename to a valid npm name', async () => {
    const root = tmp();
    const target = join(root, 'My Cool App');
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe('my-cool-app');
  });

  it('collapses runs of separators (e.g. double spaces → single dash)', async () => {
    const root = tmp();
    const target = join(root, 'My  Cool'); // two spaces between
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe('my-cool');
  });

  it('refuses --dir target that exists but is a regular file', async () => {
    const root = tmp();
    const target = join(root, 'not-a-dir.txt');
    writeFileSync(target, 'pre-existing file content');
    const stderr = captureStream();
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    expect(r.exitCode).toBe(2);
    expect(stderr.text()).toMatch(/not a directory/i);
    // Original file content untouched.
    expect(readFileSync(target, 'utf8')).toBe('pre-existing file content');
  });

  it('warns to stderr and pins "latest" when own version is 0.0.0', async () => {
    const root = tmp();
    const target = join(root, 'unpublished-fallback');
    const stderr = captureStream();
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '0.0.0',
      runCommand: noopRunCommand(),
      env: {},
    });
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@aharness/core']).toBe('latest');
    expect(stderr.text()).toMatch(/0\.0\.0|unpublished|latest/i);
  });
});

describe('runInitCli — git step', () => {
  it('runs git init + initial commit when target is not inside an existing repo', async () => {
    const root = tmp();
    const target = join(root, 'fresh-app');
    const runCommand = vi.fn(
      async (cmd: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
          return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const r = await runInitCli({
      dir: target,
      force: false,
      git: true,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    expect(r.exitCode).toBe(0);
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds).toContain('git rev-parse --is-inside-work-tree');
    expect(cmds.some((c) => c.startsWith('git init'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('git add'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('git commit'))).toBe(true);
  });

  it('skips git init when target is already inside a git repo', async () => {
    const root = tmp();
    const target = join(root, 'in-repo');
    const stdout = captureStream();
    const runCommand = vi.fn(
      async (cmd: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
          return { stdout: 'true\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const r = await runInitCli({
      dir: target,
      force: false,
      git: true,
      install: false,
      cwd: root,
      stdout: stdout.stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    expect(r.exitCode).toBe(0);
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds).toContain('git rev-parse --is-inside-work-tree');
    expect(cmds.some((c) => c.startsWith('git init'))).toBe(false);
    expect(stdout.text()).toMatch(/already in git repo/);
  });

  it('skips git when --no-git is passed (does not even probe rev-parse)', async () => {
    const root = tmp();
    const target = join(root, 'no-git-app');
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    expect(r.exitCode).toBe(0);
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds.some((c) => c.startsWith('git'))).toBe(false);
  });

  it('warns and continues when git init itself fails (e.g. git unavailable)', async () => {
    const root = tmp();
    const target = join(root, 'git-broken');
    const stderr = captureStream();
    const runCommand = vi.fn(
      async (cmd: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
        if (cmd === 'git' && args[0] === 'rev-parse') {
          return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
        }
        if (cmd === 'git' && args[0] === 'init') {
          return { stdout: '', stderr: 'spawn git ENOENT', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const r = await runInitCli({
      dir: target,
      force: false,
      git: true,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    // git failure is non-fatal: scaffold succeeded, exit 0, files written, warning surfaced.
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toMatch(/warning|git init/i);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });

  it('warns and continues when git commit fails (e.g. no global git identity)', async () => {
    const root = tmp();
    const target = join(root, 'no-identity');
    const stderr = captureStream();
    const runCommand = vi.fn(
      async (cmd: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
        if (cmd === 'git' && args[0] === 'rev-parse') {
          return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
        }
        if (cmd === 'git' && args[0] === 'commit') {
          return {
            stdout: '',
            stderr:
              '*** Please tell me who you are.\n\nrun\n  git config --global user.email "you@example.com"\n',
            exitCode: 128,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const r = await runInitCli({
      dir: target,
      force: false,
      git: true,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    // commit failure is non-fatal: scaffold succeeded, exit 0, .git/ exists,
    // user gets actionable warning.
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toMatch(/git commit failed/i);
    expect(stderr.text()).toMatch(/user\.email/);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });
});

describe('runInitCli — install step', () => {
  it('runs <pm> install when --pm pnpm is explicit', async () => {
    const root = tmp();
    const target = join(root, 'pnpm-app');
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: true,
      pm: 'pnpm',
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    expect(r.exitCode).toBe(0);
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds).toContain('pnpm install');
  });

  it('detects pm from npm_config_user_agent (yarn)', async () => {
    const root = tmp();
    const target = join(root, 'yarn-app');
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: true,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: { npm_config_user_agent: 'yarn/4.0.0 npm/? node/v20.0.0 darwin x64' },
    });
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds).toContain('yarn install');
  });

  it('falls back to npm when neither --pm nor user-agent is informative', async () => {
    const root = tmp();
    const target = join(root, 'default-app');
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: true,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds).toContain('npm install');
  });

  it('skips install with --no-install and prints follow-up command', async () => {
    const root = tmp();
    const target = join(root, 'no-install-app');
    const stdout = captureStream();
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      pm: 'pnpm',
      cwd: root,
      stdout: stdout.stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    expect(r.exitCode).toBe(0);
    const cmds = runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
    expect(cmds.some((c) => c.endsWith(' install'))).toBe(false);
    expect(stdout.text()).toMatch(/pnpm install/);
  });

  it('returns exit 1 when install fails', async () => {
    const root = tmp();
    const target = join(root, 'install-fails');
    const runCommand = vi.fn(async (cmd: string): Promise<RunCommandResult> => {
      if (cmd === 'npm') return { stdout: '', stderr: 'ENOENT', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const stderr = captureStream();
    const r = await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: true,
      pm: 'npm',
      cwd: root,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand,
      env: {},
    });
    expect(r.exitCode).toBe(1);
    expect(stderr.text()).toMatch(/npm install/i);
  });
});

describe('runInitCli — scaffolded FSM passes aharness verify', () => {
  it('scaffolds hello.fsm.ts with the canonical createFsm authoring surface', async () => {
    const root = tmp();
    const target = join(root, 'canonical-template');
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });

    const source = readFileSync(join(target, 'hello.fsm.ts'), 'utf8');
    expect(source).toContain('createFsm');
    expect(source).not.toMatch(
      /import\s+\{[^}]*\b(assign|harness|terminal|state|exit|arg|embed|skill|writeArtifact|RunDir|HarnessInput)\b[^}]*\}\s+from\s+['"][^'"]+['"]/s,
    );
    expect(source).not.toMatch(/\b(assign|writeArtifact|RunDir|HarnessInput)\b/);
  });

  it('runs runVerifyCli against the scaffolded hello.fsm.ts and exits 0', async () => {
    const root = tmp();
    const target = join(root, 'verify-me');
    await runInitCli({
      dir: target,
      force: false,
      git: false,
      install: false,
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      templatesDir: TEMPLATES_DIR,
      harnessCoreVersion: '1.2.3',
      runCommand: noopRunCommand(),
      env: {},
    });
    const r = await runVerifyCli({
      fsmPath: join(target, 'hello.fsm.ts'),
      // CRITICAL: pass `repoRoot: target` (or `root` tmpdir). Default is
      // `process.cwd()`, which during vitest = the harness repo root —
      // running the verifier with that default writes loader cache entries
      // into the harness repo's `.harness/cache/`, polluting the workspace
      // and possibly breaking other concurrent tests. The scaffolded dir is
      // self-contained; pinning `repoRoot` to it keeps cache-writes scoped.
      repoRoot: target,
      log: () => {},
    });
    expect(r.exitCode).toBe(0);
  });
});
