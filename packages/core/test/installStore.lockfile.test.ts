import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  computeLockFingerprint,
  computeSourceIntentKey,
  identifyDirectDependencyKey,
} from '../src/installStore/index.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'aharness-install-lockfile-'));
}

describe('install source identity helpers', () => {
  it('detects the direct dependency key npm added or refreshed', async () => {
    expect(
      identifyDirectDependencyKey({
        before: { keep: '^1.0.0' },
        after: { keep: '^1.0.0', '@scope/tools': '^2.0.0' },
        source: '@scope/tools@latest',
      }),
    ).toEqual({ ok: true, value: '@scope/tools' });

    expect(
      identifyDirectDependencyKey({
        before: { workflows: 'npm:@scope/tools@^1.0.0' },
        after: { workflows: 'npm:@scope/tools@^2.0.0' },
        source: 'workflows@npm:@scope/tools@^2.0.0',
      }),
    ).toEqual({ ok: true, value: 'workflows' });
  });

  it('normalizes local directory source intent by realpath and registry intent by package name', async () => {
    const cwd = await tmpRoot();
    const localPackage = path.join(cwd, 'pkg');
    await mkdir(localPackage, { recursive: true });
    await writeFile(path.join(localPackage, 'package.json'), '{"name":"local"}\n');

    const local = await computeSourceIntentKey({ source: './pkg', cwd });
    const registry = await computeSourceIntentKey({ source: '@scope/tools@latest', cwd });
    const alias = await computeSourceIntentKey({
      source: 'alias-tools@npm:@scope/tools@^1.0.0',
      cwd,
    });

    expect(local).toEqual({ ok: true, value: `local-directory:${await realpath(localPackage)}` });
    expect(registry).toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:@scope/tools',
    });
    expect(alias).toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:@scope/tools',
    });
  });
});

