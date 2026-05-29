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

  it('refreshes same registry, git, local tarball, and remote tarball sources without changing package identity', async () => {
    const cwd = await tmpRoot('aharness-install-cli-identity-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-identity-store-');
    const registryV1 = path.join(cwd, 'registry-v1');
    const registryV2 = path.join(cwd, 'registry-v2');
    const gitV1 = path.join(cwd, 'git-v1');
    const gitV2 = path.join(cwd, 'git-v2');
    const tarballV1 = path.join(cwd, 'tarball-v1');
    const tarballV2 = path.join(cwd, 'tarball-v2');
    const remoteV1 = path.join(cwd, 'remote-v1');
    const remoteV2 = path.join(cwd, 'remote-v2');
    const tarballPath = path.join(cwd, 'tarball-package.tgz');
    let activeTarballRoot = tarballV1;
    let activeTarballIntegrity = 'sha512-tarball-one';
    await writeFile(tarballPath, 'tarball-one');

    await writeInstallPackage(registryV1, {
      name: '@scope/registry-tools',
      version: '1.0.0',
      fsmSource: validFsmSource('registry-one'),
    });
    await writeInstallPackage(registryV2, {
      name: '@scope/registry-tools',
      version: '2.0.0',
      fsmSource: validFsmSource('registry-two'),
    });
    await writeInstallPackage(gitV1, {
      name: 'git-tools',
      version: '1.0.0',
      fsmSource: validFsmSource('git-one'),
    });
    await writeInstallPackage(gitV2, {
      name: 'git-tools',
      version: '1.0.1',
      fsmSource: validFsmSource('git-two'),
    });
    await writeInstallPackage(tarballV1, {
      name: 'tarball-tools',
      version: '1.0.0',
      fsmSource: validFsmSource('tarball-one'),
    });
    await writeInstallPackage(tarballV2, {
      name: 'tarball-tools',
      version: '1.0.1',
      fsmSource: validFsmSource('tarball-two'),
    });
    await writeInstallPackage(remoteV1, {
      name: 'remote-tools',
      version: '1.0.0',
      fsmSource: validFsmSource('remote-one'),
    });
    await writeInstallPackage(remoteV2, {
      name: 'remote-tools',
      version: '1.0.1',
      fsmSource: validFsmSource('remote-two'),
    });

    const npmInstall = fakeNpmInstallFromSources({
      '@scope/registry-tools@1.0.0': {
        sourceRoot: registryV1,
        dependencyKey: '@scope/registry-tools',
        dependencySpec: '1.0.0',
        lockResolved: 'https://registry.npmjs.org/@scope/registry-tools/-/registry-tools-1.0.0.tgz',
        lockIntegrity: 'sha512-registry-one',
      },
      '@scope/registry-tools@latest': {
        sourceRoot: registryV2,
        dependencyKey: '@scope/registry-tools',
        dependencySpec: 'latest',
        lockResolved: 'https://registry.npmjs.org/@scope/registry-tools/-/registry-tools-2.0.0.tgz',
        lockIntegrity: 'sha512-registry-two',
      },
      'owner/repo#main': {
        sourceRoot: gitV1,
        dependencyKey: 'git-tools',
        dependencySpec: 'github:owner/repo#main',
        lockResolved: 'git+ssh://git@github.com/owner/repo.git#abc123',
      },
      'git+ssh://git@github.com/owner/repo.git#semver:^1': {
        sourceRoot: gitV2,
        dependencyKey: 'git-tools',
        dependencySpec: 'git+ssh://git@github.com/owner/repo.git#semver:^1',
        lockResolved: 'git+ssh://git@github.com/owner/repo.git#def456',
      },
      './tarball-package.tgz': () => ({
        sourceRoot: activeTarballRoot,
        dependencyKey: 'tarball-tools',
        dependencySpec: `file:${tarballPath}`,
        lockResolved: `file:${tarballPath}`,
        lockIntegrity: activeTarballIntegrity,
      }),
      'https://user:one@example.com/packages/tools.tgz?_authToken=one&cache=keep': {
        sourceRoot: remoteV1,
        dependencyKey: 'remote-tools',
        dependencySpec: 'https://user:one@example.com/packages/tools.tgz?_authToken=one&cache=keep',
        lockResolved: 'https://example.com/packages/tools.tgz?cache=keep',
        lockIntegrity: 'sha512-remote-one',
      },
      'https://user:two@example.com/packages/tools.tgz?_authToken=two&cache=keep': {
        sourceRoot: remoteV2,
        dependencyKey: 'remote-tools',
        dependencySpec: 'https://user:two@example.com/packages/tools.tgz?_authToken=two&cache=keep',
        lockResolved: 'https://example.com/packages/tools.tgz?cache=keep',
        lockIntegrity: 'sha512-remote-two',
      },
    });

    await expectInstallOk('@scope/registry-tools@1.0.0', cwd, storeRoot, npmInstall);
    const registryFirst = (await readTrustedInstalls(storeRoot)).installs['@scope/registry-tools'];
    await expectInstallOk('@scope/registry-tools@latest', cwd, storeRoot, npmInstall);
    const registrySecond = (await readTrustedInstalls(storeRoot)).installs['@scope/registry-tools'];
    expect(registrySecond?.sourceIntentKey).toBe(registryFirst?.sourceIntentKey);
    expect(registrySecond?.sourceIntentKey).toBe(
      'registry:https://registry.npmjs.org/:@scope/registry-tools',
    );
    expect(registrySecond?.packageVersion).toBe('2.0.0');
    expect(registrySecond?.lockFingerprint).not.toBe(registryFirst?.lockFingerprint);

    await expectInstallOk('owner/repo#main', cwd, storeRoot, npmInstall);
    const gitFirst = (await readTrustedInstalls(storeRoot)).installs['git-tools'];
    await expectInstallOk(
      'git+ssh://git@github.com/owner/repo.git#semver:^1',
      cwd,
      storeRoot,
      npmInstall,
    );
    const gitSecond = (await readTrustedInstalls(storeRoot)).installs['git-tools'];
    expect(gitSecond?.sourceIntentKey).toBe('git:https://github.com/owner/repo');
    expect(gitSecond?.sourceIntentKey).toBe(gitFirst?.sourceIntentKey);
    expect(gitSecond?.lockFingerprint).not.toBe(gitFirst?.lockFingerprint);

    await expectInstallOk('./tarball-package.tgz', cwd, storeRoot, npmInstall);
    const tarballFirst = (await readTrustedInstalls(storeRoot)).installs['tarball-tools'];
    activeTarballRoot = tarballV2;
    activeTarballIntegrity = 'sha512-tarball-two';
    await writeFile(tarballPath, 'tarball-two');
    await expectInstallOk('./tarball-package.tgz', cwd, storeRoot, npmInstall);
    const tarballSecond = (await readTrustedInstalls(storeRoot)).installs['tarball-tools'];
    expect(tarballSecond?.sourceIntentKey).toBe(tarballFirst?.sourceIntentKey);
    expect(tarballSecond?.packageVersion).toBe('1.0.1');
    expect(tarballSecond?.lockFingerprint).not.toBe(tarballFirst?.lockFingerprint);

    await expectInstallOk(
      'https://user:one@example.com/packages/tools.tgz?_authToken=one&cache=keep',
      cwd,
      storeRoot,
      npmInstall,
    );
    const remoteFirst = (await readTrustedInstalls(storeRoot)).installs['remote-tools'];
    await expectInstallOk(
      'https://user:two@example.com/packages/tools.tgz?_authToken=two&cache=keep',
      cwd,
      storeRoot,
      npmInstall,
    );
    const remoteSecond = (await readTrustedInstalls(storeRoot)).installs['remote-tools'];
    expect(remoteSecond?.sourceIntentKey).toBe(
      'remote-tarball:https://example.com/packages/tools.tgz?cache=keep',
    );
    expect(remoteSecond?.sourceIntentKey).toBe(remoteFirst?.sourceIntentKey);
    expect(remoteSecond?.lockFingerprint).not.toBe(remoteFirst?.lockFingerprint);
  });

  it('rejects the same registry package name from a different registry origin', async () => {
    const cwd = await tmpRoot('aharness-install-cli-registry-origin-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-registry-origin-store-');
    const publicRoot = path.join(cwd, 'registry-public');
    const privateRoot = path.join(cwd, 'registry-private');
    await writeInstallPackage(publicRoot, {
      name: '@scope/origin-tools',
      version: '1.0.0',
      fsmSource: validFsmSource('registry-public'),
    });
    await writeInstallPackage(privateRoot, {
      name: '@scope/origin-tools',
      version: '2.0.0',
      fsmSource: validFsmSource('registry-private'),
    });

    const npmInstall = fakeNpmInstallFromSources({
      '@scope/origin-tools@1.0.0': {
        sourceRoot: publicRoot,
        dependencyKey: '@scope/origin-tools',
        dependencySpec: '1.0.0',
        lockResolved: 'https://registry.npmjs.org/@scope/origin-tools/-/origin-tools-1.0.0.tgz',
        lockIntegrity: 'sha512-public-origin',
      },
      '@scope/origin-tools@2.0.0': {
        sourceRoot: privateRoot,
        dependencyKey: '@scope/origin-tools',
        dependencySpec: '2.0.0',
        lockResolved:
          'https://registry.internal.example/@scope/origin-tools/-/origin-tools-2.0.0.tgz',
        lockIntegrity: 'sha512-private-origin',
      },
    });

    await expectInstallOk('@scope/origin-tools@1.0.0', cwd, storeRoot, npmInstall);
    const beforeInstalls = await readFile(path.join(storeRoot, 'installs.json'), 'utf8');

    const collision = await installPackageFromSource({
      source: '@scope/origin-tools@2.0.0',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall,
    });

    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.diagnostics).toEqual([
        expect.objectContaining({
          code: 'install-source-collision',
          field: 'installs.@scope/origin-tools.sourceIntentKey',
        }),
      ]);
      expect(collision.npmMutated).toBe(true);
    }
    await expect(readFile(path.join(storeRoot, 'installs.json'), 'utf8')).resolves.toBe(
      beforeInstalls,
    );
  });

  it('uses installed package identity for npm aliases and rejects different source collisions', async () => {
    const cwd = await tmpRoot('aharness-install-cli-alias-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-alias-store-');
    const aliasRoot = path.join(cwd, 'alias-target');
    const localRoot = path.join(cwd, 'collision-local');
    const registryRoot = path.join(cwd, 'collision-registry');
    await writeInstallPackage(aliasRoot, {
      name: '@scope/alias-target',
      version: '1.0.0',
      fsmSource: validFsmSource('alias-target'),
    });
    await writeInstallPackage(localRoot, {
      name: '@scope/collision-target',
      version: '1.0.0',
      fsmSource: validFsmSource('collision-local'),
    });
    await writeInstallPackage(registryRoot, {
      name: '@scope/collision-target',
      version: '2.0.0',
      fsmSource: validFsmSource('collision-registry'),
    });
    const npmInstall = fakeNpmInstallFromSources({
      'tools@npm:@scope/alias-target@latest': {
        sourceRoot: aliasRoot,
        dependencyKey: 'tools',
        dependencySpec: 'npm:@scope/alias-target@latest',
        lockResolved: 'https://registry.npmjs.org/@scope/alias-target/-/alias-target-1.0.0.tgz',
        lockIntegrity: 'sha512-alias',
      },
      '@scope/collision-target@latest': {
        sourceRoot: registryRoot,
        dependencyKey: '@scope/collision-target',
        dependencySpec: 'latest',
        lockResolved:
          'https://registry.npmjs.org/@scope/collision-target/-/collision-target-2.0.0.tgz',
        lockIntegrity: 'sha512-collision-registry',
      },
    });

    await expectInstallOk('tools@npm:@scope/alias-target@latest', cwd, storeRoot, npmInstall);
    const aliasRecord = (await readTrustedInstalls(storeRoot)).installs['@scope/alias-target'];
    expect(aliasRecord).toMatchObject({
      packageName: '@scope/alias-target',
      dependencyKey: 'tools',
      sourceIntentKey: 'registry:https://registry.npmjs.org/:@scope/alias-target',
    });

    await expectInstallOk('./collision-local', cwd, storeRoot, npmInstall);
    const beforeInstalls = await readFile(path.join(storeRoot, 'installs.json'), 'utf8');
    const collision = await installPackageFromSource({
      source: '@scope/collision-target@latest',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall,
    });

    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.diagnostics).toEqual([
        expect.objectContaining({
          code: 'install-source-collision',
          message: expect.stringContaining(
            "package '@scope/collision-target' is already installed from a different source",
          ),
        }),
      ]);
      expect(collision.npmMutated).toBe(true);
    }
    await expect(readFile(path.join(storeRoot, 'installs.json'), 'utf8')).resolves.toBe(
      beforeInstalls,
    );
  });

  it('leaves trusted files unchanged when same-source refresh validation fails', async () => {
    const cwd = await tmpRoot('aharness-install-cli-refresh-failure-cwd-');
    const storeRoot = await tmpRoot('aharness-install-cli-refresh-failure-store-');
    const sourceRoot = path.join(cwd, 'refresh-failure');
    await writeInstallPackage(sourceRoot, {
      name: 'refresh-failure',
      version: '1.0.0',
      fsmSource: validFsmSource('refresh-failure-one'),
    });
    await expectInstallOk('./refresh-failure', cwd, storeRoot, fakeNpmInstall);
    const beforeInstalls = await readFile(path.join(storeRoot, 'installs.json'), 'utf8');
    const beforeCommands = await readFile(path.join(storeRoot, 'commands.json'), 'utf8');

    await writeInstallPackage(sourceRoot, {
      name: 'refresh-failure',
      version: '1.0.1',
      fsmSource: validFsmSource('refresh-failure-two'),
      aharnessPackage: {},
    });
    const failure = await installPackageFromSource({
      source: './refresh-failure',
      cwd,
      env: { AHARNESS_HOME: storeRoot },
      currentCoreVersion: CURRENT_CORE_VERSION,
      npmInstall: fakeNpmInstall,
    });

    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.diagnostics).toEqual([
        expect.objectContaining({ code: 'install-commands-missing' }),
      ]);
    }
    await expect(readFile(path.join(storeRoot, 'installs.json'), 'utf8')).resolves.toBe(
      beforeInstalls,
    );
    await expect(readFile(path.join(storeRoot, 'commands.json'), 'utf8')).resolves.toBe(
      beforeCommands,
    );
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

