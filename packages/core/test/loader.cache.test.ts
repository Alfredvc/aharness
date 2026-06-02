import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFsm } from '../src/loader/index.js';
import { hashSourceTree, isSerializedSidecar } from '../src/loader/cache.js';

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
    expect(a.skillOriginManifest).toMatchObject({
      rootSourceDir: composedDir,
      sourceDirPrefixes: [{ stateIdPrefix: 'spec', sourceDir: composedDir }],
      availableSkills: expect.arrayContaining([
        {
          sourceDir: composedDir,
          ref: { __aharnessSkillRef: true, source: 'dir', path: './pipeline-skills' },
        },
        {
          sourceDir: composedDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './spec-skill/SKILL.md',
            optional: false,
          },
        },
      ]),
    });

    // Without the fix, this second load hits the parent's cache entry
    // and returns the parent's machine (id='pipeline').
    const b = await loadFsm({ filePath: childPath, repoRoot: tmpRepo });
    expect(b.machine.id).toBe('spec');

    // And re-loading the parent still returns the parent (verifies the fix
    // didn't simply flip the collision direction).
    const aAgain = await loadFsm({ filePath: parentPath, repoRoot: tmpRepo });
    expect(aAgain.machine.id).toBe('pipeline');
    expect(aAgain.cacheHit).toBe(true);
    expect(aAgain.skillOriginManifest).toEqual(a.skillOriginManifest);
  });

  it('rejects serialized sidecars that omit the origin manifest', () => {
    expect(isSerializedSidecar({ schemas: {}, issues: [] })).toBe(false);
  });

  it('salts direct cache hashes by absolute entry path for origin correctness', async () => {
    const firstDir = path.join(tmpRepo, 'first');
    const secondDir = path.join(tmpRepo, 'second');
    await fs.mkdir(firstDir, { recursive: true });
    await fs.mkdir(secondDir, { recursive: true });
    const source = [
      "import { aharness, state, exit, final, skillDir } from '@aharness/core';",
      'interface Payload { readonly ok: boolean }',
      'export default aharness.machine({',
      "  id: 'same-source',",
      "  availableSkills: [skillDir('./skills')],",
      "  initial: 'go',",
      '  states: {',
      "    go: state({ entryPrompt: 'go', exits: { done: exit<Payload>({ to: 'done' }) } }),",
      "    done: final({ outcome: 'success' }),",
      '  },',
      '});',
      '',
    ].join('\n');
    const firstPath = path.join(firstDir, 'same.fsm.ts');
    const secondPath = path.join(secondDir, 'same.fsm.ts');
    await fs.writeFile(firstPath, source);
    await fs.writeFile(secondPath, source);

    const first = await loadFsm({ filePath: firstPath, repoRoot: tmpRepo });
    const second = await loadFsm({ filePath: secondPath, repoRoot: tmpRepo });

    expect(second.hash).not.toBe(first.hash);
    expect(second.cacheHit).toBe(false);
    expect(first.skillOriginManifest.rootSourceDir).toBe(firstDir);
    expect(second.skillOriginManifest.rootSourceDir).toBe(secondDir);
    expect(second.skillOriginManifest.availableSkills).toEqual([
      {
        sourceDir: secondDir,
        ref: { __aharnessSkillRef: true, source: 'dir', path: './skills' },
      },
    ]);
  });
});
