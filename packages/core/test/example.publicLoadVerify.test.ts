import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
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

const nonCanonicalAuthorImports = new Set([
  'aharness',
  'arg',
  'embed',
  'exit',
  'final',
  'passive',
  'RunDir',
  'skill',
  'skillDir',
  'state',
  'terminal',
  'writeArtifact',
]);

interface AharnessCoreImportSummary {
  readonly namedImports: readonly string[];
  readonly nonCanonicalImports: readonly string[];
  readonly unsupportedImports: readonly string[];
}

function collectAharnessCoreImports(filePath: string): AharnessCoreImportSummary {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const namedImports = new Set<string>();
  const unsupportedImports: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@aharness/core'
    ) {
      continue;
    }

    const clause = statement.importClause;
    if (!clause) {
      unsupportedImports.push('side-effect import');
      continue;
    }
    if (clause.name) unsupportedImports.push(`default import ${clause.name.text}`);

    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      unsupportedImports.push(`namespace import ${clause.namedBindings.name.text}`);
      continue;
    }

    for (const specifier of clause.namedBindings.elements) {
      namedImports.add((specifier.propertyName ?? specifier.name).text);
    }
  }

  const sortedNamedImports = [...namedImports].sort();
  return {
    namedImports: sortedNamedImports,
    nonCanonicalImports: sortedNamedImports.filter((name) => nonCanonicalAuthorImports.has(name)),
    unsupportedImports,
  };
}

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
    const imports = collectAharnessCoreImports(resolve(examplesDir, file));

    expect(imports.namedImports).toContain('createFsm');
    expect(imports.nonCanonicalImports).toEqual([]);
    expect(imports.unsupportedImports).toEqual([]);
  });

  it('documents every public root example in examples/DEMOS.md', () => {
    const demos = readFileSync(resolve(examplesDir, 'DEMOS.md'), 'utf8');

    for (const name of publicExamples) {
      expect(demos).toContain(`examples/${name}.fsm.ts`);
    }
    expect(demos).not.toMatch(/\bSix small example FSMs\b/);
  });
});
