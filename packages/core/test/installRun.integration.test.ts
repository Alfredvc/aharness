import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runListInstalledCli } from '../src/cli/listInstalledCli.js';
import { runInstalledCli } from '../src/cli/runInstalledCli.js';
import type { RunCliForTestOpts } from '../src/cli/runCli.js';
import { runUninstallCli } from '../src/cli/uninstallCli.js';
import { runVerifyInstalledCli } from '../src/cli/verifyInstalledCli.js';
import {
  installPackageFromSource,
  type InstallNpmRunner,
  type TrustedCommandsFile,
  type TrustedInstallsFile,
  type UninstallNpmRunner,
} from '../src/installStore/index.js';
import type { LoadFsmResult } from '../src/loader/index.js';

const fixturesDir = path.resolve(__dirname, 'fixtures/install-loader');
const commandFixtureRoot = path.join(fixturesDir, 'command-package');
const dependencyFixtureRoot = path.join(fixturesDir, 'dependency-package');
const CURRENT_CORE_VERSION = '0.1.0';

describe('installed package public install-to-run integration', () => {
  it('installs, lists, verifies, runs, and uninstalls one package through trusted files', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-run-cwd-'));
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-run-store-'));
    const targetWorkspace = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-run-target-'));
    try {
      const install = await installPackageFromSource({
        source: commandFixtureRoot,
        cwd,
        env: { AHARNESS_HOME: storeRoot },
        currentCoreVersion: CURRENT_CORE_VERSION,
        npmInstall: fakeNpmInstall,
      });

      expect(install.ok, JSON.stringify(install, null, 2)).toBe(true);
      if (!install.ok) return;
      expect(install.value).toMatchObject({
        packageName: '@scope/command-package',
        verifiedCommandCount: 1,
      });

      const installs = await readTrustedInstalls(storeRoot);
      const commands = await readTrustedCommands(storeRoot);
      const record = installs.installs['@scope/command-package'];
      expect(record).toBeDefined();
      expect(commands.commands['@scope/command-package/main']).toMatchObject({
        packageName: '@scope/command-package',
        commandName: 'main',
        entry: 'fsms/main.fsm.ts',
        packageRoot: record?.packageRoot,
        lockFingerprint: record?.lockFingerprint,
      });

      const listStdout = captureStream();
      const listStderr = captureStream();
      const listed = await runListInstalledCli({
        cwd: targetWorkspace,
        stdout: listStdout.stream,
        stderr: listStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
      });
      expect(listed).toEqual({ exitCode: 0 });
      expect(listStderr.text()).toBe('');
      expect(listStdout.text()).toContain('@scope/command-package 1.0.0');
      expect(listStdout.text()).toContain('  main  Installed loader command');

      const verifyPackageStdout = captureStream();
      const verifyPackageStderr = captureStream();
      const verifiedPackage = await runVerifyInstalledCli({
        target: '@scope/command-package',
        cwd: targetWorkspace,
        stdout: verifyPackageStdout.stream,
        stderr: verifyPackageStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
      });
      expect(verifiedPackage).toEqual({ exitCode: 0 });
      expect(verifyPackageStderr.text()).toBe('');
      expect(verifyPackageStdout.text()).toContain(
        'verify: ok (@scope/command-package/main, 0 warnings)',
      );

      const verifyCommandStdout = captureStream();
      const verifyCommandStderr = captureStream();
      const verifiedCommand = await runVerifyInstalledCli({
        target: '@scope/command-package/main',
        cwd: targetWorkspace,
        stdout: verifyCommandStdout.stream,
        stderr: verifyCommandStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
      });
      expect(verifiedCommand).toEqual({ exitCode: 0 });
      expect(verifyCommandStderr.text()).toBe('');
      expect(verifyCommandStdout.text()).toContain(
        'verify: ok (@scope/command-package/main, 0 warnings)',
      );

      const runtimeCalls: {
        readonly opts: RunCliForTestOpts;
        readonly loaded: LoadFsmResult;
      }[] = [];
      const runCliImpl = vi.fn(async (opts: RunCliForTestOpts) => {
        const loaded = await opts.loadFsmImpl?.({ filePath: opts.fsmPath, repoRoot: opts.cwd });
        if (!loaded) throw new Error('installed run did not provide loadFsmImpl');
        runtimeCalls.push({ opts, loaded });
        return { exitCode: 0 };
      });

      const fullRun = await runInstalledCli({
        command: '@scope/command-package/main',
        cwd: targetWorkspace,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'release', '--dry-run'],
        env: { AHARNESS_HOME: storeRoot },
        runCliImpl,
      });
      const bareRun = await runInstalledCli({
        command: 'main',
        cwd: targetWorkspace,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'bare'],
        env: { AHARNESS_HOME: storeRoot },
        runCliImpl,
      });

      expect(fullRun).toEqual({ exitCode: 0 });
      expect(bareRun).toEqual({ exitCode: 0 });
      expect(runtimeCalls).toHaveLength(2);
      expect(runtimeCalls[0]?.opts).toMatchObject({
        cwd: targetWorkspace,
        inputArgs: ['--topic', 'release', '--dry-run'],
      });
      expect(runtimeCalls[1]?.opts).toMatchObject({
        cwd: targetWorkspace,
        inputArgs: ['--topic', 'bare'],
      });
      expect(runtimeCalls[0]?.loaded.machine.id).toBe('installed-command-dependency');
      expect(runtimeCalls[0]?.loaded.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
      expect(runtimeCalls[0]?.loaded.sidecar['dependency.dependency']?.['done']).toBeDefined();
      expect(runtimeCalls[0]?.loaded.modulePath).toContain(
        path.join(storeRoot, 'packages', '.aharness', 'cache', 'installed'),
      );

      await rewritePackageLockCommit(storeRoot, 'changed-behind-record');
      const mismatchStderr = captureStream();
      const mismatch = await runInstalledCli({
        command: '@scope/command-package/main',
        cwd: targetWorkspace,
        stdout: captureStream().stream,
        stderr: mismatchStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        runCliImpl,
      });
      expect(mismatch).toEqual({ exitCode: 1 });
      expect(mismatchStderr.text()).toContain('installed-lock-fingerprint-mismatch');
      expect(mismatchStderr.text()).toContain('reinstall or uninstall');
      expect(runCliImpl).toHaveBeenCalledTimes(2);
      await fakeNpmInstall({
        managedProjectRoot: path.join(storeRoot, 'packages'),
        cwd,
        source: commandFixtureRoot,
      });

      const uninstallStdout = captureStream();
      const uninstallStderr = captureStream();
      const uninstalled = await runUninstallCli({
        packageName: '@scope/command-package',
        cwd: targetWorkspace,
        stdout: uninstallStdout.stream,
        stderr: uninstallStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        npmUninstall: fakeNpmUninstall,
      });
      expect(uninstalled).toEqual({ exitCode: 0 });
      expect(uninstallStderr.text()).toBe('');
      expect(uninstallStdout.text()).toContain(
        'aharness uninstall: uninstalled @scope/command-package (1 command removed)',
      );

      const afterUninstallRunStderr = captureStream();
      const afterUninstallRun = await runInstalledCli({
        command: '@scope/command-package/main',
        cwd: targetWorkspace,
        stdout: captureStream().stream,
        stderr: afterUninstallRunStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
        runCliImpl,
      });
      expect(afterUninstallRun).toEqual({ exitCode: 1 });
      expect(afterUninstallRunStderr.text()).toContain('command-not-found');

      const afterUninstallVerifyStderr = captureStream();
      const afterUninstallVerify = await runVerifyInstalledCli({
        target: '@scope/command-package',
        cwd: targetWorkspace,
        stdout: captureStream().stream,
        stderr: afterUninstallVerifyStderr.stream,
        env: { AHARNESS_HOME: storeRoot },
      });
      expect(afterUninstallVerify).toEqual({ exitCode: 1 });
      expect(afterUninstallVerifyStderr.text()).toContain('installed-package-not-found');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
      await rm(targetWorkspace, { recursive: true, force: true });
    }
  }, 15_000);
});

