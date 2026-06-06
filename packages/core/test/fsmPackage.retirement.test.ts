import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const corePackageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);

describe('generated package execution retirement', () => {
  it('@aharness/core publishes only framework-owned binaries and no package runner export', async () => {
    const packageJson = JSON.parse(await readFile(corePackageJsonPath, 'utf8')) as {
      bin?: unknown;
      exports?: Record<string, unknown>;
    };

    expect(packageJson.bin).toEqual({
      aharness: './dist/cli/main.js',
      'aharness-completion': './dist/cli/completionMain.js',
    });
    expect(packageJson.exports).toBeDefined();
    expect(packageJson.exports).not.toHaveProperty('./package-runner');
  });
});
