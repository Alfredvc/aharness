/**
 * `aharness init --dir <path>` — scaffolder.
 *
 * See spec: docs/specs/2026-05-10-aharness-init-design.md.
 *
 * Internals:
 *   1. Resolve absolute target dir.
 *   2. Pre-flight: refuse non-empty dir without --force.
 *   3. Pre-flight: collision check (with or without --force, collisions
 *      against any of the 7 template paths abort — we never overwrite).
 *   4. Read templates dir (injected for tests; resolved from import.meta.url
 *      in production), apply renames (`gitignore` → `.gitignore`,
 *      `prettierrc.json` → `.prettierrc.json`, `package.json.tmpl` →
 *      `package.json`, `.oxlintrc.json.tmpl` → `.oxlintrc.json`) and
 *      placeholder substitution.
 *   5. Git init (Task 6).
 *   6. Install (Task 7).
 *   7. Print next-steps.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type RunCommandFn = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; inheritStdio?: boolean },
) => Promise<RunCommandResult>;

export interface InitOpts {
  readonly dir: string;
  readonly force: boolean;
  readonly git: boolean;
  readonly install: boolean;
  readonly pm?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  readonly cwd: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Override for tests; production resolves from `import.meta.url`. */
  readonly templatesDir?: string;
  /** Override for tests; production reads own package.json. */
  readonly aharnessCoreVersion?: string;
  /** Override for tests; production wraps `execFile`. */
  readonly runCommand?: RunCommandFn;
  /** Used for `npm_config_user_agent` parsing; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const TEMPLATE_FILES: ReadonlyArray<{ src: string; dest: string; substitute: boolean }> = [
  { src: 'package.json.tmpl', dest: 'package.json', substitute: true },
  { src: 'tsconfig.json', dest: 'tsconfig.json', substitute: false },
  { src: '.oxlintrc.json.tmpl', dest: '.oxlintrc.json', substitute: false },
  { src: 'prettierrc.json', dest: '.prettierrc.json', substitute: false },
  { src: 'gitignore', dest: '.gitignore', substitute: false },
  { src: 'hello.fsm.ts', dest: 'hello.fsm.ts', substitute: false },
  { src: 'README.md', dest: 'README.md', substitute: true },
];

// Subsequent tasks (Task 7 install) will add awaited calls here; the surface
// is `async` from day one so callers don't churn.
export async function runInitCli(opts: InitOpts): Promise<{ exitCode: number }> {
  const target = isAbsolute(opts.dir) ? opts.dir : resolve(opts.cwd, opts.dir);
  const projectName = sanitizePackageName(basename(target));
  const templatesDir = opts.templatesDir ?? resolveTemplatesDir();
  const ownVersion = opts.aharnessCoreVersion ?? readOwnVersion();
  // 0.0.0 is the unpublished-monorepo placeholder; fall back to "latest" so
  // the scaffolded project can install something. Warn the user — they may
  // be in a private dev tree and the npm "latest" tag may not match the
  // @aharness/core they're running.
  let aharnessCoreVersion = ownVersion;
  if (ownVersion === '0.0.0') {
    aharnessCoreVersion = 'latest';
    opts.stderr.write(
      `aharness init: warning — running an unpublished @aharness/core (version 0.0.0). ` +
        `Scaffolded package.json pins "@aharness/core": "latest" — this may not match the ` +
        `version you're running locally. Edit package.json after install to pin a real version.\n`,
    );
  }

  // Pre-flight: dir state.
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      opts.stderr.write(
        `aharness init: target path exists but is not a directory: ${target}\n` +
          `  Move or delete it, or pick a fresh dir.\n`,
      );
      return { exitCode: 2 };
    }
    const entries = readdirSync(target);
    if (entries.length > 0 && !opts.force) {
      opts.stderr.write(
        `aharness init: target dir is not empty: ${target}\n` +
          `  Use --force to scaffold into a non-empty dir (existing files of\n` +
          `  the same names will not be overwritten).\n`,
      );
      return { exitCode: 2 };
    }
  } else {
    mkdirSync(target, { recursive: true });
  }

  // Pre-flight: collision check (always — even with --force, we never overwrite).
  const collisions = TEMPLATE_FILES.filter(({ dest }) => existsSync(join(target, dest))).map(
    ({ dest }) => dest,
  );
  if (collisions.length > 0) {
    opts.stderr.write(
      `aharness init: refusing to overwrite existing files in ${target}:\n` +
        collisions.map((c) => `  - ${c}\n`).join('') +
        `  Move or delete them, or pick a fresh dir.\n`,
    );
    return { exitCode: 2 };
  }

  // Write templates.
  for (const { src, dest, substitute } of TEMPLATE_FILES) {
    let body = readFileSync(join(templatesDir, src), 'utf8');
    if (substitute) {
      body = substituteTemplate(body, projectName, aharnessCoreVersion);
    }
    writeFileSync(join(target, dest), body);
  }

  if (opts.git) {
    const run = opts.runCommand ?? defaultRunCommand;
    const probe = await run('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: target,
      ...(opts.env ? { env: opts.env } : {}),
    });
    const insideRepo = probe.exitCode === 0 && probe.stdout.trim() === 'true';
    if (insideRepo) {
      opts.stdout.write('aharness init: already in git repo, skipping init\n');
    } else {
      const initResult = await run('git', ['init'], { cwd: target });
      if (initResult.exitCode !== 0) {
        opts.stderr.write(
          `aharness init: warning — git init failed (exit ${String(initResult.exitCode)}); continuing without git\n`,
        );
      } else {
        // git add / git commit can fail too: half-initialised .git/, missing
        // user.email global config (commit exits 128 with "Author identity
        // unknown"), pre-existing index lock, etc. Surface the exit code +
        // stderr so the user knows the scaffold succeeded but the git seed
        // didn't — same posture as the `git init` failure branch above.
        const addResult = await run('git', ['add', '-A'], { cwd: target });
        if (addResult.exitCode !== 0) {
          opts.stderr.write(
            `aharness init: warning — git add failed (exit ${String(addResult.exitCode)}): ` +
              `${addResult.stderr.trim()}\n`,
          );
        } else {
          const commitResult = await run(
            'git',
            ['commit', '-m', 'initial aharness FSM scaffold', '--no-verify'],
            { cwd: target },
          );
          if (commitResult.exitCode !== 0) {
            opts.stderr.write(
              `aharness init: warning — git commit failed (exit ${String(commitResult.exitCode)}): ` +
                `${commitResult.stderr.trim()}\n` +
                `  (Common cause: no global user.name/user.email — set via\n` +
                `  \`git config --global user.email "you@example.com"\` and re-commit manually.)\n`,
            );
          }
        }
      }
    }
  }

  const pm = opts.pm ?? detectPm(opts.env ?? process.env);

  if (opts.install) {
    const run = opts.runCommand ?? defaultRunCommand;
    opts.stdout.write(`aharness init: running ${pm} install\n`);
    // Install can take minutes; pass `inheritStdio: true` so the user sees
    // pnpm/npm/yarn progress in real time. Other invocations (`git rev-parse`,
    // `git init`, …) keep the buffered default since the caller inspects stdout.
    const installResult = await run(pm, ['install'], { cwd: target, inheritStdio: true });
    if (installResult.exitCode !== 0) {
      opts.stderr.write(
        `aharness init: ${pm} install failed (exit ${String(installResult.exitCode)}). ` +
          `Re-run manually:\n  cd ${target} && ${pm} install\n`,
      );
      return { exitCode: 1 };
    }
  } else {
    opts.stdout.write(
      `aharness init: skipped install. To install:\n  cd ${target} && ${pm} install\n`,
    );
  }

  opts.stdout.write(`aharness init: scaffolded ${target}\n`);
  return { exitCode: 0 };
}

function substituteTemplate(body: string, projectName: string, aharnessVersion: string): string {
  return body
    .replace(/__AHARNESS_VERSION__/g, aharnessVersion)
    .replace(/("(?:@aharness\/core)"\s*:\s*)"[^"]+"/g, `$1"${aharnessVersion}"`)
    .replace(/__PROJECT_NAME__/g, projectName);
}

function detectPm(env: NodeJS.ProcessEnv): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const ua = env['npm_config_user_agent'] ?? '';
  if (ua.startsWith('pnpm/')) return 'pnpm';
  if (ua.startsWith('yarn/')) return 'yarn';
  if (ua.startsWith('bun/')) return 'bun';
  return 'npm';
}

/** npm package-name rules: lowercase, no spaces, allowed chars. */
function sanitizePackageName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, '-')
    .replace(/-+/g, '-') // collapse runs (e.g. "My  Cool" → "my--cool" → "my-cool")
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '');
  return cleaned.length > 0 ? cleaned : 'fsm-app';
}

