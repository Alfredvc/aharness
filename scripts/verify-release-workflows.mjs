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

function tryReadJson(relativePath) {
  const body = requireFile(relativePath);
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch (error) {
    checks.push(
      `${relativePath} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

const releasePath = '.github/workflows/release.yml';
const release = requireFile(releasePath);
if (release) {
  expectIncludes(releasePath, release, 'push:');
  if (!release.includes('tags: ["v*"]') && !release.includes("tags: ['v*']")) {
    checks.push(`${releasePath} must trigger on v* tags`);
  }
  expectIncludes(releasePath, release, 'PINNED_CODEX_COMMIT');
  expectIncludes(releasePath, release, 'https://github.com/openai/codex.git');
  expectIncludes(releasePath, release, 'CODEX_CHECKOUT');
  expectIncludes(releasePath, release, 'GITHUB_ENV');
  expectIncludes(releasePath, release, 'pnpm run verify:release');
  expectIncludes(releasePath, release, 'packages/core');
  expectIncludes(releasePath, release, 'packages/test-support');
  expectIncludes(releasePath, release, 'npm publish');
  expectIncludes(releasePath, release, '--provenance --access public');
  expectIncludes(releasePath, release, 'id-token: write');
}

const rootPkg = tryReadJson('package.json');
if (rootPkg) {
  const scripts = rootPkg.scripts ?? {};
  if (scripts.release !== 'pnpm run verify && commit-and-tag-version') {
    checks.push('package.json release script must run verify and commit-and-tag-version');
  }
  if (scripts['release:preview'] !== 'commit-and-tag-version --dry-run') {
    checks.push('package.json release:preview script must dry-run commit-and-tag-version');
  }
  if (scripts['sync:release-versions'] !== 'node scripts/sync-release-versions.mjs') {
    checks.push('package.json sync:release-versions script must run sync-release-versions.mjs');
  }
  if (rootPkg.devDependencies?.['commit-and-tag-version'] === undefined) {
    checks.push('package.json devDependencies must include commit-and-tag-version');
  }
}

const versionrc = tryReadJson('.versionrc.json');
if (versionrc) {
  const bumpFiles = new Set(
    (versionrc.bumpFiles ?? []).map((entry) =>
      typeof entry === 'string' ? entry : entry?.filename,
    ),
  );
  for (const file of [
    'package.json',
    'packages/core/package.json',
    'packages/test-support/package.json',
    'packages/core/templates/package.json.tmpl',
    'docs/fsm-packages.md',
    'skills/aharness-fsm-authoring/references/fsm-packages.md',
  ]) {
    if (!bumpFiles.has(file)) {
      checks.push(`.versionrc.json bumpFiles must include ${file}`);
    }
  }
  if (versionrc.releaseCommitMessageFormat !== 'chore(release): {{currentTag}}') {
    checks.push('.versionrc.json releaseCommitMessageFormat must name the release tag');
  }
  if (versionrc.commitUrlFormat !== 'https://github.com/Alfredvc/aharness/commit/{{hash}}') {
    checks.push('.versionrc.json commitUrlFormat must point to aharness commits');
  }
  if (
    versionrc.compareUrlFormat !==
    'https://github.com/Alfredvc/aharness/compare/{{previousTag}}...{{currentTag}}'
  ) {
    checks.push('.versionrc.json compareUrlFormat must point to aharness comparisons');
  }
}

if (checks.length > 0) {
  console.error(`verify-release-workflows: ${checks.join('\n')}`);
  process.exit(1);
}
