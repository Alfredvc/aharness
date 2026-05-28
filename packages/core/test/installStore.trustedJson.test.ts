import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readTrustedJson,
  validateTrustedInstallsFile,
  writeTrustedJson,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('install store trusted JSON IO', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-store-json-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('writes trusted JSON canonically and reads it through a schema guard', async () => {
    const installsPath = path.join(tempRoot, 'nested', 'installs.json');
    const value: TrustedInstallsFile = {
      schemaVersion: 1,
      generation: 'gen-1',
      installs: {},
    };

    const written = await writeTrustedJson(installsPath, value);
    expect(written.ok).toBe(true);

    const { readFile } = await import('node:fs/promises');
    const body = await readFile(installsPath, 'utf8');
    expect(body).toBe('{"generation":"gen-1","installs":{},"schemaVersion":1}\n');

    const entries = await readdir(path.dirname(installsPath));
    expect(entries).toEqual(['installs.json']);

    const read = await readTrustedJson(installsPath, validateTrustedInstallsFile);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(value);
  });

  it('reports invalid JSON with the trusted file path', async () => {
    const installsPath = path.join(tempRoot, 'installs.json');
    await writeFile(installsPath, '{ nope');

    const read = await readTrustedJson(installsPath, validateTrustedInstallsFile);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-json-invalid',
          path: installsPath,
        }),
      ]);
    }
  });

  it('reports schema diagnostics with the trusted file path', async () => {
    const installsPath = path.join(tempRoot, 'installs.json');
    await writeFile(installsPath, '{"schemaVersion":99,"generation":"gen-1","installs":{}}\n');

    const read = await readTrustedJson(installsPath, validateTrustedInstallsFile);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-schema-version-invalid',
          field: 'schemaVersion',
          path: installsPath,
        }),
      ]);
    }
  });

  it('surfaces read and write errors as diagnostics', async () => {
    const missingPath = path.join(tempRoot, 'missing', 'installs.json');
    const read = await readTrustedJson(missingPath, validateTrustedInstallsFile);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-json-read-failed',
          path: missingPath,
        }),
      ]);
    }
  });
});
