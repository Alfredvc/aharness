import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
    expect(registry).toEqual({ ok: true, value: 'registry:@scope/tools' });
    expect(alias).toEqual({ ok: true, value: 'registry:@scope/tools' });
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
