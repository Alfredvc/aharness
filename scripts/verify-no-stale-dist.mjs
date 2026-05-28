#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './release-helpers.mjs';

export const STALE_DIST_PATHS = [
  'packages/core/dist/daemon',
  'packages/core/dist/mcp',
  'packages/core/dist/cli/daemonInternal.js',
  'packages/core/dist/cli/daemonInternal.d.ts',
  'packages/core/dist/cli/shutdownSequence.js',
  'packages/core/dist/cli/shutdownSequence.d.ts',
];

const stale = STALE_DIST_PATHS.filter((path) => existsSync(join(ROOT, path)));

if (stale.length > 0) {
  console.error(
    `verify-no-stale-dist: stale release artifacts found:\n${stale.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
