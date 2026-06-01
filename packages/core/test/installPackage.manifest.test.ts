import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readInstallPackageManifest,
  validateInstallPackageManifest,
  type InstallPackageDiagnostic,
} from '../src/installPackage/index.js';

const CURRENT_CORE_VERSION = '0.1.0';

async function tmpPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'aharness-install-package-'));
}

async function writeSource(root: string, relativePath: string, body = 'export default {};\n') {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body);
  return fullPath;
}

function validPackageJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@acme/workflows',
    version: '1.2.3',
    dependencies: {
      '@aharness/core': '^0.1.0',
    },
    aharness: {
      package: {
        commands: {
          'writing-plans': {
            entry: 'fsms/writing-plans.fsm.ts',
            description: 'Write an implementation plan',
          },
        },
      },
    },
    ...overrides,
  };
}

async function validatePackage(
  root: string,
  packageJson: Record<string, unknown>,
  packageJsonText?: string,
) {
  return validateInstallPackageManifest({
    packageRoot: root,
    packageJsonPath: path.join(root, 'package.json'),
    packageJson,
    ...(packageJsonText !== undefined ? { packageJsonText } : {}),
    currentCoreVersion: CURRENT_CORE_VERSION,
  });
}

function diagnosticCodes(diagnostics: readonly InstallPackageDiagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe('install package manifest validation', () => {
  it('accepts explicit install command metadata and preserves package identity', async () => {
    const root = await tmpPackage();
    for (const commandName of ['version', 'help', 'verify', 'list']) {
      await writeSource(root, `fsms/${commandName}.fsm.ts`);
    }

    const result = await validatePackage(
      root,
      validPackageJson({
        name: '@scope/workflows',
        aharness: {
          package: {
            commands: {
              version: { entry: 'fsms/version.fsm.ts' },
              help: { entry: 'fsms/help.fsm.ts', description: 'Package help' },
              verify: { entry: 'fsms/verify.fsm.ts' },
              list: { entry: 'fsms/list.fsm.ts' },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageName).toBe('@scope/workflows');
    expect(result.value.packageVersion).toBe('1.2.3');
    expect(result.value.coreDependencyRange).toBe('^0.1.0');
    expect(result.value.commands.map((command) => command.commandName)).toEqual([
      'help',
      'list',
      'verify',
      'version',
    ]);
    expect(result.value.commands[0]).toMatchObject({
      commandName: 'help',
      entry: 'fsms/help.fsm.ts',
      entryPath: path.join(root, 'fsms', 'help.fsm.ts'),
      description: 'Package help',
    });
  });

  it('rejects old generated-bin-only metadata for install validation', async () => {
    const root = await tmpPackage();
    const result = await validatePackage(
      root,
      validPackageJson({
        bin: { 'ah-workflows': './bin/ah-workflows.mjs' },
        files: ['bin', 'fsms'],
        aharness: {
          package: {
            bin: 'ah-workflows',
            fsmsDir: 'fsms',
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'install-commands-missing',
          field: 'aharness.package.commands',
        }),
      );
    }
  });

  it('rejects invalid package identity and @aharness/core dependency ranges', async () => {
    const cases: Array<{
      readonly name: string;
      readonly overrides: Record<string, unknown>;
      readonly code: string;
      readonly field: string;
    }> = [
      {
        name: 'missing package name',
        overrides: { name: '' },
        code: 'package-name-invalid',
        field: 'name',
      },
      {
        name: 'missing dependencies',
        overrides: { dependencies: undefined },
        code: 'core-dependency-missing',
        field: 'dependencies.@aharness/core',
      },
      {
        name: 'missing core dependency',
        overrides: { dependencies: {} },
        code: 'core-dependency-missing',
        field: 'dependencies.@aharness/core',
      },
      {
        name: 'empty core dependency range',
        overrides: { dependencies: { '@aharness/core': '' } },
        code: 'core-dependency-invalid',
        field: 'dependencies.@aharness/core',
      },
      {
        name: 'invalid core dependency range',
        overrides: { dependencies: { '@aharness/core': 'not a range' } },
        code: 'core-dependency-invalid',
        field: 'dependencies.@aharness/core',
      },
      {
        name: 'incompatible core dependency range',
        overrides: { dependencies: { '@aharness/core': '>=2.0.0' } },
        code: 'core-dependency-incompatible',
        field: 'dependencies.@aharness/core',
      },
    ];

    for (const testCase of cases) {
      const root = await tmpPackage();
      await writeSource(root, 'fsms/writing-plans.fsm.ts');

      const result = await validatePackage(root, validPackageJson(testCase.overrides));

      expect(result.ok, testCase.name).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics, testCase.name).toContainEqual(
          expect.objectContaining({ code: testCase.code, field: testCase.field }),
        );
      }
    }
  });

  it('rejects malformed command names and command entry metadata', async () => {
    const root = await tmpPackage();
    const result = await validatePackage(
      root,
      validPackageJson({
        aharness: {
          package: {
            commands: {
              Bad_Name: { entry: 'fsms/bad.fsm.ts' },
              '-leading-dash': { entry: 'fsms/dash.fsm.ts' },
              okay: { target: 'writing-plans' },
              nope: 42,
              empty: { entry: '' },
              typed: { entry: 12 },
              described: { entry: 'fsms/described.fsm.ts', description: 12 },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(diagnosticCodes(result.diagnostics)).toEqual(
        expect.arrayContaining([
          'command-name-invalid',
          'command-entry-invalid',
          'command-entry-missing',
          'command-entry-invalid',
          'command-description-invalid',
        ]),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'command-entry-missing',
          field: 'aharness.package.commands.okay.entry',
          commandName: 'okay',
        }),
      );
    }
  });

  it('detects duplicate command keys from the raw package.json text only under commands', async () => {
    const root = await tmpPackage();
    await writeSource(root, 'fsms/second.fsm.ts');
    const packageJsonText = JSON.stringify(
      {
        name: '@acme/workflows',
        version: '1.2.3',
        scripts: { build: 'tsc' },
        dependencies: { '@aharness/core': '^0.1.0' },
        aharness: { package: { commands: {} } },
      },
      null,
      2,
    ).replace(
      '"commands": {}',
      '"commands": {"plan": {"entry": "fsms/first.fsm.ts"}, "plan": {"entry": "fsms/second.fsm.ts"}}',
    );
    const packageJson = JSON.parse(packageJsonText) as Record<string, unknown>;

    const result = await validatePackage(root, packageJson, packageJsonText);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'command-name-duplicate',
          field: 'aharness.package.commands.plan',
          commandName: 'plan',
        }),
      );
    }
  });

  it('does not reject duplicate keys outside aharness.package.commands', async () => {
    const root = await tmpPackage();
    await writeSource(root, 'fsms/writing-plans.fsm.ts');
    const packageJsonText = JSON.stringify(validPackageJson(), null, 2).replace(
      '"version": "1.2.3"',
      '"version": "0.0.1", "version": "1.2.3"',
    );
    const packageJson = JSON.parse(packageJsonText) as Record<string, unknown>;

    const result = await validatePackage(root, packageJson, packageJsonText);

    expect(result.ok).toBe(true);
  });

  it('rejects unsafe command entry paths and non-FSM files', async () => {
    const cases: Array<{
      readonly name: string;
      readonly entry: string;
      readonly setup?: (root: string) => Promise<void>;
      readonly code: string;
    }> = [
      { name: 'absolute path', entry: '/tmp/escape.fsm.ts', code: 'path-absolute' },
      { name: 'parent segment', entry: '../escape.fsm.ts', code: 'path-parent-segment' },
      { name: 'empty segment', entry: 'fsms//plan.fsm.ts', code: 'path-empty-segment' },
      { name: 'missing file', entry: 'fsms/missing.fsm.ts', code: 'entry-stat-failed' },
      {
        name: 'directory',
        entry: 'fsms/directory.fsm.ts',
        setup: async (root) => {
          await mkdir(path.join(root, 'fsms', 'directory.fsm.ts'), { recursive: true });
        },
        code: 'entry-not-file',
      },
      {
        name: 'wrong extension',
        entry: 'fsms/not-fsm.ts',
        setup: async (root) => {
          await writeSource(root, 'fsms/not-fsm.ts');
        },
        code: 'entry-extension-invalid',
      },
    ];

    for (const testCase of cases) {
      const root = await tmpPackage();
      await testCase.setup?.(root);

      const result = await validatePackage(
        root,
        validPackageJson({
          aharness: {
            package: {
              commands: {
                plan: { entry: testCase.entry },
              },
            },
          },
        }),
      );

      expect(result.ok, testCase.name).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics, testCase.name).toContainEqual(
          expect.objectContaining({ code: testCase.code, commandName: 'plan' }),
        );
      }
    }
  });

  it('rejects direct symlink entries and symlinked parent escapes', async () => {
    const directRoot = await tmpPackage();
    await writeSource(directRoot, 'outside.fsm.ts');
    await mkdir(path.join(directRoot, 'fsms'), { recursive: true });
    await symlink(
      path.join(directRoot, 'outside.fsm.ts'),
      path.join(directRoot, 'fsms/link.fsm.ts'),
    );

    const direct = await validatePackage(
      directRoot,
      validPackageJson({
        aharness: { package: { commands: { plan: { entry: 'fsms/link.fsm.ts' } } } },
      }),
    );

    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'entry-symlink-rejected',
          commandName: 'plan',
          resolvedFile: path.join(directRoot, 'fsms', 'link.fsm.ts'),
        }),
      );
    }

    const parentRoot = await tmpPackage();
    const outside = await tmpPackage();
    await writeSource(outside, 'plan.fsm.ts');
    await symlink(outside, path.join(parentRoot, 'fsms'), 'dir');

    const parent = await validatePackage(
      parentRoot,
      validPackageJson({
        aharness: { package: { commands: { plan: { entry: 'fsms/plan.fsm.ts' } } } },
      }),
    );

    expect(parent.ok).toBe(false);
    if (!parent.ok) {
      expect(parent.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'entry-realpath-escapes',
          commandName: 'plan',
          resolvedFile: await realpath(path.join(outside, 'plan.fsm.ts')),
        }),
      );
    }
  });

  it('reports package.json read and parse diagnostics from the reader path', async () => {
    const missingRoot = await tmpPackage();
    const missing = await readInstallPackageManifest({
      packageRoot: missingRoot,
      currentCoreVersion: CURRENT_CORE_VERSION,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(diagnosticCodes(missing.diagnostics)).toContain('package-json-read-failed');

    const invalidRoot = await tmpPackage();
    await writeFile(path.join(invalidRoot, 'package.json'), '{ nope');
    const invalid = await readInstallPackageManifest({
      packageRoot: invalidRoot,
      currentCoreVersion: CURRENT_CORE_VERSION,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(diagnosticCodes(invalid.diagnostics)).toContain('package-json-invalid');
  });
});
