import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runInstallCli } from '../src/cli/installCli.js';
import {
  installPackageFromSource,
  type InstallNpmRunner,
  type TrustedCommandsFile,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

const CURRENT_CORE_VERSION = '0.1.0';

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

async function tmpRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('aharness install CLI', () => {
  it('installs a valid local package and writes verified trusted records', async () => {
    const cwd = await tmpRoot('aharness-install-cli-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-store-');
    await writeInstallPackage(path.join(cwd, 'valid-package'), {
      name: '@scope/valid-package',
      version: '1.0.0',
      description: 'Valid command',
      fsmSource: validFsmSource('valid-install'),
    });

    const result = await installPackageFromSource({
      source: './valid-package',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageName).toBe('@scope/valid-package');
    expect(result.value.verifiedCommandCount).toBe(1);

    const installs = await readTrustedInstalls(storeRoot);
    const commands = await readTrustedCommands(storeRoot);
    const record = installs.installs['@scope/valid-package'];
    expect(record).toMatchObject({
      packageName: '@scope/valid-package',
      dependencyKey: '@scope/valid-package',
      requestedSpec: './valid-package',
      packageVersion: '1.0.0',
      sourceIntentKey: `local-directory:${await realPath(path.join(cwd, 'valid-package'))}`,
      commands: {
        main: {
          commandName: 'main',
          entry: 'fsms/main.fsm.ts',
          description: 'Valid command',
        },
      },
    });
    expect(record?.packageRoot).toBe(
      path.join(storeRoot, 'packages', 'node_modules', '@scope', 'valid-package'),
    );
    expect(record?.lockFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(commands.generation).toBe(installs.generation);
    expect(commands.commands['@scope/valid-package/main']).toMatchObject({
      packageName: '@scope/valid-package',
      commandName: 'main',
      entry: 'fsms/main.fsm.ts',
      packageRoot: record?.packageRoot,
      packageVersion: '1.0.0',
      lockFingerprint: record?.lockFingerprint,
      description: 'Valid command',
    });
  });

  it('formats successful and failed installs for the public CLI', async () => {
    const cwd = await tmpRoot('aharness-install-cli-format-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-format-store-');
    await writeInstallPackage(path.join(cwd, 'valid-package'), {
      name: 'valid-package',
      version: '1.0.0',
      fsmSource: validFsmSource('format-install'),
    });
    await writeInstallPackage(path.join(cwd, 'invalid-package'), {
      name: 'invalid-package',
      version: '1.0.0',
      fsmSource: validFsmSource('invalid-metadata'),
      aharnessPackage: {},
    });

    const stdout = captureStream();
    const stderr = captureStream();
    const success = await runInstallCli({
      source: './valid-package',
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });

    expect(success).toEqual({ exitCode: 0 });
    expect(stdout.text()).toContain(
      'aharness install: installed valid-package (1 command verified)',
    );
    expect(stderr.text()).toBe('');

    const failedStdout = captureStream();
    const failedStderr = captureStream();
    const failure = await runInstallCli({
      source: './invalid-package',
      cwd,
      stdout: failedStdout.stream,
      stderr: failedStderr.stream,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });

    expect(failure).toEqual({ exitCode: 1 });
    expect(failedStdout.text()).toBe('');
    expect(failedStderr.text()).toContain('aharness install failed:');
    expect(failedStderr.text()).toContain('[install-commands-missing]');
    expect(failedStderr.text()).toContain('npm may have changed files under');
    expect(failedStderr.text()).toContain('unverified commands were not indexed');
  });

  it('leaves trusted files unchanged on metadata, asset, verifier, and collision failures', async () => {
    const cwd = await tmpRoot('aharness-install-cli-failures-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-failures-store-');
    await writeInstallPackage(path.join(cwd, 'valid-package'), {
      name: '@scope/failure-target',
      version: '1.0.0',
      fsmSource: validFsmSource('failure-baseline'),
    });

    const baseline = await installPackageFromSource({
      source: './valid-package',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });
    expect(baseline.ok).toBe(true);
    const before = await readFile(path.join(storeRoot, 'installs.json'), 'utf8');

    await writeInstallPackage(path.join(cwd, 'invalid-metadata'), {
      name: '@scope/invalid-metadata',
      version: '1.0.0',
      fsmSource: validFsmSource('invalid-metadata'),
      aharnessPackage: {},
    });
    await writeInstallPackage(path.join(cwd, 'invalid-asset'), {
      name: '@scope/invalid-asset',
      version: '1.0.0',
      fsmSource: invalidAssetFsmSource(),
    });
    await writeInstallPackage(path.join(cwd, 'invalid-verifier'), {
      name: '@scope/invalid-verifier',
      version: '1.0.0',
      fsmSource: verifierFailureFsmSource(),
    });
    await writeInstallPackage(path.join(cwd, 'different-source-same-name'), {
      name: '@scope/failure-target',
      version: '2.0.0',
      fsmSource: validFsmSource('different-source'),
    });

    for (const source of [
      './invalid-metadata',
      './invalid-asset',
      './invalid-verifier',
      './different-source-same-name',
    ]) {
      const failed = await installPackageFromSource({
        source,
        cwd,
        env: { AHARNESS_HOME: storeRoot },
        currentCoreVersion: CURRENT_CORE_VERSION,
        npmInstall: fakeNpmInstall,
      });

      expect(failed.ok, source).toBe(false);
      await expect(readFile(path.join(storeRoot, 'installs.json'), 'utf8')).resolves.toBe(before);
    }
  });

  it('refreshes the same package/source only after the new command verifies', async () => {
    const cwd = await tmpRoot('aharness-install-cli-refresh-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-refresh-store-');
    const sourceRoot = path.join(cwd, 'refresh-package');
    await writeInstallPackage(sourceRoot, {
      name: '@scope/refresh-package',
      version: '1.0.0',
      description: 'First description',
      fsmSource: validFsmSource('refresh-one'),
    });

    const first = await installPackageFromSource({
      source: './refresh-package',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });
    expect(first.ok).toBe(true);
    const firstRecord = (await readTrustedInstalls(storeRoot)).installs['@scope/refresh-package'];

    await writeInstallPackage(sourceRoot, {
      name: '@scope/refresh-package',
      version: '1.0.1',
      description: 'Second description',
      fsmSource: validFsmSource('refresh-two'),
    });

    const second = await installPackageFromSource({
      source: './refresh-package',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });
    expect(second.ok).toBe(true);
    const secondRecord = (await readTrustedInstalls(storeRoot)).installs['@scope/refresh-package'];

    expect(secondRecord?.sourceIntentKey).toBe(firstRecord?.sourceIntentKey);
    expect(secondRecord?.packageVersion).toBe('1.0.1');
    expect(secondRecord?.commands['main']?.description).toBe('Second description');
    expect(secondRecord?.lockFingerprint).not.toBe(firstRecord?.lockFingerprint);
  });

  it('rejects installs when npm changes multiple direct dependencies', async () => {
    const cwd = await tmpRoot('aharness-install-cli-ambiguous-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-ambiguous-store-');
    await writeInstallPackage(path.join(cwd, 'ambiguous-package'), {
      name: '@scope/ambiguous-package',
      version: '1.0.0',
      fsmSource: validFsmSource('ambiguous-install'),
    });

    const result = await installPackageFromSource({
      source: './ambiguous-package',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: async (opts) => {
        const installed = await fakeNpmInstall(opts);
        const managedPackageJsonPath = path.join(opts.managedProjectRoot, 'package.json');
        const managedPackageJson = (await readJson(managedPackageJsonPath)) as {
          dependencies?: Record<string, string>;
        };
        await writeFile(
          managedPackageJsonPath,
          JSON.stringify(
            {
              ...managedPackageJson,
              dependencies: {
                ...(managedPackageJson.dependencies ?? {}),
                unrelated: '^1.0.0',
              },
            },
            null,
            2,
          ) + '\n',
        );
        return installed;
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'direct-dependency-key-ambiguous' }),
      ]);
    }
    await expect(readFile(path.join(storeRoot, 'installs.json'), 'utf8')).rejects.toThrow();
  });
});

async function writeInstallPackage(
  root: string,
  opts: {
    readonly name: string;
    readonly version: string;
    readonly fsmSource: string;
    readonly description?: string;
    readonly aharnessPackage?: Record<string, unknown>;
  },
): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'fsms'), { recursive: true });
  await writeFile(path.join(root, 'fsms', 'main.fsm.ts'), opts.fsmSource);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version,
        type: 'module',
        dependencies: {
          '@aharness/core': '^0.1.0',
        },
        aharness: {
          package: opts.aharnessPackage ?? {
            commands: {
              main: {
                entry: 'fsms/main.fsm.ts',
                ...(opts.description ? { description: opts.description } : {}),
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

const fakeNpmInstall: InstallNpmRunner = async ({ managedProjectRoot, source, cwd }) => {
  const sourceRoot = path.resolve(cwd, source);
  const packageJson = (await readJson(path.join(sourceRoot, 'package.json'))) as {
    readonly name: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  };
  const dependencyKey = packageJson.name;
  const packageRoot = path.join(managedProjectRoot, 'node_modules', dependencyKey);
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(path.dirname(packageRoot), { recursive: true });
  await cp(sourceRoot, packageRoot, { recursive: true });
  await writeManagedPackageJson(managedProjectRoot, dependencyKey, source);
  await writePackageLock(managedProjectRoot, dependencyKey, packageJson);
  return { ok: true, value: { stdout: '', stderr: '' } };
};

async function writeManagedPackageJson(
  managedProjectRoot: string,
  dependencyKey: string,
  source: string,
): Promise<void> {
  let existing: { dependencies?: Record<string, string> } = {};
  try {
    existing = (await readJson(path.join(managedProjectRoot, 'package.json'))) as {
      dependencies?: Record<string, string>;
    };
  } catch {
    // The production path creates this file before invoking npm; keep the fake
    // runner robust so individual tests can call it directly if needed.
  }
  await mkdir(managedProjectRoot, { recursive: true });
  await writeFile(
    path.join(managedProjectRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        private: true,
        dependencies: {
          ...(existing.dependencies ?? {}),
          [dependencyKey]: `file:${source}`,
        },
      },
      null,
      2,
    ) + '\n',
  );
}

async function writePackageLock(
  managedProjectRoot: string,
  dependencyKey: string,
  packageJson: {
    readonly name: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  },
): Promise<void> {
  const dependencies = packageJson.dependencies ?? {};
  const packages: Record<string, unknown> = {
    '': {
      dependencies: {
        [dependencyKey]: `file:${dependencyKey}`,
      },
    },
    [`node_modules/${dependencyKey}`]: {
      version: packageJson.version ?? '0.0.0',
      resolved: `file:${dependencyKey}`,
      dependencies,
    },
  };
  for (const dependencyName of Object.keys(dependencies)) {
    packages[`node_modules/${dependencyName}`] = {
      version: dependencyName === '@aharness/core' ? CURRENT_CORE_VERSION : '1.0.0',
      resolved: `https://registry.npmjs.org/${dependencyName}/-/${dependencyName}-1.0.0.tgz`,
    };
  }

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

async function readTrustedInstalls(storeRoot: string): Promise<TrustedInstallsFile> {
  return (await readJson(path.join(storeRoot, 'installs.json'))) as TrustedInstallsFile;
}

async function readTrustedCommands(storeRoot: string): Promise<TrustedCommandsFile> {
  return (await readJson(path.join(storeRoot, 'commands.json'))) as TrustedCommandsFile;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function realPath(filePath: string): Promise<string> {
  return await import('node:fs/promises').then((fs) => fs.realpath(filePath));
}

function validFsmSource(id: string): string {
  return `
    import { aharness, final } from '@aharness/core';

    export default aharness.machine({
      id: ${JSON.stringify(id)},
      initial: 'done',
      states: {
        done: final({ outcome: 'success' }),
      },
    });
  `;
}

function invalidAssetFsmSource(): string {
  return `
    import { aharness, final } from '@aharness/core';

    const text = aharness.getAssetText('missing.md');

    export default aharness.machine({
      id: 'invalid-asset',
      initial: 'done',
      context: () => ({ text }),
      states: {
        done: final({ outcome: 'success' }),
      },
    });
  `;
}

function verifierFailureFsmSource(): string {
  return `
    import { aharness, state } from '@aharness/core';

    export default aharness.machine({
      id: 'invalid-verifier',
      initial: 'stuck',
      states: {
        stuck: state({
          entryPrompt: 'No way out',
          exits: {},
        }),
      },
    });
  `;
}
