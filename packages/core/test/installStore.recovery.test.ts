import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from '../src/internal/canonicalJson.js';
import {
  regenerateCommandIndexFromInstalls,
  resolveInstallStorePaths,
  type InstallStorePaths,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

describe('install store command-index recovery', () => {
  let storeRoot: string;
  let paths: InstallStorePaths;

  beforeEach(async () => {
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-install-recovery-'));
    paths = resolveInstallStorePaths({ env: { AHARNESS_HOME: storeRoot } });
  });

  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('regenerates a deterministic command index from verified installs', async () => {
    const installs = installsFile({
      generation: 'gen-2',
      installs: {
        zeta: installRecord('zeta', {
          build: commandMetadata('build'),
        }),
        '@scope/tools': installRecord('@scope/tools', {
          deploy: commandMetadata('deploy', 'Deploy scoped tools'),
          alpha: commandMetadata('alpha'),
        }),
      },
    });
    const computeLockFingerprintImpl = vi.fn(async ({ packageName }) => ({
      ok: true as const,
      value: `lock:${packageName}`,
    }));

    const result = await regenerateCommandIndexFromInstalls({
      paths,
      installs,
      computeLockFingerprintImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(computeLockFingerprintImpl).toHaveBeenCalledTimes(2);
    expect(result.value.generation).toBe('gen-2');
    expect(Object.keys(result.value.commands)).toEqual([
      '@scope/tools/alpha',
      '@scope/tools/deploy',
      'zeta/build',
    ]);
    await expect(readFile(paths.commandsPath, 'utf8')).resolves.toBe(
      `${canonicalJson(result.value)}\n`,
    );
  });

  it('does not write commands.json when a package fingerprint no longer matches', async () => {
    const installs = installsFile({
      installs: {
        tools: installRecord('tools', {
          build: commandMetadata('build'),
        }),
      },
    });

    const result = await regenerateCommandIndexFromInstalls({
      paths,
      installs,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'changed-lock' }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'installed-lock-fingerprint-mismatch',
          field: 'installs.tools.lockFingerprint',
        }),
      ]);
    }
    await expect(readFile(paths.commandsPath, 'utf8')).rejects.toThrow();
  });

  it('returns command-index collisions without writing a recovered index', async () => {
    const installs = installsFile({
      installs: {
        first: installRecord('tools', {
          build: commandMetadata('build'),
        }),
        second: {
          ...installRecord('tools', {
            build: commandMetadata('build'),
          }),
          dependencyKey: 'tools-alias',
        },
      },
    });

    const result = await regenerateCommandIndexFromInstalls({
      paths,
      installs,
      computeLockFingerprintImpl: async () => ({ ok: true, value: 'lock:tools' }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-index-collision',
          field: 'commands.tools/build',
        }),
      ]);
    }
    await expect(readFile(paths.commandsPath, 'utf8')).rejects.toThrow();
  });
});

function installsFile(
  opts: {
    readonly generation?: string;
    readonly installs?: Record<string, TrustedInstallRecord>;
  } = {},
): TrustedInstallsFile {
  return {
    schemaVersion: 1,
    generation: opts.generation ?? 'gen-1',
    installs: opts.installs ?? {},
  };
}

function installRecord(
  packageName: string,
  commands: TrustedInstallRecord['commands'],
): TrustedInstallRecord {
  return {
    packageName,
    dependencyKey: packageName,
    requestedSpec: `${packageName}@latest`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    sourceIntentKey: `registry:${packageName}`,
    lockFingerprint: `lock:${packageName}`,
    commands,
  };
}

function commandMetadata(
  commandName: string,
  description?: string,
): TrustedInstallRecord['commands'][string] {
  return {
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
    ...(description !== undefined ? { description } : {}),
  };
}
