import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = findRepoRoot(process.cwd());
const cliPath = path.join(repoRoot, 'packages/core/dist/cli/main.js');
const shimPackageFixtureRoot = path.join(
  repoRoot,
  'packages/core/test/fixtures/installed-cli-shim-package',
);
const missingCliMessage =
  'packages/core/dist/cli/main.js is missing; run `pnpm run build` before running installed CLI e2e tests.';
const commandTimeoutMs = 15_000;

interface CliTestEnvironment {
  readonly root: string;
  readonly aharnessHome: string;
  readonly codexHome: string;
  readonly home: string;
  readonly cwd: string;
  readonly binDir: string;
  readonly npmCacheDir: string;
  readonly npmUserConfigPath: string;
  readonly codexLogPath: string;
}

interface SpawnedCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FakeExecutableLogEntry {
  readonly args: readonly string[];
  readonly cwd: string;
}

interface GeneratedInstallablePackage {
  readonly root: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly commandName: string;
  readonly commandDescription: string;
  readonly coreDependencyRange: string;
  readonly corePackageVersion: string;
}

interface MinimalInstallablePackageOptions {
  readonly commandName?: string;
  readonly commandDescription?: string;
  readonly sourceDirName?: string;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  const roots = cleanupRoots.splice(0).reverse();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

if (existsSync(cliPath)) {
  describe('installed CLI e2e harness', () => {
    it(
      'harness smoke: spawns list against an isolated empty installed store',
      { timeout: commandTimeoutMs + 5_000 },
      async () => {
        const testEnv = await createCliTestEnvironment();

        const result = await runBuiltCli(testEnv, ['list']);

        expect(result.exitCode, formatCliResult(result)).toBe(0);
        expect(result.stdout).toBe('aharness list: no installed packages\n');
        expect(result.stderr).toBe('');
      },
    );

    it(
      'install smoke: routes through real npm and writes isolated trusted files',
      { timeout: commandTimeoutMs * 3 },
      async () => {
        const testEnv = await createCliTestEnvironment();
        const generatedPackage = await writeMinimalInstallablePackage(testEnv);

        const result = await runBuiltCli(testEnv, ['install', generatedPackage.root]);

        expect(result.exitCode, formatCliResult(result)).toBe(0);
        expect(result.stdout).toContain(
          `aharness install: installed ${generatedPackage.packageName} (1 command verified)`,
        );
        expect(result.stderr).toBe('');

        const managedProjectRoot = path.join(testEnv.aharnessHome, 'packages');
        const packageRoot = path.join(
          managedProjectRoot,
          'node_modules',
          generatedPackage.packageName,
        );
        expect(existsSync(path.join(testEnv.aharnessHome, 'installs.json'))).toBe(true);
        expect(existsSync(path.join(testEnv.aharnessHome, 'commands.json'))).toBe(true);
        expect(existsSync(path.join(managedProjectRoot, 'package.json'))).toBe(true);
        expect(existsSync(path.join(packageRoot, 'package.json'))).toBe(true);
        expect(
          existsSync(path.join(packageRoot, 'node_modules', '@aharness', 'core', 'index.js')),
        ).toBe(true);

        const lockfile = (await readJson(path.join(managedProjectRoot, 'package-lock.json'))) as {
          readonly packages?: Record<string, unknown>;
        };
        const packages = lockfile.packages ?? {};
        const directEntry = packages[`node_modules/${generatedPackage.packageName}`] as
          | Record<string, unknown>
          | undefined;
        expect(packages['']).toBeDefined();
        expect(directEntry).toMatchObject({
          version: generatedPackage.packageVersion,
          dependencies: {
            '@aharness/core': generatedPackage.coreDependencyRange,
          },
          bundleDependencies: ['@aharness/core'],
        });
        expect(directEntry).not.toHaveProperty('link', true);
        expect(
          packages[`node_modules/${generatedPackage.packageName}/node_modules/@aharness/core`],
        ).toMatchObject({
          version: generatedPackage.corePackageVersion,
          inBundle: true,
        });
      },
    );

    it(
      'verify smoke: generated package verifies by package and qualified command',
      { timeout: commandTimeoutMs * 4 },
      async () => {
        const testEnv = await createCliTestEnvironment();
        const generatedPackage = await writeMinimalInstallablePackage(testEnv);

        const installResult = await runBuiltCli(testEnv, ['install', generatedPackage.root]);

        expect(installResult.exitCode, formatCliResult(installResult)).toBe(0);

        const packageVerifyResult = await runBuiltCli(testEnv, [
          'verify',
          generatedPackage.packageName,
        ]);
        expect(packageVerifyResult.exitCode, formatCliResult(packageVerifyResult)).toBe(0);
        expect(packageVerifyResult.stdout).toContain(
          `verify: ok (${generatedPackage.packageName}/${generatedPackage.commandName}, 0 warnings)`,
        );
        expect(packageVerifyResult.stderr).toBe('');

        const commandVerifyResult = await runBuiltCli(testEnv, [
          'verify',
          `${generatedPackage.packageName}/${generatedPackage.commandName}`,
        ]);
        expect(commandVerifyResult.exitCode, formatCliResult(commandVerifyResult)).toBe(0);
        expect(commandVerifyResult.stdout).toContain(
          `verify: ok (${generatedPackage.packageName}/${generatedPackage.commandName}, 0 warnings)`,
        );
        expect(commandVerifyResult.stderr).toBe('');
      },
    );

    it(
      'installs, lists, verifies, runs, and uninstalls through installed CLI processes',
      { timeout: commandTimeoutMs * 8 },
      async () => {
        const testEnv = await createCliTestEnvironment();
        const generatedPackage = await writeMinimalInstallablePackage(testEnv);
        const commandIdentity = `${generatedPackage.packageName}/${generatedPackage.commandName}`;
        const managedProjectRoot = path.join(testEnv.aharnessHome, 'packages');
        const packageRoot = path.join(
          managedProjectRoot,
          'node_modules',
          generatedPackage.packageName,
        );

        const installResult = await runBuiltCli(testEnv, ['install', generatedPackage.root]);
        expect(installResult.exitCode, formatCliResult(installResult)).toBe(0);
        expect(installResult.stdout).toContain(
          `aharness install: installed ${generatedPackage.packageName} (1 command verified)`,
        );
        expect(installResult.stderr).toBe('');

        const listResult = await runBuiltCli(testEnv, ['list']);
        expect(listResult.exitCode, formatCliResult(listResult)).toBe(0);
        expect(listResult.stdout).toContain(
          `${generatedPackage.packageName} ${generatedPackage.packageVersion}`,
        );
        expect(listResult.stdout).toContain(
          `  ${generatedPackage.commandName}  ${generatedPackage.commandDescription}`,
        );
        expect(listResult.stderr).toBe('');

        const packageVerifyResult = await runBuiltCli(testEnv, [
          'verify',
          generatedPackage.packageName,
        ]);
        expect(packageVerifyResult.exitCode, formatCliResult(packageVerifyResult)).toBe(0);
        expect(packageVerifyResult.stdout).toContain(`verify: ok (${commandIdentity}, 0 warnings)`);
        expect(packageVerifyResult.stderr).toBe('');

        const commandVerifyResult = await runBuiltCli(testEnv, ['verify', commandIdentity]);
        expect(commandVerifyResult.exitCode, formatCliResult(commandVerifyResult)).toBe(0);
        expect(commandVerifyResult.stdout).toContain(`verify: ok (${commandIdentity}, 0 warnings)`);
        expect(commandVerifyResult.stderr).toBe('');

        await clearFakeCodexLog(testEnv);
        const missingInputRunResult = await runBuiltCli(testEnv, [
          'run',
          '--no-open',
          commandIdentity,
        ]);
        expect(missingInputRunResult.exitCode, formatCliResult(missingInputRunResult)).toBe(2);
        expect(missingInputRunResult.stdout).toContain('aharness: run ');
        expect(missingInputRunResult.stdout).toContain(` starting ${commandIdentity} `);
        expect(missingInputRunResult.stderr).toContain('missing required flag --topic');
        expect(missingInputRunResult.stderr).toContain(
          `Example: aharness run ${commandIdentity} --topic <string>`,
        );
        const missingInputCodexLog = await readFakeExecutableLog(testEnv.codexLogPath);
        expect(missingInputCodexLog).toEqual([
          {
            args: ['--version'],
            cwd: testEnv.cwd,
          },
        ]);
        expect(missingInputCodexLog.some((entry) => entry.args.includes('app-server'))).toBe(false);

        const uninstallResult = await runBuiltCli(testEnv, [
          'uninstall',
          generatedPackage.packageName,
        ]);
        expect(uninstallResult.exitCode, formatCliResult(uninstallResult)).toBe(0);
        expect(uninstallResult.stdout).toContain(
          `aharness uninstall: uninstalled ${generatedPackage.packageName} (1 command removed)`,
        );
        expect(uninstallResult.stderr).toBe('');
        expect(existsSync(packageRoot)).toBe(false);

        const lockfileAfterUninstall = (await readJson(
          path.join(managedProjectRoot, 'package-lock.json'),
        )) as {
          readonly packages?: Record<string, unknown>;
        };
        expect(
          lockfileAfterUninstall.packages?.[`node_modules/${generatedPackage.packageName}`],
        ).toBeUndefined();

        const postUninstallRunResult = await runBuiltCli(testEnv, [
          'run',
          '--no-open',
          commandIdentity,
        ]);
        expect(postUninstallRunResult.exitCode, formatCliResult(postUninstallRunResult)).toBe(1);
        expect(postUninstallRunResult.stderr).toContain('command-not-found');

        const postUninstallVerifyResult = await runBuiltCli(testEnv, [
          'verify',
          generatedPackage.packageName,
        ]);
        expect(postUninstallVerifyResult.exitCode, formatCliResult(postUninstallVerifyResult)).toBe(
          1,
        );
        expect(postUninstallVerifyResult.stderr).toContain('installed-package-not-found');
      },
    );

    describe('dispatcher edge cases for installed targets', () => {
      it(
        'dispatcher resolves a unique bare installed run target',
        { timeout: commandTimeoutMs * 4 },
        async () => {
          const testEnv = await createCliTestEnvironment();
          const generatedPackage = await writeMinimalInstallablePackage(testEnv);

          const installResult = await runBuiltCli(testEnv, ['install', generatedPackage.root]);
          expect(installResult.exitCode, formatCliResult(installResult)).toBe(0);

          await clearFakeCodexLog(testEnv);
          const runResult = await runBuiltCli(testEnv, [
            'run',
            '--no-open',
            generatedPackage.commandName,
          ]);

          expect(runResult.exitCode, formatCliResult(runResult)).toBe(2);
          expect(runResult.stderr).toContain('missing required flag --topic');
          expect(runResult.stderr).toContain(
            `Example: aharness run ${generatedPackage.commandName} --topic <string>`,
          );
          const codexLog = await readFakeExecutableLog(testEnv.codexLogPath);
          expect(codexLog).toEqual([
            {
              args: ['--version'],
              cwd: testEnv.cwd,
            },
          ]);
          expect(codexLog.some((entry) => entry.args.includes('app-server'))).toBe(false);
        },
      );

      it(
        'dispatcher routes list after run as an installed target',
        { timeout: commandTimeoutMs * 4 },
        async () => {
          const testEnv = await createCliTestEnvironment();
          const generatedPackage = await writeMinimalInstallablePackage(testEnv, {
            commandName: 'list',
            commandDescription: 'Installed command named list',
            sourceDirName: 'source-package-list',
          });

          const installResult = await runBuiltCli(testEnv, ['install', generatedPackage.root]);
          expect(installResult.exitCode, formatCliResult(installResult)).toBe(0);

          const runResult = await runBuiltCli(testEnv, ['run', '--no-open', 'list']);

          expect(runResult.exitCode, formatCliResult(runResult)).toBe(2);
          expect(runResult.stderr).toContain('missing required flag --topic');
          expect(runResult.stderr).toContain('Example: aharness run list --topic <string>');
          expect(runResult.stdout).not.toContain('aharness list:');
        },
      );

      it(
        'dispatcher routes verify after run as an installed target',
        { timeout: commandTimeoutMs * 4 },
        async () => {
          const testEnv = await createCliTestEnvironment();
          const generatedPackage = await writeMinimalInstallablePackage(testEnv, {
            commandName: 'verify',
            commandDescription: 'Installed command named verify',
            sourceDirName: 'source-package-verify',
          });

          const installResult = await runBuiltCli(testEnv, ['install', generatedPackage.root]);
          expect(installResult.exitCode, formatCliResult(installResult)).toBe(0);

          const runResult = await runBuiltCli(testEnv, ['run', '--no-open', 'verify']);

          expect(runResult.exitCode, formatCliResult(runResult)).toBe(2);
          expect(runResult.stderr).toContain('missing required flag --topic');
          expect(runResult.stderr).toContain('Example: aharness run verify --topic <string>');
          expect(runResult.stdout).not.toContain('verify: ok');
          expect(runResult.stderr).not.toContain('usage:');
        },
      );

      it('dispatcher rejects invalid install usage before creating a managed npm project', async () => {
        const testEnv = await createCliTestEnvironment();

        const result = await runBuiltCli(testEnv, ['install', '--bad']);

        expect(result.exitCode, formatCliResult(result)).toBe(2);
        expect(result.stderr).toContain('usage:');
        expect(existsSync(path.join(testEnv.aharnessHome, 'packages'))).toBe(false);
      });

      it('dispatcher rejects invalid uninstall usage before creating a managed npm project', async () => {
        const testEnv = await createCliTestEnvironment();

        const result = await runBuiltCli(testEnv, ['uninstall', '--bad']);

        expect(result.exitCode, formatCliResult(result)).toBe(2);
        expect(result.stderr).toContain('usage:');
        expect(existsSync(path.join(testEnv.aharnessHome, 'packages'))).toBe(false);
      });
    });
  });
} else {
  describe.skip('installed CLI e2e harness', () => {
    it(missingCliMessage, () => undefined);
  });
}

async function createCliTestEnvironment() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aharness-installed-cli-e2e-')));
  cleanupRoots.push(root);

