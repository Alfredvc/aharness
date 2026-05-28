import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFsm } from '../src/loader/index.js';
import { hashSourceTree } from '../src/loader/cache.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const composedDir = path.resolve(repoRoot, 'packages/core/test/fixtures/composed-pipeline');
const parentPath = path.join(composedDir, 'parent.fsm.ts');
const childPath = path.join(composedDir, 'child-spec.fsm.ts');

describe('loader cache — keying', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'aharness-cache-key-'));
    // Symlink node_modules so the bundle's externalised @aharness/core / xstate
    // imports resolve at module-import time (loadFsm dynamic-imports the bundle
    // out of <tmpRepo>/.aharness/cache/<hash>/fsm.mjs, which uses absolute paths
    // for externals — the symlink isn't strictly required, but mirrors the
    // shape the loader documents).
    await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(tmpRepo, 'node_modules'));
  });

  afterEach(async () => {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  it('hashes differ for two FSMs in the same directory', async () => {
    const aHash = await hashSourceTree(composedDir, parentPath);
    const bHash = await hashSourceTree(composedDir, childPath);
    expect(aHash).not.toBe(bHash);
  });

  it('loadFsm returns the correct machine for each entry when both share a directory', async () => {
    const a = await loadFsm({ filePath: parentPath, repoRoot: tmpRepo });
    expect(a.machine.id).toBe('pipeline');

    // Without the fix, this second load hits the parent's cache entry
    // and returns the parent's machine (id='pipeline').
    const b = await loadFsm({ filePath: childPath, repoRoot: tmpRepo });
    expect(b.machine.id).toBe('spec');

    // And re-loading the parent still returns the parent (verifies the fix
    // didn't simply flip the collision direction).
    const aAgain = await loadFsm({ filePath: parentPath, repoRoot: tmpRepo });
    expect(aAgain.machine.id).toBe('pipeline');
    expect(aAgain.cacheHit).toBe(true);
  });
});
