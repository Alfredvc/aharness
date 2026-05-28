import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deriveDefaultBinName,
  readPackageJson,
  validatePackageConfig,
} from '../src/fsmPackage/config.js';

async function tmpPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'aharness-fsm-package-config-'));
}

function validPackageJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@aharness/superpowers',
    bin: {
      'ah-superpowers': './bin/ah-superpowers.mjs',
    },
    files: ['bin', 'fsms', 'skills'],
    dependencies: {
      '@aharness/core': '^0.1.0',
    },
    aharness: {
      package: {
        bin: 'ah-superpowers',
        fsmsDir: 'fsms',
      },
    },
    ...overrides,
  };
}

describe('fsm package config', () => {
  it('reads package.json while preserving unrelated fields', async () => {
    const root = await tmpPackage();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: '@aharness/superpowers',
          description: 'keep me',
          private: true,
          dependencies: { '@aharness/core': '^0.1.0' },
        },
        null,
        2,
      ),
    );

    const read = await readPackageJson(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.packageJson['description']).toBe('keep me');
    expect(read.value.packageJson['private']).toBe(true);
  });

  it('reports invalid package.json syntax when reading package metadata', async () => {
    const root = await tmpPackage();
    const packageJsonPath = path.join(root, 'package.json');
    await writeFile(packageJsonPath, '{ nope');

    const read = await readPackageJson(root);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.diagnostics).toHaveLength(1);
    expect(read.diagnostics[0]).toMatchObject({
      code: 'package-json-invalid',
      path: packageJsonPath,
    });
    expect(read.diagnostics[0]?.message).toContain('package.json is not valid JSON:');
  });

  it('reports non-object package.json bodies when reading package metadata', async () => {
    const root = await tmpPackage();
    const packageJsonPath = path.join(root, 'package.json');
    await writeFile(packageJsonPath, '[]');

    const read = await readPackageJson(root);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.diagnostics).toEqual([
      {
        code: 'package-json-invalid',
        path: packageJsonPath,
        message: 'package.json must contain an object',
      },
    ]);
  });

  it('derives default bin names from package names', () => {
    expect(deriveDefaultBinName('@aharness/superpowers')).toBe('ah-superpowers');
    expect(deriveDefaultBinName('@example/workflows')).toBe('workflows');
    expect(deriveDefaultBinName('workflow-pack')).toBe('workflow-pack');
  });

  it('accepts valid package metadata', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.binName).toBe('ah-superpowers');
      expect(result.value.binPath).toBe(path.resolve('/repo/package/bin/ah-superpowers.mjs'));
      expect(result.value.fsmsDirPath).toBe(path.resolve('/repo/package/fsms'));
    }
  });

  it('rejects missing or malformed aharness.package metadata', () => {
    const missing = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({ aharness: undefined }),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.diagnostics.map((d) => d.code)).toContain('aharness-package-missing');

    const malformed = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({ aharness: { package: { bin: 42, fsmsDir: 'fsms' } } }),
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.diagnostics.map((d) => d.code)).toContain('bin-invalid');
  });

  it('rejects official packages with non-standard bin names', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({
        bin: { superpowers: './bin/superpowers.mjs' },
        aharness: { package: { bin: 'superpowers', fsmsDir: 'fsms' } },
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('official-bin-invalid');
  });

  it('rejects bin values that do not describe exactly one configured binary', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({
        bin: {
          'ah-superpowers': './bin/ah-superpowers.mjs',
          extra: './bin/extra.mjs',
        },
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.code)).toContain('bin-entry-count-invalid');
  });

  it('rejects generated bin targets without an .mjs extension', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({
        bin: { 'ah-superpowers': './bin/ah-superpowers.js' },
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.code)).toContain('bin-entry-target-extension-invalid');
  });

  it('accepts package files entries that include the exact generated bin file', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({
        files: ['bin/ah-superpowers.mjs', 'fsms', 'skills'],
      }),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects invalid files metadata and missing @aharness/core dependency', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({
        files: ['bin'],
        dependencies: {},
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain('files-missing-entry');
      expect(codes).toContain('dependency-missing');
    }
  });

  it('rejects unsupported fsmsDir values', () => {
    const result = validatePackageConfig({
      packageRoot: '/repo/package',
      packageJson: validPackageJson({
        aharness: { package: { bin: 'ah-superpowers', fsmsDir: '../fsms' } },
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('path-parent-segment');
  });
});
