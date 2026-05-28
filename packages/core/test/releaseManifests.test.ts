import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const publishablePackageDirs = ['packages/core', 'packages/test-support'];
const retiredVizPackageName = ['aharness', 'viz'].join('-');
const retiredVizPackageDir = `packages/${retiredVizPackageName}`;

function readPackageJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('release manifest readiness', () => {
  it('passes release manifest verification with real release versions', () => {
    const result = spawnSync('node', ['scripts/verify-release-manifests.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('publishable source manifests carry required release metadata', () => {
    const rootPkg = readPackageJson('.');
    for (const packageDir of publishablePackageDirs) {
      const pkg = readPackageJson(packageDir);
      expect(pkg.private).not.toBe(true);
      expect(pkg.license).toBe(rootPkg.license);
      expect(pkg.repository).toBeDefined();
      expect(pkg.description).toEqual(expect.any(String));
      expect(pkg.main).toEqual(expect.any(String));
      expect(pkg.types).toEqual(expect.any(String));
      expect(Array.isArray(pkg.files)).toBe(true);
    }
  });

  it('publishable package files include build outputs without source trees', () => {
    for (const packageDir of publishablePackageDirs) {
      const pkg = readPackageJson(packageDir);
      const files = pkg.files as string[];

      expect(files).toContain('dist');
      expect(files).not.toContain('src');
    }

    expect((readPackageJson('packages/core').files as string[]).sort()).toEqual([
      'dist',
      'scripts/codex-version-min.txt',
    ]);
  });

  it('@aharness/core declares runtime imports as dependencies', () => {
    const pkg = readPackageJson('packages/core');
    const deps = pkg.dependencies as Record<string, string>;

    expect(deps.esbuild).toEqual(expect.any(String));
    expect(deps.typescript).toEqual(expect.any(String));
  });

  it('release checks deny stale dist artifacts by name', () => {
    const script = readFileSync(join(root, 'scripts/verify-no-stale-dist.mjs'), 'utf8');

    expect(script).toContain('packages/core/dist/daemon');
    expect(script).toContain('packages/core/dist/mcp');
    expect(script).toContain('packages/core/dist/cli/daemonInternal.js');
    expect(script).toContain('packages/core/dist/cli/shutdownSequence.js');
  });

  it('release pack verification rejects source trees and build-info files', () => {
    const script = readFileSync(join(root, 'scripts/verify-release-manifests.mjs'), 'utf8');

    expect(script).toContain("entry.startsWith('package/src/')");
    expect(script).toContain("entry.endsWith('.tsbuildinfo')");
  });

  it('root verify wires UI typecheck and Codex drift checks', () => {
    const pkg = readPackageJson('.');
    const scripts = pkg.scripts as Record<string, string>;

    expect(scripts.verify).toContain('packages/web-ui run typecheck');
    expect(scripts.verify).toContain('packages/core run verify:codex-bump');
    expect(scripts.build).not.toContain(`${retiredVizPackageDir} build`);
    expect(scripts['verify:release']).toContain('scripts/verify-release-manifests.mjs');
  });

  it('documents package-level READMEs for publishable packages', () => {
    for (const packageDir of publishablePackageDirs) {
      expect(existsSync(join(root, packageDir, 'README.md'))).toBe(true);
    }
  });

  it('license file and package license fields are Apache-2.0', () => {
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Apache License');
    expect(readPackageJson('.').license).toBe('Apache-2.0');
    for (const packageDir of publishablePackageDirs) {
      expect(readPackageJson(packageDir).license).toBe('Apache-2.0');
    }
  });

  it('scaffolded package template dependencies match the root release version', () => {
    const rootPkg = readPackageJson('.');
    const template = readFileSync(join(root, 'packages/core/templates/package.json.tmpl'), 'utf8');

    expect(template).toContain(`"@aharness/core": "^${String(rootPkg.version)}"`);
    expect(template).not.toContain(`"${retiredVizPackageName}"`);
    expect(template).not.toContain('__AHARNESS_VERSION__');
  });
});
