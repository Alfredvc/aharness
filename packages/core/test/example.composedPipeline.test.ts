import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFsm } from '../src/loader/index.js';
import { verify } from '../src/verify/verify.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const parentPath = resolve(repoRoot, 'packages/core/test/fixtures/composed-pipeline/parent.fsm.ts');

describe('composed-pipeline fixture', () => {
  it('loads cleanly with the parent FSM exposing `topic` as a CLI flag', async () => {
    const result = await loadFsm({ filePath: parentPath, repoRoot });
    expect(result.machine).toBeDefined();
    expect(result.inputFlags?.['topic']).toBeDefined();
  });

  it('exposes ONLY the root FSMs `input` keys as CLI flags', async () => {
    const result = await loadFsm({ filePath: parentPath, repoRoot });
    expect(Object.keys(result.inputFlags ?? {})).toEqual(['topic']);
  });

  it('verifies with zero error-severity issues', async () => {
    const result = await loadFsm({ filePath: parentPath, repoRoot });
    const report = verify(result.machine, result.sidecar, result.issues);
    expect(report.errors).toEqual([]);
  });
});