describe('npm lock fingerprinting', () => {
  it('hashes the direct package lock entry and reachable dependency entries deterministically', async () => {
    const managedProjectRoot = await tmpRoot();
    await writeLockfile(managedProjectRoot, {
      toolVersion: '1.0.0',
      dependencyVersion: '1.0.0',
    });

    const first = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });
    const second = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toBe(first.value);

    const before = first.value;
    const lockfilePath = path.join(managedProjectRoot, 'package-lock.json');
    const raw = await readFile(lockfilePath, 'utf8');
    await writeFile(lockfilePath, raw.replace('"version": "1.0.0"', '"version": "1.0.1"'));

    const changed = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });

    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value).not.toBe(before);
  });

  it('follows optional dependency entries and ignores unreachable package entries', async () => {
    const managedProjectRoot = await tmpRoot();
    await writeFile(
      path.join(managedProjectRoot, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'aharness-managed-fsm-packages',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: {
                '@scope/tools': 'file:tools-1.0.0',
              },
            },
            'node_modules/@scope/tools': {
              version: '1.0.0',
              resolved: 'file:tools-1.0.0',
              optionalDependencies: {
                'optional-helper': '^1.0.0',
              },
            },
            'node_modules/optional-helper': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/optional-helper/-/optional-helper-1.0.0.tgz',
              integrity: 'sha512-one',
            },
            'node_modules/unreachable': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/unreachable/-/unreachable-1.0.0.tgz',
            },
          },
        },
        null,
        2,
      ) + '\n',
    );
    const first = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await writeFile(
      path.join(managedProjectRoot, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'aharness-managed-fsm-packages',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: {
                '@scope/tools': 'file:tools-1.0.0',
              },
            },
            'node_modules/@scope/tools': {
              version: '1.0.0',
              resolved: 'file:tools-1.0.0',
              optionalDependencies: {
                'optional-helper': '^1.0.0',
              },
            },
            'node_modules/optional-helper': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/optional-helper/-/optional-helper-1.0.0.tgz',
              integrity: 'sha512-two',
            },
            'node_modules/unreachable': {
              version: '2.0.0',
              resolved: 'https://registry.npmjs.org/unreachable/-/unreachable-2.0.0.tgz',
            },
          },
        },
        null,
        2,
      ) + '\n',
    );
    const changedReachable = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });
    expect(changedReachable.ok).toBe(true);
    if (changedReachable.ok) expect(changedReachable.value).not.toBe(first.value);

    await writeFile(
      path.join(managedProjectRoot, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'aharness-managed-fsm-packages',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: {
                '@scope/tools': 'file:tools-1.0.0',
              },
            },
            'node_modules/@scope/tools': {
              version: '1.0.0',
              resolved: 'file:tools-1.0.0',
              optionalDependencies: {
                'optional-helper': '^1.0.0',
              },
            },
            'node_modules/optional-helper': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/optional-helper/-/optional-helper-1.0.0.tgz',
              integrity: 'sha512-one',
            },
            'node_modules/unreachable': {
              version: '3.0.0',
              resolved: 'https://registry.npmjs.org/unreachable/-/unreachable-3.0.0.tgz',
            },
          },
        },
        null,
        2,
      ) + '\n',
    );
    const changedUnreachable = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });
    expect(changedUnreachable.ok).toBe(true);
    if (changedUnreachable.ok) expect(changedUnreachable.value).toBe(first.value);
  });

  it('resolves dependencies from ancestor package node_modules entries', async () => {
    const managedProjectRoot = await tmpRoot();
    await writeFile(
      path.join(managedProjectRoot, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'aharness-managed-fsm-packages',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: {
                '@scope/tools': 'file:tools-1.0.0',
              },
            },
            'node_modules/@scope/tools': {
              version: '1.0.0',
              resolved: 'file:tools-1.0.0',
              dependencies: {
                'parent-helper': '^1.0.0',
              },
            },
            'node_modules/@scope/tools/node_modules/parent-helper': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/parent-helper/-/parent-helper-1.0.0.tgz',
              dependencies: {
                'child-helper': '^1.0.0',
              },
            },
            'node_modules/@scope/tools/node_modules/parent-helper/node_modules/child-helper': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/child-helper/-/child-helper-1.0.0.tgz',
              dependencies: {
                'sibling-helper': '^1.0.0',
              },
            },
            'node_modules/@scope/tools/node_modules/parent-helper/node_modules/sibling-helper': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/sibling-helper/-/sibling-helper-1.0.0.tgz',
              integrity: 'sha512-sibling',
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const fingerprint = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
      packageVersion: '1.0.0',
    });

    if (!fingerprint.ok) {
      expect(fingerprint.diagnostics).toEqual([]);
      return;
    }
    expect(fingerprint.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes resolved git commit data in the fingerprint but not source intent', async () => {
    const cwd = await tmpRoot();
    const firstRoot = await tmpRoot();
    const secondRoot = await tmpRoot();
    await writeGitLockfile(firstRoot, 'abc123');
    await writeGitLockfile(secondRoot, 'def456');

    const sourceMain = await computeSourceIntentKey({ source: 'owner/repo#main', cwd });
    const sourceTag = await computeSourceIntentKey({ source: 'github:owner/repo#v1', cwd });
    expect(sourceMain).toEqual({
      ok: true,
      value: 'git:https://github.com/owner/repo',
    });
    expect(sourceTag).toEqual(sourceMain);

    const first = await computeLockFingerprint({
      managedProjectRoot: firstRoot,
      dependencyKey: 'repo',
      packageName: 'repo',
      packageVersion: '1.0.0',
    });
    const second = await computeLockFingerprint({
      managedProjectRoot: secondRoot,
      dependencyKey: 'repo',
      packageName: 'repo',
      packageVersion: '1.0.0',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value).not.toBe(first.value);
  });

  it('includes resolved local git commit data in the fingerprint but not source intent', async () => {
    const cwd = await tmpRoot();
    const repoRoot = path.join(cwd, 'repo');
    const repoUrl = pathToFileURL(repoRoot).href;
    const firstRoot = await tmpRoot();
    const secondRoot = await tmpRoot();
    await writeLocalGitLockfile(firstRoot, repoUrl, 'abc123');
    await writeLocalGitLockfile(secondRoot, repoUrl, 'def456');

    const sourceMain = await computeSourceIntentKey({ source: `git+${repoUrl}#main`, cwd });
    const sourceFeature = await computeSourceIntentKey({ source: `git+${repoUrl}#feature`, cwd });
    expect(sourceMain).toEqual({
      ok: true,
      value: `git:${repoUrl}`,
    });
    expect(sourceFeature).toEqual(sourceMain);

    const first = await computeLockFingerprint({
      managedProjectRoot: firstRoot,
      dependencyKey: 'local-git-tools',
      packageName: 'local-git-tools',
      packageVersion: '1.0.0',
    });
    const second = await computeLockFingerprint({
      managedProjectRoot: secondRoot,
      dependencyKey: 'local-git-tools',
      packageName: 'local-git-tools',
      packageVersion: '1.0.0',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value).not.toBe(first.value);
  });

  it('rejects direct link entries because local directory installs must be snapshots', async () => {
    const managedProjectRoot = await tmpRoot();
    await writeFile(
      path.join(managedProjectRoot, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'aharness-managed-fsm-packages',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: {
                '@scope/tools': 'file:../tools',
              },
            },
            'node_modules/@scope/tools': {
              link: true,
              resolved: '../tools',
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const result = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'lockfile-direct-entry-linked',
          field: 'packages.node_modules/@scope/tools.link',
        }),
      ]);
    }
  });

  it('rejects unsupported or incomplete lockfile shapes with diagnostics', async () => {
    const managedProjectRoot = await tmpRoot();
    await writeFile(path.join(managedProjectRoot, 'package-lock.json'), '{"lockfileVersion":1}\n');

    const legacy = await computeLockFingerprint({
      managedProjectRoot,
      dependencyKey: '@scope/tools',
      packageName: '@scope/tools',
    });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) {
      expect(legacy.diagnostics).toEqual([
        expect.objectContaining({ code: 'lockfile-packages-missing' }),
      ]);
    }
  });
});

