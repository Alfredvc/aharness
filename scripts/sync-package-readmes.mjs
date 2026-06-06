#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT } from './release-helpers.mjs';

const REPO_URL = 'https://github.com/Alfredvc/aharness';
const REPO_REF = 'main';
const GENERATED_HEADER =
  '<!-- Generated from the repository root README.md by scripts/sync-package-readmes.mjs. Do not edit by hand. -->\n\n';
const MARKDOWN_LINK_TARGET = /(!?\[(?:[^[\]]|\[[^[\]]*])*\]\()([^) \t\n]+)(\))/g;

function isExternalOrAnchorLink(target) {
  return target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function splitTarget(target) {
  const hashIndex = target.indexOf('#');
  const queryIndex = target.indexOf('?');
  const cutIndex =
    hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex);

  if (cutIndex === -1) {
    return { pathPart: target, suffix: '' };
  }

  return {
    pathPart: target.slice(0, cutIndex),
    suffix: target.slice(cutIndex),
  };
}

function normalizeRootRelativePath(pathPart) {
  const normalized = normalize(pathPart).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`README link escapes repository root: ${pathPart}`);
  }
  return normalized === '.' ? '' : normalized;
}

function githubUrlForRootRelativePath(pathPart, suffix) {
  const normalized = normalizeRootRelativePath(pathPart);
  if (normalized.length === 0) {
    return `${REPO_URL}${suffix}`;
  }

  const fullPath = resolve(ROOT, normalized);
  const kind = existsSync(fullPath) && statSync(fullPath).isDirectory() ? 'tree' : 'blob';
  return `${REPO_URL}/${kind}/${REPO_REF}/${encodeURI(normalized)}${suffix}`;
}

function rewriteRootReadmeLink(target) {
  if (isExternalOrAnchorLink(target)) {
    return target;
  }

  const { pathPart, suffix } = splitTarget(target);
  return githubUrlForRootRelativePath(pathPart, suffix);
}

export function findRootRelativeMarkdownLinks(markdown) {
  return [...markdown.matchAll(MARKDOWN_LINK_TARGET)]
    .map((match) => match[2])
    .filter((target) => isExternalOrAnchorLink(target) === false);
}

export function buildCorePackageReadme(rootReadme) {
  const rewritten = rootReadme.replace(MARKDOWN_LINK_TARGET, (_match, open, target, close) => {
    return `${open}${rewriteRootReadmeLink(target)}${close}`;
  });
  return `${GENERATED_HEADER}${rewritten}`;
}

export function syncPackageReadmes({ check = false } = {}) {
  const rootReadmePath = join(ROOT, 'README.md');
  const coreReadmePath = join(ROOT, 'packages/core/README.md');
  const expected = buildCorePackageReadme(readFileSync(rootReadmePath, 'utf8'));
  const current = readFileSync(coreReadmePath, 'utf8');
  const relativeLinks = findRootRelativeMarkdownLinks(expected);

  if (relativeLinks.length > 0) {
    throw new Error(
      `generated core README still contains relative link target(s): ${relativeLinks.join(', ')}`,
    );
  }

  if (current === expected) {
    return [];
  }

  if (check) {
    return [coreReadmePath];
  }

  writeFileSync(coreReadmePath, expected);
  return [];
}

function runCli() {
  const check = process.argv.includes('--check');
  const stale = syncPackageReadmes({ check });

  if (stale.length === 0) {
    return;
  }

  console.error(
    `sync-package-readmes: stale generated README(s):\n${stale
      .map((path) => `  - ${path}`)
      .join('\n')}\nRun: pnpm run sync:package-readmes`,
  );
  process.exit(1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
