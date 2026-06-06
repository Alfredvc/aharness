#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AHARNESS_CORE_RANGE_FILES,
  PUBLISHABLE_PACKAGES,
  ROOT,
  isRealSemver,
  packageJsonPath,
  readJson,
  writeJson,
} from './release-helpers.mjs';

const rootPkgPath = join(ROOT, 'package.json');
const rootPkg = readJson(rootPkgPath);
const version = rootPkg.version;

if (!isRealSemver(version)) {
  console.error(
    `sync-release-versions: root package.json version must be a real SemVer, got ${JSON.stringify(version)}`,
  );
  process.exit(1);
}

for (const packageDir of PUBLISHABLE_PACKAGES) {
  const path = packageJsonPath(packageDir);
  const pkg = readJson(path);
  pkg.version = version;
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of ['@aharness/core', '@aharness/test-support']) {
      if (deps[name] !== undefined) deps[name] = 'workspace:*';
    }
  }
  writeJson(path, pkg);
}

for (const relativePath of AHARNESS_CORE_RANGE_FILES) {
  const path = join(ROOT, relativePath);
  const body = readFileSync(path, 'utf8')
    .replace(/"__AHARNESS_VERSION__"/g, `"^${version}"`)
    .replace(/("(?:@aharness\/core)"\s*:\s*)"[^"]+"/g, `$1"^${version}"`);
  writeFileSync(path, body);
}
