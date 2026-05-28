import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveInstallStorePaths } from '../src/installStore/index.js';

describe('install store paths', () => {
  it('uses a non-empty AHARNESS_HOME as the store root', () => {
    const override = path.join(path.sep, 'tmp', 'aharness-custom-home');

    const paths = resolveInstallStorePaths({
      env: { AHARNESS_HOME: override },
      homeDir: path.join(path.sep, 'Users', 'example'),
    });

    expect(paths.storeRoot).toBe(path.resolve(override));
    expect(paths.managedProjectRoot).toBe(path.join(path.resolve(override), 'packages'));
    expect(paths.installsPath).toBe(path.join(path.resolve(override), 'installs.json'));
    expect(paths.commandsPath).toBe(path.join(path.resolve(override), 'commands.json'));
  });

  it('defaults to a .aharness directory under the injected home directory', () => {
    const homeDir = path.join(path.sep, 'Users', 'example');

    const paths = resolveInstallStorePaths({
      env: {},
      homeDir,
    });

    expect(paths.storeRoot).toBe(path.join(homeDir, '.aharness'));
    expect(paths.managedProjectRoot).toBe(path.join(homeDir, '.aharness', 'packages'));
    expect(paths.installsPath).toBe(path.join(homeDir, '.aharness', 'installs.json'));
    expect(paths.commandsPath).toBe(path.join(homeDir, '.aharness', 'commands.json'));
  });

  it('treats an empty AHARNESS_HOME as absent', () => {
    const homeDir = path.join(path.sep, 'Users', 'example');

    const paths = resolveInstallStorePaths({
      env: { AHARNESS_HOME: '' },
      homeDir,
    });

    expect(paths.storeRoot).toBe(path.join(homeDir, '.aharness'));
  });

  it('does not create directories while resolving paths', () => {
    const paths = resolveInstallStorePaths({
      env: { AHARNESS_HOME: 'relative-store' },
      homeDir: path.join(path.sep, 'Users', 'example'),
    });

    expect(paths.storeRoot).toBe(path.resolve('relative-store'));
  });
});