type FakeInstallSource =
  | FakeInstallSourceConfig
  | (() => FakeInstallSourceConfig | Promise<FakeInstallSourceConfig>);

interface FakeInstallSourceConfig {
  readonly sourceRoot: string;
  readonly dependencyKey?: string;
  readonly dependencySpec?: string;
  readonly lockResolved?: string;
  readonly lockIntegrity?: string;
}

const fakeNpmInstall: InstallNpmRunner = async (opts) => {
  return fakeNpmInstallFromSources({})(opts);
};

function fakeNpmInstallFromSources(
  sources: Readonly<Record<string, FakeInstallSource>>,
): InstallNpmRunner {
  return async ({ managedProjectRoot, source, cwd }) => {
    const configured = await resolveFakeInstallSource(sources[source]);
    const sourceRoot = configured?.sourceRoot ?? path.resolve(cwd, source);
    const packageJson = (await readJson(path.join(sourceRoot, 'package.json'))) as {
      readonly name: string;
      readonly version?: string;
      readonly dependencies?: Record<string, string>;
    };
    const dependencyKey = configured?.dependencyKey ?? packageJson.name;
    const dependencySpec = configured?.dependencySpec ?? `file:${source}`;
    const packageRoot = path.join(managedProjectRoot, 'node_modules', dependencyKey);
    await rm(packageRoot, { recursive: true, force: true });
    await mkdir(path.dirname(packageRoot), { recursive: true });
    await cp(sourceRoot, packageRoot, { recursive: true });
    await writeManagedPackageJson(managedProjectRoot, dependencyKey, dependencySpec);
    await writePackageLock(managedProjectRoot, dependencyKey, packageJson, {
      dependencySpec,
      resolved: configured?.lockResolved,
      integrity: configured?.lockIntegrity,
    });
    return { ok: true, value: { stdout: '', stderr: '' } };
  };
}

