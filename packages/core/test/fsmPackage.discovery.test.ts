import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverPackageCommands } from '../src/fsmPackage/discovery.js';
import { validatePackagePath, validatePackageWriteTarget } from '../src/fsmPackage/paths.js';

function tmpPackage(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'harness-fsm-package-discovery-'));
}

async function makeFsms(root: string, entries: Record<string, string>): Promise<void> {
  const dir = path.join(root, 'fsms');
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    await writeFile(path.join(dir, name), body);
  }
}

describe('fsm package path helpers', () => {
  it('rejects unsafe package-relative paths', () => {
    const root = tmpPackage();

    for (const unsafePath of ['/abs/fsms', 'fsms//nested', '../fsms', 'fsms/../../escape']) {
      const result = validatePackagePath({
        packageRoot: root,
        relativePath: unsafePath,
        field: 'harness.package.fsmsDir',
      });
      expect(result.ok).toBe(false);
    }
  });

  it('normalizes backslash separators before resolving package-relative paths', () => {
    const root = tmpPackage();

    const result = validatePackagePath({
      packageRoot: root,
      relativePath: 'workflows\\nested',
      field: 'harness.package.fsmsDir',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.relativePath).toBe('workflows/nested');
      expect(result.value.absolutePath).toBe(path.join(root, 'workflows', 'nested'));
    }
  });

  it('rejects unsafe backslash-separated package-relative paths', () => {
    const root = tmpPackage();

    const result = validatePackagePath({
      packageRoot: root,
      relativePath: 'workflows\\..\\escape',
      field: 'harness.package.fsmsDir',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('path-parent-segment');
  });

  it('rejects write targets whose existing parent realpath escapes the package root', async () => {
    const root = tmpPackage();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'harness-outside-'));
    const linkPath = path.join(root, 'bin');
    await symlink(outside, linkPath, 'dir');

    const result = await validatePackageWriteTarget({
      packageRoot: root,
      relativePath: 'bin/generated.mjs',
      field: 'bin.ah-example',
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.code)).toContain('path-parent-realpath-escapes');
  });

  it('accepts write targets with missing nested parents below the package root', async () => {
    const root = tmpPackage();

    const result = await validatePackageWriteTarget({
      packageRoot: root,
      relativePath: 'dist/bin/generated.mjs',
      field: 'bin.ah-example',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects write targets whose direct existing parent is a file', async () => {
    const root = tmpPackage();
    await writeFile(path.join(root, 'bin'), 'not a directory');

    const result = await validatePackageWriteTarget({
      packageRoot: root,
      relativePath: 'bin/generated.mjs',
      field: 'bin.ah-example',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'path-parent-not-directory',
          path: path.join(root, 'bin'),
        }),
      ]);
    }
  });

  it('reports stat failures for missing nested parents below an existing file', async () => {
    const root = tmpPackage();
    await writeFile(path.join(root, 'bin'), 'not a directory');

    const result = await validatePackageWriteTarget({
      packageRoot: root,
      relativePath: 'bin/nested/generated.mjs',
      field: 'bin.ah-example',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'path-parent-stat-failed',
          path: path.join(root, 'bin', 'nested'),
        }),
      ]);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports non-ENOENT stat failures before reaching the package root',
    async () => {
      const root = tmpPackage();
      const locked = path.join(root, 'locked');
      await mkdir(locked);
      await chmod(locked, 0o000);
      try {
        const result = await validatePackageWriteTarget({
          packageRoot: root,
          relativePath: 'locked/missing/generated.mjs',
          field: 'bin.ah-example',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.diagnostics).toEqual([
            expect.objectContaining({
              code: 'path-parent-stat-failed',
              path: path.join(locked, 'missing'),
            }),
          ]);
        }
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  it('reports package root realpath failures before write-parent diagnostics', async () => {
    const root = path.join(tmpPackage(), 'missing-root');

    const result = await validatePackageWriteTarget({
      packageRoot: root,
      relativePath: 'dist/bin/generated.mjs',
      field: 'bin.ah-example',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'package-root-realpath-failed',
          path: root,
        }),
      ]);
    }
  });
});

