import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkPackageSourceConstraints } from '../src/fsmPackage/sourceConstraints.js';
import type { DiscoveredFsmCommand } from '../src/fsmPackage/types.js';

function tmpPackage(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'harness-fsm-package-source-'));
}

async function writeSource(root: string, relativePath: string, body: string): Promise<string> {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body);
  return fullPath;
}

function command(root: string, name = 'writing-plans'): DiscoveredFsmCommand {
  return {
    kind: 'fsm',
    name,
    filePath: path.join(root, 'fsms', `${name}.fsm.ts`),
  };
}

describe('fsm package source constraints', () => {
  it('allows package-local TypeScript imports that stay under fsmsDir', async () => {
    const root = tmpPackage();
    await writeSource(
      root,
      'fsms/writing-plans.fsm.ts',
      `
        import { helper } from "./helper.js";
        export const value = helper;
      `,
    );
    await writeSource(
      root,
      'fsms/helper.ts',
      `
        export { nested } from "./nested";
        export const helper = 1;
      `,
    );
    await writeSource(root, 'fsms/nested.ts', 'export const nested = 2;');

    const result = await checkPackageSourceConstraints({
      packageRoot: root,
      fsmsDir: 'fsms',
      commands: [command(root)],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects static, export-from, and dynamic TypeScript imports outside fsmsDir', async () => {
    const root = tmpPackage();
    await writeSource(
      root,
      'fsms/writing-plans.fsm.ts',
      `
        import { one } from "../shared/one.js";
        export { two } from "../shared/two";
        void import("../shared/three.js");
        export const value = one;
      `,
    );
    await writeSource(root, 'shared/one.ts', 'export const one = 1;');
    await writeSource(root, 'shared/two.tsx', 'export const two = 2;');
    await writeSource(root, 'shared/three.ts', 'export const three = 3;');

    const result = await checkPackageSourceConstraints({
      packageRoot: root,
      fsmsDir: 'fsms',
      commands: [command(root)],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(3);
      expect(result.diagnostics.every((d) => d.code === 'source-import-outside-fsms-dir')).toBe(
        true,
      );
      expect(result.diagnostics.map((d) => d.importSpecifier).sort()).toEqual([
        '../shared/one.js',
        '../shared/three.js',
        '../shared/two',
      ]);
    }
  });

  it('follows reachable package-local helpers transitively', async () => {
    const root = tmpPackage();
    await writeSource(
      root,
      'fsms/writing-plans.fsm.ts',
      `
        import "./helper";
        export const value = 1;
      `,
    );
    await writeSource(root, 'fsms/helper.ts', 'import "../outside"; export const helper = 1;');
    await writeSource(root, 'outside.ts', 'export const outside = 1;');

    const result = await checkPackageSourceConstraints({
      packageRoot: root,
      fsmsDir: 'fsms',
      commands: [command(root)],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.sourceFile).toBe(path.join(root, 'fsms', 'helper.ts'));
      expect(result.diagnostics[0]?.resolvedFile).toBe(path.join(root, 'outside.ts'));
    }
  });

  it('rejects package-local helper symlinks even when the lexical path is under fsmsDir', async () => {
    const root = tmpPackage();
    await writeSource(
      root,
      'fsms/writing-plans.fsm.ts',
      `
        import "./helper.js";
        export const value = 1;
      `,
    );
    await writeSource(root, 'outside-helper.ts', 'export const helper = 1;');
    await symlink(path.join(root, 'outside-helper.ts'), path.join(root, 'fsms', 'helper.ts'));

    const result = await checkPackageSourceConstraints({
      packageRoot: root,
      fsmsDir: 'fsms',
      commands: [command(root)],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe('source-symlink-rejected');
      expect(result.diagnostics[0]?.resolvedFile).toBe(path.join(root, 'fsms', 'helper.ts'));
    }
  });
});
