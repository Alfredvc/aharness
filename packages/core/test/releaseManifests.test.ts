import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCorePackageReadme,
  findRootRelativeMarkdownLinks,
} from '../../../scripts/sync-package-readmes.mjs';
import { findStaleDistArtifacts } from '../../../scripts/verify-no-stale-dist.mjs';
import { verifyPackedManifest } from '../../../scripts/verify-release-manifests.mjs';

const root = process.cwd();
const publishablePackageDirs = ['packages/core', 'packages/test-support'];
const retiredVizPackageName = ['aharness', 'viz'].join('-');
const retiredVizPackageDir = `packages/${retiredVizPackageName}`;
const tempDirs: string[] = [];
const staleDistArtifacts = [
  'packages/core/dist/daemon',
  'packages/core/dist/mcp',
  'packages/core/dist/cli/daemonInternal.js',
  'packages/core/dist/cli/daemonInternal.d.ts',
  'packages/core/dist/cli/shutdownSequence.js',
  'packages/core/dist/cli/shutdownSequence.d.ts',
  'packages/core/dist/package-runner.js',
  'packages/core/dist/package-runner.d.ts',
  'packages/core/dist/cli/packageCli.js',
  'packages/core/dist/cli/packageCli.d.ts',
  'packages/core/dist/fsmPackage',
];

function readPackageJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function readPackageScripts(path: string): Record<string, string> {
  const pkg = readPackageJson(path);
  return pkg.scripts as Record<string, string>;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFixtureFile(baseDir: string, relativePath: string, body: string): void {
  const fullPath = join(baseDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

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
    const fixtureRoot = makeTempDir('aharness-stale-dist-');
    for (const artifactPath of staleDistArtifacts) {
      writeFixtureFile(fixtureRoot, artifactPath, 'stale release artifact\n');
    }

    expect(findStaleDistArtifacts(fixtureRoot)).toEqual(staleDistArtifacts);
  });

  it('release pack verification rejects source trees and build-info files', () => {
    const packageDir = makeTempDir('aharness-pack-fixture-');
    const packDestination = makeTempDir('aharness-pack-destination-');
    writeFixtureFile(
      packageDir,
      'package.json',
      JSON.stringify(
        {
          name: 'release-pack-fixture',
          version: '1.0.0',
          files: ['dist', 'src', 'tsconfig.tsbuildinfo'],
        },
        null,
        2,
      ) + '\n',
    );
    writeFixtureFile(packageDir, 'dist/index.js', 'export {};\n');
    writeFixtureFile(packageDir, 'src/index.ts', 'export {};\n');
    writeFixtureFile(packageDir, 'tsconfig.tsbuildinfo', '{}\n');

    let error: unknown;
    try {
      verifyPackedManifest(packageDir, packDestination);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('packed tarball contains non-release artifacts');
    expect((error as Error).message).toContain('package/src/index.ts');
    expect((error as Error).message).toContain('package/tsconfig.tsbuildinfo');
  });

  it('root verify wires UI typecheck and Codex drift checks', () => {
    const scripts = readPackageScripts('.');

    expect(scripts.release).toBe('pnpm run verify && commit-and-tag-version');
    expect(scripts['release:preview']).toBe('commit-and-tag-version --dry-run');
    expect(scripts['sync:release-versions']).toBe('node scripts/sync-release-versions.mjs');
    expect(scripts['sync:package-readmes']).toBe('node scripts/sync-package-readmes.mjs');
    expect(scripts['check:package-readmes']).toBe('node scripts/sync-package-readmes.mjs --check');
    expect(scripts.verify).toContain('pnpm run check:package-readmes');
    expect(scripts.verify).toContain('packages/web-ui run typecheck');
    expect(scripts.verify).toContain('packages/core run verify:codex-bump');
    expect(scripts.build).not.toContain(`${retiredVizPackageDir} build`);
    expect(scripts['verify:release']).toContain('scripts/verify-release-manifests.mjs');
  });

  it('release generator bumps package versions and public core dependency ranges', () => {
    const pkg = readPackageJson('.');
    const versionrc = JSON.parse(readFileSync(join(root, '.versionrc.json'), 'utf8')) as {
      readonly bumpFiles: readonly (
        | string
        | { readonly filename?: string; readonly updater?: string; readonly type?: string }
      )[];
      readonly commitUrlFormat: string;
      readonly compareUrlFormat: string;
      readonly releaseCommitMessageFormat: string;
    };
    const bumpFiles = versionrc.bumpFiles.map((entry) =>
      typeof entry === 'string' ? entry : entry.filename,
    );

    expect(pkg.devDependencies).toHaveProperty('commit-and-tag-version');
    expect(versionrc.releaseCommitMessageFormat).toBe('chore(release): {{currentTag}}');
    expect(versionrc.commitUrlFormat).toBe('https://github.com/Alfredvc/aharness/commit/{{hash}}');
    expect(versionrc.compareUrlFormat).toBe(
      'https://github.com/Alfredvc/aharness/compare/{{previousTag}}...{{currentTag}}',
    );
    expect(bumpFiles).toEqual(
      expect.arrayContaining([
        'package.json',
        'packages/core/package.json',
        'packages/test-support/package.json',
        'packages/core/templates/package.json.tmpl',
        'docs/fsm-packages.md',
        'skills/aharness-fsm-authoring/references/fsm-packages.md',
      ]),
    );
    for (const entry of versionrc.bumpFiles) {
      if (
        typeof entry !== 'string' &&
        ['packages/core/templates/package.json.tmpl', 'docs/fsm-packages.md'].includes(
          entry.filename ?? '',
        )
      ) {
        expect(entry.updater).toBe('./scripts/aharness-core-range-updater.cjs');
      }
    }
  });

  it('build scripts regenerate package READMEs before packaging artifacts', () => {
    const rootScripts = readPackageScripts('.');
    const coreScripts = readPackageScripts('packages/core');

    expect(rootScripts.build).toContain('pnpm run sync:package-readmes');
    expect(coreScripts.build).toContain('pnpm --dir ../.. run sync:package-readmes');
  });

  it('documents package-level READMEs for publishable packages', () => {
    for (const packageDir of publishablePackageDirs) {
      expect(existsSync(join(root, packageDir, 'README.md'))).toBe(true);
    }
  });

  it('@aharness/core package README mirrors the root npm-facing README', () => {
    const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
    const coreReadme = readFileSync(join(root, 'packages/core/README.md'), 'utf8');

    expect(coreReadme).toBe(buildCorePackageReadme(rootReadme));
    expect(findRootRelativeMarkdownLinks(coreReadme)).toEqual([]);
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
