#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PUBLISHABLE_PACKAGES,
  ROOT,
  isRealSemver,
  packageJsonPath,
  readJson,
} from './release-helpers.mjs';

const REQUIRED_FIELDS = ['license', 'repository', 'description', 'main', 'types', 'files'];
const WORKSPACE_SPEC = /^workspace:(?:\*|\^|~)/;

export function verifyReleaseManifests() {
  const errors = [];
  const rootPkg = readJson(join(ROOT, 'package.json'));
  if (!isRealSemver(rootPkg.version)) {
    errors.push(
      `root package.json version must be a real release SemVer before publishing; got ${JSON.stringify(rootPkg.version)}`,
    );
  }

  for (const packageDir of PUBLISHABLE_PACKAGES) {
    const pkg = readJson(packageJsonPath(packageDir));
    if (!isRealSemver(pkg.version)) {
      errors.push(
        `${pkg.name} version must be a real release SemVer; got ${JSON.stringify(pkg.version)}`,
      );
    }
    if (pkg.version !== rootPkg.version) {
      errors.push(
        `${pkg.name} version ${pkg.version} does not match root version ${rootPkg.version}`,
      );
    }
    if (pkg.private === true) {
      errors.push(`${pkg.name} must not be private`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (pkg[field] === undefined) {
        errors.push(`${pkg.name} missing required package field: ${field}`);
      }
    }
    if (pkg.license !== rootPkg.license) {
      errors.push(
        `${pkg.name} license ${pkg.license} does not match root license ${rootPkg.license}`,
      );
    }
    if (pkg.name === '@aharness/core') {
      for (const dep of ['esbuild', 'typescript']) {
        if (pkg.dependencies?.[dep] === undefined) {
          errors.push(`@aharness/core dependencies must include runtime import ${dep}`);
        }
      }
    }
  }

  return errors;
}

function verifyPackedManifest(packageDir, packDestination) {
  const stdout = execFileSync(
    'pnpm',
    ['--dir', packageDir, 'pack', '--pack-destination', packDestination, '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const parsed = JSON.parse(stdout);
  const tarball = Array.isArray(parsed)
    ? (parsed[0]?.filename ?? parsed[0]?.path)
    : (parsed.filename ?? parsed.path);
  if (typeof tarball !== 'string') {
    throw new Error(`could not determine packed tarball for ${packageDir}`);
  }
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  );
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  const bad = Object.entries(deps)
    .filter(([, spec]) => typeof spec === 'string' && WORKSPACE_SPEC.test(spec))
    .map(([name, spec]) => `${name}@${spec}`);
  if (bad.length > 0) {
    throw new Error(`${manifest.name} packed manifest contains workspace specs: ${bad.join(', ')}`);
  }

  const entries = execFileSync('tar', ['-tf', tarball], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const forbiddenEntries = entries.filter(
    (entry) => entry.startsWith('package/src/') || entry.endsWith('.tsbuildinfo'),
  );
  if (forbiddenEntries.length > 0) {
    throw new Error(
      `${manifest.name} packed tarball contains non-release artifacts: ${forbiddenEntries.join(', ')}`,
    );
  }
}

function assertCleanWorktree(stage) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (status.trim().length > 0) {
    throw new Error(`worktree is dirty ${stage}:\n${status}`);
  }
}

function runReleaseGate() {
  const errors = verifyReleaseManifests();
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  assertCleanWorktree('before release verification');
  execFileSync('pnpm', ['run', 'verify'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('pnpm', ['run', 'clean'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('pnpm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('node', ['scripts/verify-no-stale-dist.mjs'], { cwd: ROOT, stdio: 'inherit' });

  const packDestination = mkdtempSync(join(tmpdir(), 'harness-pack-'));
  try {
    for (const packageDir of PUBLISHABLE_PACKAGES) {
      verifyPackedManifest(packageDir, packDestination);
    }
  } finally {
    rmSync(packDestination, { recursive: true, force: true });
  }
  assertCleanWorktree('after release verification');
}

try {
  if (process.argv.includes('--release-gate')) {
    runReleaseGate();
  } else {
    const errors = verifyReleaseManifests();
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
} catch (error) {
  console.error(
    `verify-release-manifests: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