describe('fsm package discovery', () => {
  it('discovers only direct child .fsm.ts regular files and ignores other files', async () => {
    const root = tmpPackage();
    await makeFsms(root, {
      'writing-plans.fsm.ts': 'export default {};',
      'notes.ts': 'export default {};',
    });
    await mkdir(path.join(root, 'fsms', 'nested'));
    await writeFile(path.join(root, 'fsms', 'nested', 'ignored.fsm.ts'), 'export default {};');

    const result = await discoverPackageCommands({
      packageRoot: root,
      fsmsDir: 'fsms',
      commandMetadata: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commands).toEqual([
        {
          kind: 'fsm',
          name: 'writing-plans',
          filePath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
        },
      ]);
    }
  });

  it('rejects reserved or invalid command stems', async () => {
    const root = tmpPackage();
    await makeFsms(root, {
      'list.fsm.ts': 'export default {};',
      'Bad_Name.fsm.ts': 'export default {};',
    });

    const result = await discoverPackageCommands({
      packageRoot: root,
      fsmsDir: 'fsms',
      commandMetadata: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain('command-name-reserved');
      expect(codes).toContain('command-name-invalid');
    }
  });

  it('rejects symlinked FSM files and symlinked directories', async () => {
    const root = tmpPackage();
    await makeFsms(root, {
      'real.fsm.ts': 'export default {};',
    });
    await writeFile(path.join(root, 'outside.fsm.ts'), 'export default {};');
    await symlink(path.join(root, 'outside.fsm.ts'), path.join(root, 'fsms', 'linked.fsm.ts'));
    await symlink(root, path.join(root, 'fsms', 'linked-dir'), 'dir');

    const result = await discoverPackageCommands({
      packageRoot: root,
      fsmsDir: 'fsms',
      commandMetadata: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain('fsm-symlink-rejected');
      expect(codes).toContain('directory-symlink-rejected');
    }
  });

  it('ignores broken non-FSM symlinks', async () => {
    const root = tmpPackage();
    await makeFsms(root, {
      'real.fsm.ts': 'export default {};',
    });
    await symlink(path.join(root, 'missing-target'), path.join(root, 'fsms', 'linked-note'));

    const result = await discoverPackageCommands({
      packageRoot: root,
      fsmsDir: 'fsms',
      commandMetadata: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commands).toEqual([
        {
          kind: 'fsm',
          name: 'real',
          filePath: path.join(root, 'fsms', 'real.fsm.ts'),
        },
      ]);
    }
  });

  it('annotates discovered commands and creates aliases to discovered commands', async () => {
    const root = tmpPackage();
    await makeFsms(root, {
      'writing-plans.fsm.ts': 'export default {};',
    });

    const result = await discoverPackageCommands({
      packageRoot: root,
      fsmsDir: 'fsms',
      commandMetadata: {
        'writing-plans': {
          description: 'Write an implementation plan',
        },
        plan: {
          target: 'writing-plans',
          description: 'Alias for writing-plans',
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commands).toEqual([
        {
          kind: 'alias',
          name: 'plan',
          target: 'writing-plans',
          targetFilePath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
          description: 'Alias for writing-plans',
        },
        {
          kind: 'fsm',
          name: 'writing-plans',
          filePath: path.join(root, 'fsms', 'writing-plans.fsm.ts'),
          description: 'Write an implementation plan',
        },
      ]);
    }
  });

  it('rejects alias chaining, reserved aliases, unknown targets, and duplicate names', async () => {
    const root = tmpPackage();
    await makeFsms(root, {
      'writing-plans.fsm.ts': 'export default {};',
      'reviewing-code.fsm.ts': 'export default {};',
    });

    const result = await discoverPackageCommands({
      packageRoot: root,
      fsmsDir: 'fsms',
      commandMetadata: {
        plan: { target: 'writing-plans' },
        shortcut: { target: 'plan' },
        help: { target: 'writing-plans' },
        missing: { target: 'does-not-exist' },
        'reviewing-code': { target: 'writing-plans' },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain('alias-chain-rejected');
      expect(codes).toContain('command-name-reserved');
      expect(codes).toContain('alias-target-missing');
      expect(codes).toContain('command-name-duplicate');
    }
  });
});
