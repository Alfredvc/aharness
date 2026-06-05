import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFsm } from '../src/loader/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const parentPath = resolve(repoRoot, 'packages/core/test/fixtures/composed-pipeline/parent.fsm.ts');

describe('composed-pipeline fixture', () => {
  it('exposes only root FSM input metadata as CLI flags', async () => {
    const result = await loadFsm({ filePath: parentPath, repoRoot });

    expect(result.inputFlags).toEqual({
      topic: { description: 'Project topic' },
    });
    expect(result.inputSchema).toMatchObject({
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      additionalProperties: false,
    });
    expect(Object.keys((result.inputSchema?.properties ?? {}) as Record<string, unknown>)).toEqual([
      'topic',
    ]);
  });
});
