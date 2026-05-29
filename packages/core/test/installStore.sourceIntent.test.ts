import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeSourceIntentKey } from '../src/installStore/index.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'aharness-install-source-intent-'));
}

describe('install source intent normalization', () => {
  it('normalizes registry specs by registry origin and package name', async () => {
    const cwd = await tmpRoot();

    await expect(computeSourceIntentKey({ source: 'tools', cwd })).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:tools',
    });
    await expect(computeSourceIntentKey({ source: 'tools@latest', cwd })).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:tools',
    });
    await expect(computeSourceIntentKey({ source: 'tools@1.2.3', cwd })).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:tools',
    });
    await expect(computeSourceIntentKey({ source: 'tools@^1.0.0', cwd })).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:tools',
    });
    await expect(computeSourceIntentKey({ source: '@scope/tools', cwd })).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:@scope/tools',
    });
    await expect(computeSourceIntentKey({ source: '@scope/tools@beta', cwd })).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:@scope/tools',
    });
  });

  it('normalizes npm aliases by target package identity instead of alias key', async () => {
    const cwd = await tmpRoot();

    await expect(
      computeSourceIntentKey({ source: 'tools@npm:@scope/tools@latest', cwd }),
    ).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:@scope/tools',
    });
    await expect(
      computeSourceIntentKey({ source: 'tools2@npm:@scope/tools@^2', cwd }),
    ).resolves.toEqual({
      ok: true,
      value: 'registry:https://registry.npmjs.org/:@scope/tools',
    });
  });

  it('normalizes github shorthand and git URLs by canonical repository identity', async () => {
    const cwd = await tmpRoot();

    for (const source of [
      'owner/repo#main',
      'github:owner/repo#v1',
      'git+https://github.com/owner/repo.git#abc123',
      'git+ssh://git@github.com/owner/repo.git#semver:^1',
    ]) {
      await expect(computeSourceIntentKey({ source, cwd })).resolves.toEqual({
        ok: true,
        value: 'git:https://github.com/owner/repo',
      });
    }
  });

  it('normalizes local directories and local tarballs by realpath', async () => {
    const cwd = await tmpRoot();
    const localPackage = path.join(cwd, 'pkg');
    const tarballs = ['pkg.tgz', 'pkg.tar.gz', 'pkg.tar'];
    await mkdir(localPackage, { recursive: true });
    await writeFile(path.join(localPackage, 'package.json'), '{"name":"local"}\n');
    for (const tarball of tarballs) {
      await writeFile(path.join(cwd, tarball), 'tarball');
    }

    await expect(computeSourceIntentKey({ source: './pkg', cwd })).resolves.toEqual({
      ok: true,
      value: `local-directory:${await realpath(localPackage)}`,
    });

    for (const tarball of tarballs) {
      await expect(computeSourceIntentKey({ source: `./${tarball}`, cwd })).resolves.toEqual({
        ok: true,
        value: `local-tarball:${await realpath(path.join(cwd, tarball))}`,
      });
    }
    await expect(
      computeSourceIntentKey({ source: `file://${path.join(cwd, 'pkg.tgz')}`, cwd }),
    ).resolves.toEqual({
      ok: true,
      value: `local-tarball:${await realpath(path.join(cwd, 'pkg.tgz'))}`,
    });
  });

  it('strips credentials and transient auth query fields from remote tarball keys', async () => {
    const cwd = await tmpRoot();

    const first = await computeSourceIntentKey({
      source:
        'https://user:secret@example.com/packages/tools.tgz?_authToken=secret-token&cache=keep',
      cwd,
    });
    const second = await computeSourceIntentKey({
      source: 'https://user:changed@example.com/packages/tools.tgz?_authToken=changed&cache=keep',
      cwd,
    });

    expect(first).toEqual({
      ok: true,
      value: 'remote-tarball:https://example.com/packages/tools.tgz?cache=keep',
    });
    expect(second).toEqual(first);
    if (first.ok) {
      expect(first.value).not.toContain('secret');
      expect(first.value).not.toContain('secret-token');
    }
  });

  it('returns diagnostics for unsupported or malformed sources', async () => {
    const cwd = await tmpRoot();

    const result = await computeSourceIntentKey({ source: '::::', cwd });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'source-intent-unsupported',
        }),
      ]);
    }
  });
});
