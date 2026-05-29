import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ensureManagedProject,
  readManagedProjectDependencies,
  runNpmInstall,
  runNpmUninstall,
  type NpmSpawnInvocation,
} from '../src/installStore/index.js';

async function tmpStore(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'aharness-install-store-npm-'));
}

describe('managed npm project', () => {
  it('creates the managed project manifest without erasing dependencies', async () => {
    const storeRoot = await tmpStore();
    const managedProjectRoot = path.join(storeRoot, 'packages');

    const created = await ensureManagedProject({ managedProjectRoot });
    expect(created.ok).toBe(true);

    const firstManifest = JSON.parse(
      await readFile(path.join(managedProjectRoot, 'package.json'), 'utf8'),
    ) as { private?: unknown; dependencies?: Record<string, string> };
    expect(firstManifest.private).toBe(true);
    expect(firstManifest.dependencies).toEqual({});

    await writeFile(
      path.join(managedProjectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'aharness-managed-fsm-packages',
          private: true,
          dependencies: {
            '@scope/tools': 'file:../tools',
          },
        },
        null,
        2,
      ) + '\n',
    );

    const preserved = await ensureManagedProject({ managedProjectRoot });
    expect(preserved.ok).toBe(true);
    await expect(readManagedProjectDependencies(managedProjectRoot)).resolves.toEqual({
      ok: true,
      value: {
        '@scope/tools': 'file:../tools',
      },
    });
  });

  it('spawns npm with shell false and passes the source as one argv item after --', async () => {
    const managedProjectRoot = await tmpStore();
    const calls: NpmSpawnInvocation[] = [];

    const result = await runNpmInstall({
      managedProjectRoot,
      cwd: managedProjectRoot,
      source: '@scope/tools@latest',
      spawn: async (call) => {
        calls.push(call);
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });

    expect(result).toEqual({ ok: true, value: { stdout: 'ok', stderr: '' } });
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['install', '--save-prod', '--', '@scope/tools@latest'],
        options: {
          cwd: managedProjectRoot,
          shell: false,
        },
      },
    ]);
  });

  it('passes local directory sources to npm as absolute paths with --install-links', async () => {
    const caller = await tmpStore();
    const managedProjectRoot = await tmpStore();
    const localPackage = path.join(caller, 'workflow-package');
    const calls: NpmSpawnInvocation[] = [];
    await mkdir(localPackage, { recursive: true });
    await writeFile(
      path.join(localPackage, 'package.json'),
      JSON.stringify({ name: '@scope/local-workflows' }) + '\n',
    );

    const result = await runNpmInstall({
      managedProjectRoot,
      cwd: caller,
      source: './workflow-package',
      spawn: async (call) => {
        calls.push(call);
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual([
      'install',
      '--save-prod',
      '--install-links',
      '--',
      localPackage,
    ]);
  });

  it('passes local tarball sources to npm as absolute paths without --install-links', async () => {
    const caller = await tmpStore();
    const managedProjectRoot = await tmpStore();

    const tarball = path.join(caller, 'workflow-package.tgz');
    const tarGz = path.join(caller, 'workflow-package.tar.gz');
    await writeFile(tarball, 'tgz bytes');
    await writeFile(tarGz, 'tar.gz bytes');

    const cases = [
      { source: './workflow-package.tgz', expected: await realpath(tarball) },
      { source: 'file:workflow-package.tgz', expected: await realpath(tarball) },
      { source: pathToFileURL(tarball).href, expected: await realpath(tarball) },
      { source: './workflow-package.tar.gz', expected: await realpath(tarGz) },
    ];

    for (const testCase of cases) {
      const calls: NpmSpawnInvocation[] = [];
      const result = await runNpmInstall({
        managedProjectRoot,
        cwd: caller,
        source: testCase.source,
        spawn: async (call) => {
          calls.push(call);
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      expect(result.ok, testCase.source).toBe(true);
      expect(calls[0]?.args, testCase.source).toEqual([
        'install',
        '--save-prod',
        '--',
        testCase.expected,
      ]);
    }
  });

  it('spawns npm uninstall with shell false, --save, and the dependency key', async () => {
    const managedProjectRoot = await tmpStore();
    const calls: NpmSpawnInvocation[] = [];

    const result = await runNpmUninstall({
      managedProjectRoot,
      dependencyKey: '@scope/tools-alias',
      spawn: async (call) => {
        calls.push(call);
        return { status: 0, stdout: 'removed', stderr: '' };
      },
    });

    expect(result).toEqual({ ok: true, value: { stdout: 'removed', stderr: '' } });
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['uninstall', '--save', '@scope/tools-alias'],
        options: {
          cwd: managedProjectRoot,
          shell: false,
        },
      },
    ]);
  });
});