function resolveTemplatesDir(): string {
  // dist/cli/initCli.js → dist/templates  (production)
  // src/cli/initCli.ts  → templates       (uncompiled test)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', 'templates'), resolve(here, '..', '..', 'templates')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`aharness init: cannot locate templates dir (tried ${candidates.join(', ')})`);
}

/** Reads raw `version` from @aharness/core's own package.json. Returns "0.0.0"
 *  if not found or unset; the caller (`runInitCli`) is responsible for the
 *  0.0.0 → "latest" substitution + user-visible warning.
 */
function readOwnVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', '..', '..', 'package.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const pkg = JSON.parse(readFileSync(c, 'utf8')) as { version?: string };
      return pkg.version ?? '0.0.0';
    }
  }
  return '0.0.0';
}

async function defaultRunCommand(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; inheritStdio?: boolean },
): Promise<RunCommandResult> {
  if (opts.inheritStdio) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolveOk) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
        stdio: 'inherit',
      });
      child.on('exit', (code, signal) =>
        resolveOk({
          stdout: '',
          stderr: '',
          exitCode: code ?? (signal ? 1 : 0),
        }),
      );
      child.on('error', () => resolveOk({ stdout: '', stderr: '', exitCode: 127 }));
    });
  }
  const { execFile } = await import('node:child_process');
  return new Promise((resolveOk) => {
    execFile(
      cmd,
      [...args],
      { cwd: opts.cwd, encoding: 'utf8', ...(opts.env ? { env: opts.env } : {}) },
      (err, stdout, stderr) => {
        // err.code is a number (exit status) for normal failures, OR a string
        // (e.g. 'ENOENT') when the binary is missing. Distinguish so a missing
        // git/pnpm reports a meaningful 127 instead of a coarse "1".
        let exitCode: number;
        if (!err) {
          exitCode = 0;
        } else if (typeof err === 'object' && 'code' in err) {
          if (typeof err.code === 'number') exitCode = err.code;
          else if (err.code === 'ENOENT') exitCode = 127;
          else exitCode = 1;
        } else {
          exitCode = 1;
        }
        // `encoding: 'utf8'` selects the string-returning overload, so stdout
        // and stderr are typed `string` and need no Buffer coercion.
        resolveOk({ stdout, stderr, exitCode });
      },
    );
  });
}