const fakeNpmInstall: InstallNpmRunner = async ({ managedProjectRoot, source, cwd }) => {
  const sourceRoot = path.resolve(cwd, source);
  const sourcePackageJson = (await readJson(path.join(sourceRoot, 'package.json'))) as {
    readonly name: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  };
  const dependencyPackageJson = (await readJson(
    path.join(dependencyFixtureRoot, 'package.json'),
  )) as {
    readonly name: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  };
  const packageRoot = path.join(managedProjectRoot, 'node_modules', sourcePackageJson.name);
  const dependencyRoot = path.join(managedProjectRoot, 'node_modules', dependencyPackageJson.name);

  await rm(packageRoot, { recursive: true, force: true });
  await rm(dependencyRoot, { recursive: true, force: true });
  await mkdir(path.dirname(packageRoot), { recursive: true });
  await mkdir(path.dirname(dependencyRoot), { recursive: true });
  await cp(sourceRoot, packageRoot, { recursive: true });
  await cp(dependencyFixtureRoot, dependencyRoot, { recursive: true });
  await writeManagedCoreTrap(managedProjectRoot);
  await writeManagedPackageJson(managedProjectRoot, {
    [sourcePackageJson.name]: `file:${sourceRoot}`,
  });
  await writePackageLock(managedProjectRoot, {
    commandPackage: sourcePackageJson,
    commandSourceRoot: sourceRoot,
    dependencyPackage: dependencyPackageJson,
    commit: 'initial-commit',
  });

  return { ok: true, value: { stdout: '', stderr: '' } };
};

