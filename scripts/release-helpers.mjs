import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export const PUBLISHABLE_PACKAGES = ['packages/core', 'packages/test-support'];

export const SCAFFOLD_VERSION_FILES = ['packages/core/templates/package.json.tmpl'];

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function isRealSemver(version) {
  return (
    typeof version === 'string' &&
    version !== '0.0.0' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  );
}

export function packageJsonPath(packageDir) {
  return join(ROOT, packageDir, 'package.json');
}
