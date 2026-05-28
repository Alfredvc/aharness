import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runPackageCli } from '../src/cli/packageCli.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fsm-package',
  'integration',
);

const tempRoots: string[] = [];

interface GeneratedBinResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
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

async function linkWorkspaceCorePackage(packageRoot: string): Promise<void> {
  ensureWorkspaceCoreBuild();
  const scopeDir = path.join(packageRoot, 'node_modules', '@aharness');
  await mkdir(scopeDir, { recursive: true });
  await symlink(
    path.join(repoRoot, 'packages', 'core'),
    path.join(scopeDir, 'core'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function ensureWorkspaceCoreBuild(): void {
  const packageRunnerDist = path.join(repoRoot, 'packages', 'core', 'dist', 'package-runner.js');
  if (existsSync(packageRunnerDist)) return;

  const result = spawnSync(
    'pnpm',
    ['--dir', path.join(repoRoot, 'packages', 'core'), 'run', 'build'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

function runGeneratedBin(
  binPath: string,
  argv: ReadonlyArray<string>,
  cwd: string,
): GeneratedBinResult {
  const result = spawnSync(process.execPath, [binPath, ...argv], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8'),
    stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf8'),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('generated FSM package bin', () => {
  it('builds through the package CLI and executes list and verify with node', async () => {
    const packageRoot = tmpRoot('aharness-package-runner-integration-');
    const callerRoot = tmpRoot('aharness-package-runner-caller-');
    await cp(fixtureRoot, packageRoot, { recursive: true });

    const init = await runPackage(packageRoot, [
      'init',
      '--name',
      'integration-fsms',
      '--bin',
      'integration-fsms',
    ]);
    expect(init.exitCode, init.stderr).toBe(0);

    const build = await runPackage(packageRoot, ['build']);
    expect(build.exitCode, build.stderr).toBe(0);
    expect(build.stdout).toContain('aharness package build: wrote');

    const binPath = path.join(packageRoot, 'bin', 'integration-fsms.mjs');
    expect(existsSync(binPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(binPath).mode & 0o111).not.toBe(0);
    }

    await linkWorkspaceCorePackage(packageRoot);

    const list = runGeneratedBin(binPath, ['list'], callerRoot);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toBe('hello\n');

    const verify = runGeneratedBin(binPath, ['verify'], callerRoot);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stderr).toContain('[hello] verify: ok');
  });
});