async function writeLockfile(
  managedProjectRoot: string,
  opts: { readonly toolVersion: string; readonly dependencyVersion: string },
): Promise<void> {
  await writeFile(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        lockfileVersion: 3,
        packages: {
          '': {
            dependencies: {
              '@scope/tools': `file:tools-${opts.toolVersion}`,
            },
          },
          'node_modules/@scope/tools': {
            version: opts.toolVersion,
            resolved: `file:tools-${opts.toolVersion}`,
            dependencies: {
              'helper-lib': '^1.0.0',
            },
          },
          'node_modules/helper-lib': {
            version: opts.dependencyVersion,
            resolved: `https://registry.npmjs.org/helper-lib/-/helper-lib-${opts.dependencyVersion}.tgz`,
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

async function writeGitLockfile(managedProjectRoot: string, commit: string): Promise<void> {
  await writeFile(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        lockfileVersion: 3,
        packages: {
          '': {
            dependencies: {
              repo: 'github:owner/repo#main',
            },
          },
          'node_modules/repo': {
            version: '1.0.0',
            resolved: `git+ssh://git@github.com/owner/repo.git#${commit}`,
            integrity: `sha512-${commit}`,
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

async function writeLocalGitLockfile(
  managedProjectRoot: string,
  repoUrl: string,
  commit: string,
): Promise<void> {
  await writeFile(
    path.join(managedProjectRoot, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'aharness-managed-fsm-packages',
        lockfileVersion: 3,
        packages: {
          '': {
            dependencies: {
              'local-git-tools': `git+${repoUrl}#main`,
            },
          },
          'node_modules/local-git-tools': {
            version: '1.0.0',
            resolved: `git+${repoUrl}#${commit}`,
            integrity: `sha512-${commit}`,
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
}