const fakeNpmUninstall: UninstallNpmRunner = async ({ managedProjectRoot, dependencyKey }) => {
  await rm(path.join(managedProjectRoot, 'node_modules', dependencyKey), {
    recursive: true,
    force: true,
  });
  await writeManagedPackageJson(managedProjectRoot, {});
  await writeFile(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        lockfileVersion: 3,
        packages: {
          '': {},
        },
      },
      null,
      2,
    ) + '\n',
  );
  return { ok: true, value: { stdout: '', stderr: '' } };
};

async function writeManagedPackageJson(
  managedProjectRoot: string,
  dependencies: Record<string, string>,
): Promise<void> {
  await mkdir(managedProjectRoot, { recursive: true });
  await writeFile(
    path.join(managedProjectRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        private: true,
        dependencies,
      },
      null,
      2,
    ) + '\n',
  );
}

async function writePackageLock(
  managedProjectRoot: string,
  opts: {
    readonly commandPackage: {
      readonly name: string;
      readonly version?: string;
      readonly dependencies?: Record<string, string>;
    };
    readonly commandSourceRoot: string;
    readonly dependencyPackage: {
      readonly name: string;
      readonly version?: string;
      readonly dependencies?: Record<string, string>;
    };
    readonly commit: string;
  },
): Promise<void> {
  const packages: Record<string, unknown> = {
    '': {
      dependencies: {
        [opts.commandPackage.name]: `file:${opts.commandSourceRoot}`,
      },
    },
    [`node_modules/${opts.commandPackage.name}`]: {
      version: opts.commandPackage.version ?? '0.0.0',
      resolved: `file:${opts.commandSourceRoot}#${opts.commit}`,
      dependencies: opts.commandPackage.dependencies ?? {},
    },
    [`node_modules/${opts.dependencyPackage.name}`]: {
      version: opts.dependencyPackage.version ?? '0.0.0',
      resolved: `file:${dependencyFixtureRoot}`,
      dependencies: opts.dependencyPackage.dependencies ?? {},
    },
    'node_modules/@aharness/core': {
      version: CURRENT_CORE_VERSION,
      resolved: 'https://registry.npmjs.org/@aharness/core/-/core-0.1.0.tgz',
      integrity: 'sha512-host-core',
    },
  };

  await writeFile(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        lockfileVersion: 3,
        packages,
      },
      null,
      2,
    ) + '\n',
  );
}

async function rewritePackageLockCommit(storeRoot: string, commit: string): Promise<void> {
  const managedProjectRoot = path.join(storeRoot, 'packages');
  const commandPackageJson = (await readJson(path.join(commandFixtureRoot, 'package.json'))) as {
    readonly name: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  };
  const dependencyPackageJson = (await readJson(
    path.join(dependencyFixtureRoot, 'package.json'),
  )) as {
    readonly name: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  };
  await writePackageLock(managedProjectRoot, {
    commandPackage: commandPackageJson,
    commandSourceRoot: commandFixtureRoot,
    dependencyPackage: dependencyPackageJson,
    commit,
  });
}

async function writeManagedCoreTrap(managedProjectRoot: string): Promise<void> {
  const fakeCoreRoot = path.join(managedProjectRoot, 'node_modules', '@aharness', 'core');
  await mkdir(fakeCoreRoot, { recursive: true });
  await writeFile(
    path.join(fakeCoreRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@aharness/core',
        version: '99.0.0',
        type: 'module',
        exports: './index.js',
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    path.join(fakeCoreRoot, 'index.js'),
    "throw new Error('managed project @aharness/core must not be imported');\n",
  );
}

async function readTrustedInstalls(storeRoot: string): Promise<TrustedInstallsFile> {
  return (await readJson(path.join(storeRoot, 'installs.json'))) as TrustedInstallsFile;
}

async function readTrustedCommands(storeRoot: string): Promise<TrustedCommandsFile> {
  return (await readJson(path.join(storeRoot, 'commands.json'))) as TrustedCommandsFile;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}
