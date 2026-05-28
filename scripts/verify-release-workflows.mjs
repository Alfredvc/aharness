#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './release-helpers.mjs';

const checks = [];

function requireFile(relativePath) {
  try {
    return readFileSync(join(ROOT, relativePath), 'utf8');
  } catch {
    checks.push(`${relativePath} is missing`);
    return '';
  }
}

function expectIncludes(relativePath, body, needle) {
  if (!body.includes(needle)) {
    checks.push(`${relativePath} must include ${JSON.stringify(needle)}`);
  }
}

function expectExcludes(relativePath, body, needle) {
  if (body.includes(needle)) {
    checks.push(`${relativePath} must not include ${JSON.stringify(needle)}`);
  }
}

const releasePath = '.github/workflows/release.yml';
const release = requireFile(releasePath);
if (release) {
  expectIncludes(releasePath, release, 'push:');
  if (!release.includes('tags: ["v*"]') && !release.includes("tags: ['v*']")) {
    checks.push(`${releasePath} must trigger on v* tags`);
  }
  expectIncludes(releasePath, release, 'pnpm run verify:release');
  expectIncludes(releasePath, release, 'packages/core');
  expectIncludes(releasePath, release, 'packages/test-support');
  expectIncludes(releasePath, release, 'npm publish');
  expectIncludes(releasePath, release, '--provenance --access public');
  expectIncludes(releasePath, release, 'id-token: write');
  expectExcludes(releasePath, release, 'packages/superpowers');
  expectExcludes(releasePath, release, '@aharness/superpowers');
}

const superpowersPath = '.github/workflows/release-superpowers.yml';
const superpowers = requireFile(superpowersPath);
if (superpowers) {
  expectIncludes(superpowersPath, superpowers, 'workflow_dispatch:');
  expectIncludes(superpowersPath, superpowers, 'packages/superpowers');
  expectIncludes(superpowersPath, superpowers, '@aharness/superpowers');
  expectIncludes(superpowersPath, superpowers, 'npm view "@aharness/core@$VERSION" version');
  expectIncludes(superpowersPath, superpowers, 'npm publish');
  expectIncludes(superpowersPath, superpowers, '--provenance --access public');
  expectIncludes(superpowersPath, superpowers, 'id-token: write');
  expectExcludes(superpowersPath, superpowers, 'push:');
  expectExcludes(superpowersPath, superpowers, 'tags: ["v*"]');
  expectExcludes(superpowersPath, superpowers, "tags: ['v*']");
}

if (checks.length > 0) {
  console.error(`verify-release-workflows: ${checks.join('\n')}`);
  process.exit(1);
}
