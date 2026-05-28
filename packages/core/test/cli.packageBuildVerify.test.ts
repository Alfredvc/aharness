import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runPackageCli } from '../src/cli/packageCli.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fsm-package',
);

function tmpPackage(): string {
  return mkdtempSync(path.join(tmpdir(), 'aharness-package-build-verify-'));
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

async function runPackage(
  cwd: string,
  argv: ReadonlyArray<string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = captureStream();
  const stderr = captureStream();
  const result = await runPackageCli({
    argv,
    cwd,
    stdout: stdout.stream,
    stderr: stderr.stream,
    aharnessCoreVersion: '1.2.3',
  });
  return { exitCode: result.exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function packageJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'example-fsms',
    bin: {
      'example-fsms': './bin/example-fsms.mjs',
    },
    files: ['bin', 'fsms', 'skills'],
    dependencies: {
      '@aharness/core': '^0.1.0',
    },
    aharness: {
      package: {
        bin: 'example-fsms',
        fsmsDir: 'fsms',
      },
    },
    ...overrides,
  };
}

function writePackageJson(root: string, body: Record<string, unknown>): void {
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(body, null, 2)}\n`);
}

async function copyFixture(root: string, name: string): Promise<void> {
  await cp(path.join(fixtureRoot, name), root, { recursive: true });
}

describe('aharness package verify', () => {
  it('validates and verifies a package without requiring an on-disk generated bin', async () => {
    const root = tmpPackage();
    await copyFixture(root, 'minimal');
    const pkg = packageJson();
    writePackageJson(root, pkg);

    const result = await runPackage(root, ['verify']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('aharness package verify: ok (1 FSM)');
    expect(result.stderr).toContain('[hello] verify: ok');
    expect(existsSync(path.join(root, 'bin', 'example-fsms.mjs'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toEqual(pkg);
  });

  it('rejects command-specific authoring verify form', async () => {
    const root = tmpPackage();
    await copyFixture(root, 'minimal');
    writePackageJson(root, packageJson());

    const result = await runPackage(root, ['verify', 'hello']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('aharness package verify');
  });

  it('preserves verifier failure exit status for invalid FSMs', async () => {
    const root = tmpPackage();
    await mkdir(path.join(root, 'fsms'), { recursive: true });
    await writeFile(
      path.join(root, 'fsms', 'stuck.fsm.ts'),
      `
        import { aharness, passive, terminal } from '@aharness/core';
        export const machine = aharness.machine({
          id: 'stuck',
          initial: 'stuck',
          context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
          states: {
            stuck: passive(),
            done: terminal('success'),
          },
        });
        export default machine;
      `,
    );
    writePackageJson(root, packageJson());

    const result = await runPackage(root, ['verify']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('[stuck]');
    expect(result.stderr).toContain('no-black-hole-non-terminals');
  });

  it('returns exit code 2 for package configuration failures', async () => {
    const root = tmpPackage();
    await copyFixture(root, 'minimal');
    writePackageJson(
      root,
      packageJson({
        dependencies: {},
      }),
    );

    const result = await runPackage(root, ['verify']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('dependencies.@aharness/core');
  });

  it('reports missing bundled skills before empty package commands', async () => {
    const root = tmpPackage();
    await mkdir(path.join(root, 'fsms'), { recursive: true });
    writePackageJson(
      root,
      packageJson({
        files: ['bin', 'fsms'],
      }),
    );

    const result = await runPackage(root, ['verify']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('[files-missing-entry]');
    expect(result.stderr).not.toContain('[commands-missing]');
  });
});

describe('aharness package build', () => {
  it('verifies, renders, writes the configured bin, and marks it executable on POSIX', async () => {
    const root = tmpPackage();
    await copyFixture(root, 'minimal');
    writePackageJson(
      root,
      packageJson({
        bin: {
          'example-fsms': './dist/bin/example-fsms.mjs',
        },
        files: ['dist', 'fsms', 'skills'],
      }),
    );

    const result = await runPackage(root, ['build']);

    const binPath = path.join(root, 'dist', 'bin', 'example-fsms.mjs');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('aharness package build: wrote');
    const body = await readFile(binPath, 'utf8');
    expect(body).toContain('packageRootUrl: new URL("../../", import.meta.url)');
    expect(body).toContain('@aharness/core/package-runner');
    if (process.platform !== 'win32') {
      expect(statSync(binPath).mode & 0o111).not.toBe(0);
    }
  });

  it('leaves an existing generated bin unchanged when validation fails', async () => {
    const root = tmpPackage();
    await copyFixture(root, 'helpers-outside');
    writePackageJson(root, packageJson());
    const binPath = path.join(root, 'bin', 'example-fsms.mjs');
    await mkdir(path.dirname(binPath), { recursive: true });
    await writeFile(binPath, 'old generated bin\n');

    const result = await runPackage(root, ['build']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('source-import-outside-fsms-dir');
    expect(await readFile(binPath, 'utf8')).toBe('old generated bin\n');
  });

  it('rejects missing publish entries for bundled skills', async () => {
    const root = tmpPackage();
    await copyFixture(root, 'minimal');
    writePackageJson(
      root,
      packageJson({
        files: ['bin', 'fsms'],
      }),
    );

    const result = await runPackage(root, ['build']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('skills');
  });
});
