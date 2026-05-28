import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFsm } from '../src/loader/index.js';
import { verify } from '../src/verify/verify.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const examplesDir = resolve(repoRoot, 'examples');

const publicExamples = [
  'color-funnel',
  'await-checkpoints',
  'ops-clear-demo',
  'trivia-rounds',
  'pirate-roast',
  'composed-pipeline',
  'adventure',
  'approval-policy',
] as const;

const migratedExampleFiles = [
  ...publicExamples.map((name) => `${name}.fsm.ts`),
  'composed-pipeline-child.fsm.ts',
] as const;

describe('public examples', () => {
  it.each(publicExamples)('%s loads and verifies with zero error-severity issues', async (name) => {
    const filePath = resolve(examplesDir, `${name}.fsm.ts`);
    const result = await loadFsm({ filePath, repoRoot });
    const report = verify(result.machine, result.sidecar, result.issues, {
      skillEnv: {
        fsmFileDir: examplesDir,
        repoRoot,
      },
    });
    expect(report.errors).toEqual([]);
  });

  it.each(migratedExampleFiles)('%s uses the canonical createFsm authoring surface', (file) => {
    const source = readFileSync(resolve(examplesDir, file), 'utf8');

    expect(source).toContain('createFsm');
    expect(source).not.toMatch(
      /import\s+\{[^}]*\b(assign|terminal|state|exit|arg|embed|skill|writeArtifact|RunDir)\b[^}]*\}\s+from\s+['"][^'"]+['"]/s,
    );
    expect(source).not.toMatch(/\b(writeArtifact|RunDir)\b/);
  });

  it('documents every public root example in examples/DEMOS.md', () => {
    const demos = readFileSync(resolve(examplesDir, 'DEMOS.md'), 'utf8');

    for (const name of publicExamples) {
      expect(demos).toContain(`examples/${name}.fsm.ts`);
    }
    expect(demos).not.toMatch(/\bSix small example FSMs\b/);
  });
});
