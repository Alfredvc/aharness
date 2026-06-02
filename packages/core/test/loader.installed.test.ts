import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadInstalledFsm } from '../src/loader/index.js';
import { readInstallPackageManifest } from '../src/installPackage/index.js';

const fixturesDir = path.resolve(__dirname, 'fixtures/install-loader');
const currentCoreVersion = '0.1.0';

describe('installed package loader', () => {
  let storeRoot: string;
  let managedProjectRoot: string;
  let packageRoot: string;
  let dependencyRoot: string;
  let callerWorkspace: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-installed-loader-store-'));
    managedProjectRoot = path.join(storeRoot, 'packages');
    packageRoot = path.join(managedProjectRoot, 'node_modules', '@scope', 'command-package');
    dependencyRoot = path.join(managedProjectRoot, 'node_modules', '@scope', 'dependency-package');
    callerWorkspace = await mkdtemp(path.join(os.tmpdir(), 'aharness-installed-loader-caller-'));

    await mkdir(path.dirname(packageRoot), { recursive: true });
    await mkdir(path.dirname(dependencyRoot), { recursive: true });
    await cp(path.join(fixturesDir, 'command-package'), packageRoot, { recursive: true });
    await cp(path.join(fixturesDir, 'dependency-package'), dependencyRoot, { recursive: true });
    await writeManagedCoreTrap();
    await writeManagedXstateTrap();
    await writeCallerWorkspaceConflict();
    process.chdir(callerWorkspace);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(storeRoot, { recursive: true, force: true });
    await rm(callerWorkspace, { recursive: true, force: true });
  });

  it('loads a scoped installed command with same-package and dependency imports', async () => {
    const command = await readMainCommand();

    const loaded = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    expect(loaded.machine.id).toBe('installed-command-dependency');
    expect(loaded.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
    expect(loaded.sidecar['same.local']?.['done']?.jsonSchema).toBeDefined();
    expect(loaded.sidecar['dependency.dependency']?.['done']?.jsonSchema).toBeDefined();
    const packageFsmDir = path.resolve(packageRoot, 'fsms');
    const dependencyFsmDir = path.resolve(dependencyRoot, 'fsms');
    expect(loaded.skillOriginManifest.rootSourceDir).toBe(packageFsmDir);
    const dependencyPrefix = loaded.skillOriginManifest.sourceDirPrefixes.find(
      (prefix) => prefix.stateIdPrefix === 'dependency',
    );
    expect(normalizeMacTmpPath(dependencyPrefix?.sourceDir ?? '')).toBe(
      normalizeMacTmpPath(dependencyFsmDir),
    );
    expect(loaded.skillOriginManifest.sourceDirPrefixes).toEqual(
      expect.arrayContaining([
        { stateIdPrefix: 'same', sourceDir: packageFsmDir },
        { stateIdPrefix: 'dependency', sourceDir: dependencyPrefix?.sourceDir },
      ]),
    );
    expect(loaded.skillOriginManifest.availableSkills).toEqual(
      expect.arrayContaining([
        {
          sourceDir: packageFsmDir,
          ref: { __aharnessSkillRef: true, source: 'dir', path: './command-skills' },
        },
        {
          sourceDir: packageFsmDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './same-child-skill/SKILL.md',
            optional: false,
          },
        },
        {
          sourceDir: dependencyPrefix?.sourceDir,
          ref: { __aharnessSkillRef: true, source: 'dir', path: './dependency-skills' },
        },
      ]),
    );
    expect(loaded.modulePath).toContain(
      path.join(managedProjectRoot, '.aharness', 'cache', 'installed'),
    );
    expect(loaded.modulePath.endsWith(path.join(loaded.hash, 'fsm.mjs'))).toBe(true);
    expect(loaded.cacheHit).toBe(false);

    const cached = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    expect(cached.cacheHit).toBe(true);
    expect(cached.hash).toBe(loaded.hash);
    expect(cached.modulePath).toBe(loaded.modulePath);
    expect(cached.sidecar['dependency.dependency']?.['done']?.jsonSchema).toBeDefined();
    expect(cached.skillOriginManifest).toEqual(loaded.skillOriginManifest);

    const forced = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
      noCache: true,
    });

    expect(forced.cacheHit).toBe(false);
    expect(forced.hash).toBe(loaded.hash);
  });

  it('changes the installed cache key when origin metadata declarations change', async () => {
    const command = await readMainCommand();
    const before = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    await writeFile(
      path.join(packageRoot, 'fsms', 'child.fsm.ts'),
      [
        "import { aharness, exit, final, state, skill } from '@aharness/core';",
        '',
        'interface LocalPayload {',
        '  readonly ok: boolean;',
        '}',
        '',
        'export default aharness.machine({',
        "  id: 'same-package-child',",
        "  availableSkills: [skill({ path: './same-child-skill-renamed/SKILL.md' })],",
        "  initial: 'local',",
        '  states: {',
        '    local: state({',
        "      entryPrompt: 'same package child',",
        '      exits: {',
        '        done: exit<LocalPayload>({',
        "          when: [{ guard: ({ event }) => event.payload.ok, to: 'shipped' }, { to: 'failed' }],",
        '        }),',
        '      },',
        '    }),',
        "    shipped: final({ outcome: 'success' }),",
        "    failed: final({ outcome: 'failure' }),",
        '  },',
        '});',
        '',
      ].join('\n'),
    );

    const after = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    expect(after.hash).not.toBe(before.hash);
    expect(after.skillOriginManifest.availableSkills).toContainEqual({
      sourceDir: path.resolve(packageRoot, 'fsms'),
      ref: {
        __aharnessSkillRef: true,
        source: 'path',
        path: './same-child-skill-renamed/SKILL.md',
        optional: false,
      },
    });
  });

  it('changes the installed cache key when same-package helper source changes', async () => {
    const command = await readMainCommand();
    const before = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    await writeFile(
      path.join(packageRoot, 'fsms', 'helper.ts'),
      "export function commandHelper(): string {\n  return 'changed-command';\n}\n",
    );

    const after = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    expect(after.hash).not.toBe(before.hash);
    expect(after.machine.id).toBe('installed-changed-command-dependency');
  });

  it('changes the installed cache key when type-only payload source changes', async () => {
    const command = await readMainCommand();
    const before = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });
    expect(before.sidecar['router']?.['go']?.jsonSchema).toMatchObject({
      properties: {
        destination: { enum: ['same', 'dependency'] },
      },
      required: ['destination'],
    });

    await writeFile(
      path.join(packageRoot, 'fsms', 'payloadTypes.ts'),
      "export interface RoutePayload {\n  readonly destination: 'same' | 'dependency';\n  readonly priority: number;\n}\n",
    );

    const after = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    expect(after.hash).not.toBe(before.hash);
    expect(after.cacheHit).toBe(false);
    expect(after.sidecar['router']?.['go']?.jsonSchema).toMatchObject({
      properties: {
        priority: { type: 'number' },
      },
      required: ['destination', 'priority'],
    });
  });

  it('changes the installed cache key when dependency helper source changes', async () => {
    const command = await readMainCommand();
    const before = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    await writeFile(
      path.join(dependencyRoot, 'src', 'dependency-helper.ts'),
      "export function dependencyHelper(): string {\n  return 'changed-dependency';\n}\n",
    );

    const after = await loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/command-package',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:fixture',
    });

    expect(after.hash).not.toBe(before.hash);
    expect(after.machine.id).toBe('installed-command-changed-dependency');
  });

  async function readMainCommand() {
    const manifest = await readInstallPackageManifest({
      packageRoot,
      currentCoreVersion,
    });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) throw new Error('fixture manifest failed validation');
    const command = manifest.value.commands.find((candidate) => candidate.commandName === 'main');
    if (!command) throw new Error('fixture command missing');
    return command;
  }

  async function writeManagedCoreTrap(): Promise<void> {
    const fakeCoreRoot = path.join(managedProjectRoot, 'node_modules', '@aharness', 'core');
    await mkdir(fakeCoreRoot, { recursive: true });
    await writeFile(
      path.join(fakeCoreRoot, 'package.json'),
      JSON.stringify(
        {
          name: '@aharness/core',
          version: '99.0.0',
          type: 'module',
          exports: './index.js',
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(
      path.join(fakeCoreRoot, 'index.js'),
      "throw new Error('managed project @aharness/core must not be imported');\n",
    );
  }

  async function writeManagedXstateTrap(): Promise<void> {
    const fakeXstateRoot = path.join(managedProjectRoot, 'node_modules', 'xstate');
    await mkdir(fakeXstateRoot, { recursive: true });
    await writeFile(
      path.join(fakeXstateRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'xstate',
          version: '99.0.0',
          type: 'module',
          exports: './index.js',
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(
      path.join(fakeXstateRoot, 'index.js'),
      "throw new Error('managed project xstate must not be imported');\n",
    );
  }

  async function writeCallerWorkspaceConflict(): Promise<void> {
    const conflictRoot = path.join(callerWorkspace, 'node_modules', '@scope', 'dependency-package');
    await mkdir(path.join(conflictRoot, 'src'), { recursive: true });
    await writeFile(
      path.join(conflictRoot, 'package.json'),
      JSON.stringify(
        {
          name: '@scope/dependency-package',
          version: '99.0.0',
          type: 'module',
          exports: {
            './src/dependency-helper.js': './src/dependency-helper.ts',
          },
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(
      path.join(conflictRoot, 'src', 'dependency-helper.ts'),
      "export function dependencyHelper(): string {\n  return 'caller-workspace';\n}\n",
    );
  }
});

function normalizeMacTmpPath(value: string): string {
  return value.startsWith('/private/tmp/') ? value.replace('/private/tmp/', '/tmp/') : value;
}
