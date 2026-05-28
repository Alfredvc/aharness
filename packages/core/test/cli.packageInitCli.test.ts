import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runPackageCli } from '../src/cli/packageCli.js';

function tmpPackage(): string {
  return mkdtempSync(path.join(tmpdir(), 'harness-package-init-'));
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

async function runInit(
  cwd: string,
  argv: ReadonlyArray<string>,
  harnessCoreVersion = '1.2.3',
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = captureStream();
  const stderr = captureStream();
  const result = await runPackageCli({
    argv: ['init', ...argv],
    cwd,
    stdout: stdout.stream,
    stderr: stderr.stream,
    harnessCoreVersion,
  });
  return { exitCode: result.exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function readPackageJson(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writePackageJson(root: string, packageJson: Record<string, unknown>): void {
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
}

describe('aharness package init', () => {
  it('requires --name when package.json is missing', async () => {
    const root = tmpPackage();

    const result = await runInit(root, []);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--name is required');
    expect(existsSync(path.join(root, 'package.json'))).toBe(false);
  });

  it('reports invalid package.json syntax without rewriting it', async () => {
    const root = tmpPackage();
    const packageJsonPath = path.join(root, 'package.json');
    writeFileSync(packageJsonPath, '{ nope');

    const result = await runInit(root, ['--name', 'broken-pack']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('package-json-invalid');
    expect(result.stderr).toContain(packageJsonPath);
    expect(result.stderr).toContain('package.json is not valid JSON:');
    expect(readFileSync(packageJsonPath, 'utf8')).toBe('{ nope');
  });

  it('reports non-object package.json bodies without rewriting them', async () => {
    const root = tmpPackage();
    const packageJsonPath = path.join(root, 'package.json');
    writeFileSync(packageJsonPath, '[]');

    const result = await runInit(root, ['--name', 'broken-pack']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('package-json-invalid');
    expect(result.stderr).toContain(packageJsonPath);
    expect(result.stderr).toContain('package.json must contain an object');
    expect(readFileSync(packageJsonPath, 'utf8')).toBe('[]');
  });

  it('creates package metadata and fsmsDir for a new official package', async () => {
    const root = tmpPackage();

    const result = await runInit(root, ['--name', '@aharness/superpowers']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('aharness package init: updated');
    expect(existsSync(path.join(root, 'fsms'))).toBe(true);
    const pkg = readPackageJson(root);
    expect(pkg['name']).toBe('@aharness/superpowers');
    expect(pkg['bin']).toEqual({
      'ah-superpowers': './bin/ah-superpowers.mjs',
    });
    expect(pkg['files']).toEqual(['bin', 'fsms', 'skills']);
    expect(pkg['scripts']).toEqual({
      prepack: 'aharness package build',
      'package:verify': 'aharness package verify',
    });
    expect(pkg['dependencies']).toEqual({
      '@aharness/core': '1.2.3',
    });
    expect(pkg['harness']).toEqual({
      package: {
        bin: 'ah-superpowers',
        fsmsDir: 'fsms',
      },
    });
    expect(pkg).not.toHaveProperty('type');
  });

  it('preserves unrelated fields while adding community package defaults', async () => {
    const root = tmpPackage();
    writePackageJson(root, {
      name: '@example/workflows',
      description: 'keep me',
      private: true,
      files: ['README.md'],
      scripts: {
        test: 'vitest run',
      },
      dependencies: {
        xstate: '^5.19.0',
      },
      harness: {
        package: {
          commands: {
            plan: { target: 'writing-plans' },
          },
        },
      },
    });

    const result = await runInit(root, []);

    expect(result.exitCode).toBe(0);
    const pkg = readPackageJson(root);
    expect(pkg['description']).toBe('keep me');
    expect(pkg['private']).toBe(true);
    expect(pkg['bin']).toEqual({
      workflows: './bin/workflows.mjs',
    });
    expect(pkg['files']).toEqual(['README.md', 'bin', 'fsms', 'skills']);
    expect(pkg['scripts']).toEqual({
      test: 'vitest run',
      prepack: 'aharness package build',
      'package:verify': 'aharness package verify',
    });
    expect(pkg['dependencies']).toEqual({
      xstate: '^5.19.0',
      '@aharness/core': '1.2.3',
    });
    expect(pkg['harness']).toEqual({
      package: {
        commands: {
          plan: { target: 'writing-plans' },
        },
        bin: 'workflows',
        fsmsDir: 'fsms',
      },
    });
  });

  it('honors explicit --bin and --fsms-dir values', async () => {
    const root = tmpPackage();

    const result = await runInit(root, [
      '--name',
      'workflow-pack',
      '--bin',
      'do-stuff',
      '--fsms-dir',
      'workflows',
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(root, 'workflows'))).toBe(true);
    const pkg = readPackageJson(root);
    expect(pkg['bin']).toEqual({
      'do-stuff': './bin/do-stuff.mjs',
    });
    expect(pkg['files']).toEqual(['bin', 'workflows', 'skills']);
    expect(pkg['harness']).toEqual({
      package: {
        bin: 'do-stuff',
        fsmsDir: 'workflows',
      },
    });
  });

  it('normalizes backslash-separated fsmsDir values before creating directories and metadata', async () => {
    const root = tmpPackage();

    const result = await runInit(root, [
      '--name',
      'workflow-pack',
      '--fsms-dir',
      'workflows\\nested',
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(root, 'workflows', 'nested'))).toBe(true);
    expect(existsSync(path.join(root, 'workflows\\nested'))).toBe(false);
    const pkg = readPackageJson(root);
    expect(pkg['files']).toEqual(['bin', 'workflows/nested', 'skills']);
    expect(pkg['harness']).toEqual({
      package: {
        bin: 'workflow-pack',
        fsmsDir: 'workflows/nested',
      },
    });
  });

  it('refuses conflicting bin entries without --force and replaces them with --force', async () => {
    const root = tmpPackage();
    const original = {
      name: 'workflow-pack',
      bin: {
        other: './bin/other.mjs',
        extra: './bin/extra.mjs',
      },
      files: ['bin'],
      scripts: {},
      dependencies: {},
    };
    writePackageJson(root, original);

    const failed = await runInit(root, []);

    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toContain('bin already contains');
    expect(readPackageJson(root)).toEqual(original);

    const forced = await runInit(root, ['--force']);

    expect(forced.exitCode).toBe(0);
    expect(readPackageJson(root)['bin']).toEqual({
      'workflow-pack': './bin/workflow-pack.mjs',
    });
  });

  it('reports malformed fields that cannot be merged', async () => {
    const root = tmpPackage();
    writePackageJson(root, {
      name: 'bad-fields',
      files: 'dist',
      scripts: [],
      dependencies: [],
      harness: [],
    });

    const result = await runInit(root, ['--force']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('files');
    expect(result.stderr).toContain('scripts');
    expect(result.stderr).toContain('dependencies');
    expect(result.stderr).toContain('harness');
  });

  it('rejects unsafe fsmsDir paths before writing package metadata or creating directories', async () => {
    const root = tmpPackage();

    const result = await runInit(root, ['--name', 'unsafe-pack', '--fsms-dir', '../escape']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('harness.package.fsmsDir');
    expect(existsSync(path.join(root, 'package.json'))).toBe(false);
    expect(existsSync(path.join(root, '..', 'escape'))).toBe(false);
  });

  it('prints package usage for unknown flags and missing values', async () => {
    const root = tmpPackage();
    const stdout = captureStream();
    const stderr = captureStream();

    const unknown = await runPackageCli({
      argv: ['init', '--unknown'],
      cwd: root,
      stdout: stdout.stream,
      stderr: stderr.stream,
      harnessCoreVersion: '1.2.3',
    });

    expect(unknown.exitCode).toBe(2);
    expect(stderr.text()).toContain('aharness package init');
    expect(stderr.text()).toContain('aharness package build');
    expect(stderr.text()).toContain('aharness package verify');

    const missingValue = await runPackageCli({
      argv: ['init', '--name'],
      cwd: root,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      harnessCoreVersion: '1.2.3',
    });

    expect(missingValue.exitCode).toBe(2);
  });

  it('uses the unpublished 0.0.0 fallback behavior from aharness init', async () => {
    const root = tmpPackage();

    const result = await runInit(root, ['--name', 'fallback-pack'], '0.0.0');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/0\.0\.0|unpublished|latest/i);
    const pkg = readPackageJson(root) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@aharness/core']).toBe('latest');
  });

  it('keeps package usage scoped to the package namespace', async () => {
    const root = tmpPackage();
    const stdout = captureStream();
    const stderr = captureStream();

    const result = await runPackageCli({
      argv: ['build'],
      cwd: root,
      stdout: stdout.stream,
      stderr: stderr.stream,
      harnessCoreVersion: '1.2.3',
    });

    expect(result.exitCode).toBe(2);
    expect(stderr.text()).toContain('aharness package init');
    expect(stderr.text()).toContain('aharness package build');
    expect(stderr.text()).toContain('aharness package verify');
  });
});
