import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { readInstallPackageManifest } from '../src/installPackage/index.js';
import { transformInstalledAssetCalls } from '../src/loader/assets.js';
import { loadInstalledFsm } from '../src/loader/index.js';

const fixturesDir = path.resolve(__dirname, 'fixtures/install-assets');
const currentCoreVersion = '0.1.0';

describe('installed package loader asset API', () => {
  let storeRoot: string;
  let managedProjectRoot: string;
  let packageRoot: string;
  let dependencyRoot: string;

  beforeEach(async () => {
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-installed-assets-store-'));
    managedProjectRoot = path.join(storeRoot, 'packages');
    packageRoot = path.join(managedProjectRoot, 'node_modules', '@scope', 'asset-command');
    dependencyRoot = path.join(managedProjectRoot, 'node_modules', '@scope', 'asset-dependency');

    await mkdir(path.dirname(packageRoot), { recursive: true });
    await mkdir(path.dirname(dependencyRoot), { recursive: true });
    await cp(path.join(fixturesDir, 'command-package'), packageRoot, { recursive: true });
    await cp(path.join(fixturesDir, 'dependency-package'), dependencyRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('loads command-package text and URL assets from installed package files', async () => {
    const loaded = await loadAssetCommand();

    expect(loaded.machine.id).toBe('asset-command-command prompt-dependency prompt');
    expect(loaded.machine.config).toHaveProperty('context');
    const context = (loaded.machine.config.context as (args: unknown) => Record<string, unknown>)(
      {},
    );

    expect(context['commandText']).toBe('command prompt');
    expect(String(context['commandUrl'])).toContain(path.join(packageRoot, 'prompts', 'main.md'));
    expect(String(context['commandUrl'])).not.toContain(
      path.join(managedProjectRoot, '.aharness', 'cache', 'installed'),
    );
  });

  it('statically rewrites command and dependency package asset calls', async () => {
    const commandSourceFile = path.join(packageRoot, 'fsms', 'main.fsm.ts');
    const dependencySourceFile = path.join(dependencyRoot, 'src', 'asset-helper.ts');

    const commandTransform = await transformInstalledAssetCalls({
      sourceFile: commandSourceFile,
      sourceText: await readFile(commandSourceFile, 'utf8'),
      managedProjectRoot,
    });
    const dependencyTransform = await transformInstalledAssetCalls({
      sourceFile: dependencySourceFile,
      sourceText: await readFile(dependencySourceFile, 'utf8'),
      managedProjectRoot,
    });

    expect(commandTransform.diagnostics).toEqual([]);
    expect(commandTransform.changed).toBe(true);
    expect(commandTransform.assets.map((asset) => asset.relativePath)).toEqual([
      'prompts/main.md',
      'prompts/main.md',
    ]);
    expect(commandTransform.contents).toContain('file://');
    expect(commandTransform.contents).not.toContain("getAssetText('prompts/main.md')");

    expect(dependencyTransform.diagnostics).toEqual([]);
    expect(dependencyTransform.changed).toBe(true);
    expect(dependencyTransform.assets.map((asset) => asset.relativePath)).toEqual([
      'prompts/dependency.md',
      'prompts/dependency.md',
    ]);
    expect(dependencyTransform.contents).toContain('file://');
    expect(dependencyTransform.contents).not.toContain("getAssetText('prompts/dependency.md')");
  });

  it('resolves dependency package asset calls against the dependency package root', async () => {
    const loaded = await loadAssetCommand();
    const context = (loaded.machine.config.context as (args: unknown) => Record<string, unknown>)(
      {},
    );

    expect(context['dependencyText']).toBe('dependency prompt');
    expect(String(context['dependencyUrl'])).toContain(
      path.join(dependencyRoot, 'prompts', 'dependency.md'),
    );
    expect(String(context['dependencyUrl'])).not.toContain(packageRoot);
  });

  it('changes the installed cache key when an asset file changes', async () => {
    const before = await loadAssetCommand();

    await writeFile(path.join(packageRoot, 'prompts', 'main.md'), 'changed command prompt\n');

    const after = await loadAssetCommand();

    expect(after.cacheHit).toBe(false);
    expect(after.hash).not.toBe(before.hash);
    expect(after.machine.id).toBe('asset-command-changed command prompt-dependency prompt');
  });

  it.each([
    {
      name: 'missing asset',
      source: "aharness.getAssetText('prompts/missing.md')",
      pattern: /asset path does not exist/,
    },
    {
      name: 'absolute asset path',
      source: "aharness.getAssetText('/tmp/secret.md')",
      pattern: /asset path must be a package-relative path/,
    },
    {
      name: 'parent escape',
      source: "aharness.getAssetText('../secret.md')",
      pattern: /asset path must not contain '\.\.' path segments/,
    },
    {
      name: 'directory asset',
      source: "aharness.getAssetText('prompts')",
      pattern: /asset path must resolve to a regular file/,
    },
    {
      name: 'dynamic asset path',
      source: 'aharness.getAssetText(`prompts/${name}.md`)',
      pattern: /must use a string literal first argument/,
    },
  ])('rejects $name before bundle import', async ({ source, pattern }) => {
    await writeCommandSource(source);

    await expect(loadAssetCommand()).rejects.toThrow(pattern);
  });

  it('rejects direct asset symlinks before bundle import', async () => {
    await symlink(
      path.join(packageRoot, 'prompts', 'main.md'),
      path.join(packageRoot, 'direct.md'),
    );
    await writeCommandSource("aharness.getAssetText('direct.md')");

    await expect(loadAssetCommand()).rejects.toThrow(/asset paths must not be symlinks/);
  });

  it('rejects asset paths that escape through symlinked parent directories', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aharness-asset-outside-'));
    await writeFile(path.join(outside, 'secret.md'), 'outside\n');
    await symlink(outside, path.join(packageRoot, 'prompts', 'linked-dir'), 'dir');
    await writeCommandSource("aharness.getAssetText('prompts/linked-dir/secret.md')");

    await expect(loadAssetCommand()).rejects.toThrow(/asset path realpath escapes package root/);

    await rm(outside, { recursive: true, force: true });
  });

  async function loadAssetCommand() {
    const manifest = await readInstallPackageManifest({
      packageRoot,
      currentCoreVersion,
    });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) throw new Error('fixture manifest failed validation');
    const command = manifest.value.commands.find((candidate) => candidate.commandName === 'main');
    if (!command) throw new Error('fixture command missing');

    return loadInstalledFsm({
      entryFile: command.entryPath,
      packageName: '@scope/asset-command',
      commandName: command.commandName,
      packageRoot,
      managedProjectRoot,
      storeRoot,
      lockFingerprint: 'lock:asset-fixture',
    });
  }

  async function writeCommandSource(assetExpression: string): Promise<void> {
    await writeFile(
      path.join(packageRoot, 'fsms', 'main.fsm.ts'),
      `
        import { aharness, final } from '@aharness/core';

        const name = 'main';
        const text = ${assetExpression};

        export default aharness.machine({
          id: 'invalid-asset',
          initial: 'done',
          context: () => ({ text }),
          states: {
            done: final({ outcome: 'success' }),
          },
        });
      `,
    );
  }
});