  const testEnv: CliTestEnvironment = {
    root,
    aharnessHome: path.join(root, 'aharness-home'),
    codexHome: path.join(root, 'codex-home'),
    home: path.join(root, 'home'),
    cwd: path.join(root, 'cwd'),
    binDir: path.join(root, 'bin'),
    npmCacheDir: path.join(root, 'npm-cache'),
    npmUserConfigPath: path.join(root, 'npmrc'),
    codexLogPath: path.join(root, 'fake-codex.jsonl'),
  };

  await Promise.all([
    mkdir(testEnv.aharnessHome, { recursive: true }),
    mkdir(testEnv.codexHome, { recursive: true }),
    mkdir(testEnv.home, { recursive: true }),
    mkdir(testEnv.cwd, { recursive: true }),
    mkdir(testEnv.binDir, { recursive: true }),
    mkdir(testEnv.npmCacheDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFakeCodexExecutable(testEnv),
    writeFile(
      testEnv.npmUserConfigPath,
      'audit=false\nfund=false\nupdate-notifier=false\noffline=true\n',
    ),
    clearFakeCodexLog(testEnv),
  ]);

  return testEnv;
}

async function writeMinimalInstallablePackage(
  testEnv: CliTestEnvironment,
  options: MinimalInstallablePackageOptions = {},
): Promise<GeneratedInstallablePackage> {
  const sourcePackageRoot = path.join(testEnv.root, options.sourceDirName ?? 'source-package');
  await rm(sourcePackageRoot, { recursive: true, force: true });
  await cp(shimPackageFixtureRoot, sourcePackageRoot, { recursive: true });

  const packageJsonPath = path.join(sourcePackageRoot, 'package.json');
  const packageJson = (await readJson(packageJsonPath)) as {
    readonly name: string;
    readonly version: string;
    readonly aharness?: {
      readonly package?: {
        readonly commands?: Record<
          string,
          { readonly entry: string; readonly description?: string }
        >;
      };
    };
    readonly dependencies?: Record<string, string>;
  };
  const fixtureCommands = packageJson.aharness?.package?.commands ?? {};
  const fixtureCommand = fixtureCommands['main'];
  if (!fixtureCommand) {
    throw new Error('installed CLI shim fixture must declare a main command');
  }

  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  const commandName = options.commandName ?? 'main';
  const commandDescription = options.commandDescription ?? fixtureCommand.description ?? '';
  const corePackageVersion = await readCurrentCoreVersion();
  const coreDependencyRange = `^${corePackageVersion}`;

  await writeFile(
    packageJsonPath,
    JSON.stringify(
      {
        ...packageJson,
        type: 'module',
        dependencies: {
          ...(packageJson.dependencies ?? {}),
          '@aharness/core': coreDependencyRange,
        },
        bundleDependencies: ['@aharness/core'],
        aharness: {
          package: {
            commands: {
              [commandName]: {
                entry: fixtureCommand.entry,
                description: commandDescription,
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  await writeBundledCorePlaceholder({
    packageRoot: sourcePackageRoot,
    version: corePackageVersion,
  });

  return {
    root: sourcePackageRoot,
    packageName,
    packageVersion,
    commandName,
    commandDescription,
    coreDependencyRange,
    corePackageVersion,
  };
}

async function writeBundledCorePlaceholder(opts: {
  readonly packageRoot: string;
  readonly version: string;
}): Promise<void> {
  const placeholderRoot = path.join(opts.packageRoot, 'bundled-core-placeholder');
  const coreRoot = path.join(opts.packageRoot, 'node_modules', '@aharness', 'core');
  await rm(coreRoot, { recursive: true, force: true });
  await mkdir(coreRoot, { recursive: true });
  await cp(placeholderRoot, coreRoot, { recursive: true });
  await writeFile(
    path.join(coreRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@aharness/core',
        version: opts.version,
        type: 'module',
        exports: './index.js',
      },
      null,
      2,
    ) + '\n',
  );
}

async function runBuiltCli(
  testEnv: CliTestEnvironment,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnedCliResult> {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  const env = buildCliEnv(testEnv, options.env);
  if (args[0] === 'run') {
    await writeFile(path.join(testEnv.codexHome, 'auth.json'), '{}\n');
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: testEnv.cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      settle(() => {
        reject(
          new Error(
            `timed out after ${timeoutMs}ms spawning aharness ${args.join(' ')}\n` +
              `stdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      settle(() => reject(error));
    });
    child.on('exit', (code) => {
      settle(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  });
}

function buildCliEnv(
  testEnv: CliTestEnvironment,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    AHARNESS_HOME: testEnv.aharnessHome,
    CODEX_HOME: testEnv.codexHome,
    HOME: testEnv.home,
    AHARNESS_E2E_FAKE_CODEX_LOG: testEnv.codexLogPath,
    npm_config_cache: testEnv.npmCacheDir,
    npm_config_userconfig: testEnv.npmUserConfigPath,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_offline: 'true',
    PATH: `${testEnv.binDir}${path.delimiter}${extraEnv.PATH ?? process.env.PATH ?? ''}`,
  };
}

async function clearFakeCodexLog(testEnv: CliTestEnvironment): Promise<void> {
  await writeFile(testEnv.codexLogPath, '');
}

async function readFakeExecutableLog(filePath: string): Promise<readonly FakeExecutableLogEntry[]> {
  const text = await readFile(filePath, 'utf8');
  if (text.trim().length === 0) return [];
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as FakeExecutableLogEntry);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function readCurrentCoreVersion(): Promise<string> {
  const corePackageJson = (await readJson(path.join(repoRoot, 'packages/core/package.json'))) as {
    readonly version?: unknown;
  };
  if (typeof corePackageJson.version !== 'string' || corePackageJson.version.length === 0) {
    throw new Error('packages/core/package.json must include a string version');
  }
  return corePackageJson.version;
}

async function writeFakeCodexExecutable(testEnv: CliTestEnvironment): Promise<void> {
  const scriptPath = path.join(testEnv.binDir, 'codex');
  await writeFile(scriptPath, fakeCodexScript);
  await chmod(scriptPath, 0o755);
}

function formatCliResult(result: SpawnedCliResult): string {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (
      existsSync(path.join(current, 'pnpm-workspace.yaml')) &&
      existsSync(path.join(current, 'packages/core/package.json'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`unable to locate aharness repo root from ${start}`);
    }
    current = parent;
  }
}

const fakeCodexScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const logPath = process.env.AHARNESS_E2E_FAKE_CODEX_LOG;
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
}

if (args.length === 1 && args[0] === '--version') {
  console.log('codex-cli 0.136.0');
  process.exit(0);
}

console.error('fake codex unsupported args: ' + JSON.stringify(args));
process.exit(64);
`;
