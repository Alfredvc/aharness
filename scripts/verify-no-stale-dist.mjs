#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT } from './release-helpers.mjs';

export const STALE_DIST_PATHS = [
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

export function findStaleDistArtifacts(root = ROOT) {
  return STALE_DIST_PATHS.filter((path) => existsSync(join(root, path)));
}

function runCli() {
  const stale = findStaleDistArtifacts();

  if (stale.length > 0) {
    console.error(
      `verify-no-stale-dist: stale release artifacts found:\n${stale.map((p) => `  - ${p}`).join('\n')}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