async function resolveFakeInstallSource(
  source: FakeInstallSource | undefined,
): Promise<FakeInstallSourceConfig | null> {
  if (source === undefined) return null;
  return typeof source === 'function' ? await source() : source;
}

async function expectInstallOk(
  source: string,
  cwd: string,
  storeRoot: string,
  npmInstall: InstallNpmRunner,
): Promise<void> {
  const result = await installPackageFromSource({
    source,
    cwd,
    env: { AHARNESS_HOME: storeRoot },
    currentCoreVersion: CURRENT_CORE_VERSION,
    npmInstall,
  });
  expect(result.ok, source).toBe(true);
}

async function writeManagedPackageJson(
  managedProjectRoot: string,
  dependencyKey: string,
  dependencySpec: string,
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
          [dependencyKey]: dependencySpec,
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
  opts: {
    readonly dependencySpec: string;
    readonly resolved?: string;
    readonly integrity?: string;
  },
): Promise<void> {
  const dependencies = packageJson.dependencies ?? {};
  const packages: Record<string, unknown> = {
    '': {
      dependencies: {
        [dependencyKey]: opts.dependencySpec,
      },
    },
    [`node_modules/${dependencyKey}`]: {
      version: packageJson.version ?? '0.0.0',
      resolved: opts.resolved ?? opts.dependencySpec,
      ...(opts.integrity !== undefined ? { integrity: opts.integrity } : {}),
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
