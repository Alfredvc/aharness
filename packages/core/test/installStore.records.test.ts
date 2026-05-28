import { describe, expect, it } from 'vitest';

import {
  compareCommandIndexGeneration,
  deriveCommandIndexFromInstalls,
  validateTrustedCommandsFile,
  validateTrustedInstallsFile,
  type TrustedCommandIndexEntry,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from '../src/installStore/index.js';

function installRecord(
  packageName: string,
  commands: Record<string, { commandName: string; entry: string; description?: string }>,
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

function commandEntry(
  packageName: string,
  commandName: string,
  overrides: Partial<TrustedCommandIndexEntry> = {},
): TrustedCommandIndexEntry {
  return {
    packageName,
    commandName,
    entry: `fsms/${commandName}.fsm.ts`,
    packageRoot: `/store/packages/node_modules/${packageName}`,
    packageVersion: '1.2.3',
    lockFingerprint: `lock:${packageName}`,
    ...overrides,
  };
}

describe('install store trusted records', () => {
  it('accepts valid empty trusted install and command files', () => {
    const installs = validateTrustedInstallsFile({
      schemaVersion: 1,
      generation: 'gen-1',
      installs: {},
    });
    const commands = validateTrustedCommandsFile({
      schemaVersion: 1,
      generation: 'gen-1',
      commands: {},
    });

    expect(installs.ok).toBe(true);
    expect(commands.ok).toBe(true);
  });

  it('accepts populated trusted install and command files', () => {
    const installs = validateTrustedInstallsFile({
      schemaVersion: 1,
      generation: 'gen-1',
      installs: {
        '@scope/tools': installRecord('@scope/tools', {
          build: {
            commandName: 'build',
            entry: 'fsms/build.fsm.ts',
            description: 'Build release notes',
          },
        }),
      },
    });
    const commands = validateTrustedCommandsFile({
      schemaVersion: 1,
      generation: 'gen-1',
      commands: {
        '@scope/tools/build': commandEntry('@scope/tools', 'build', {
          description: 'Build release notes',
        }),
      },
    });

    expect(installs.ok).toBe(true);
    expect(commands.ok).toBe(true);
  });

  it('reports field-specific diagnostics for malformed trusted install files', () => {
    const invalidVersion = validateTrustedInstallsFile({
      schemaVersion: 2,
      generation: 'gen-1',
      installs: {},
    });
    const invalidGeneration = validateTrustedInstallsFile({
      schemaVersion: 1,
      generation: '',
      installs: {},
    });
    const invalidMap = validateTrustedInstallsFile({
      schemaVersion: 1,
      generation: 'gen-1',
      installs: [],
    });

    expect(invalidVersion.ok).toBe(false);
    if (!invalidVersion.ok) {
      expect(invalidVersion.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-schema-version-invalid',
          field: 'schemaVersion',
        }),
      ]);
    }
    expect(invalidGeneration.ok).toBe(false);
    if (!invalidGeneration.ok) {
      expect(invalidGeneration.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-generation-invalid',
          field: 'generation',
        }),
      ]);
    }
    expect(invalidMap.ok).toBe(false);
    if (!invalidMap.ok) {
      expect(invalidMap.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-installs-invalid',
          field: 'installs',
        }),
      ]);
    }
  });

  it('reports field-specific diagnostics for malformed trusted command files', () => {
    const result = validateTrustedCommandsFile({
      schemaVersion: 1,
      generation: 'gen-1',
      commands: {
        'pkg/build': {
          packageName: 'pkg',
          commandName: '',
          entry: 'fsms/build.fsm.ts',
          packageRoot: '/store/packages/node_modules/pkg',
          lockFingerprint: 'lock:pkg',
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'trusted-command-name-invalid',
          field: 'commands.pkg/build.commandName',
          commandName: '',
        }),
      ]);
    }
  });

  it('derives a deterministic command index from trusted installs', () => {
    const installs: TrustedInstallsFile = {
      schemaVersion: 1,
      generation: 'gen-2',
      installs: {
        toolbox: installRecord('toolbox', {
          build: { commandName: 'build', entry: 'fsms/build.fsm.ts' },
        }),
        '@scope/tools': installRecord('@scope/tools', {
          zeta: { commandName: 'zeta', entry: 'fsms/zeta.fsm.ts' },
          alpha: {
            commandName: 'alpha',
            entry: 'fsms/alpha.fsm.ts',
            description: 'Alpha command',
          },
        }),
      },
    };

    const result = deriveCommandIndexFromInstalls(installs);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.generation).toBe('gen-2');
    expect(Object.keys(result.value.commands)).toEqual([
      '@scope/tools/alpha',
      '@scope/tools/zeta',
      'toolbox/build',
    ]);
    expect(result.value.commands['@scope/tools/alpha']).toEqual({
      packageName: '@scope/tools',
      commandName: 'alpha',
      entry: 'fsms/alpha.fsm.ts',
      packageRoot: '/store/packages/node_modules/@scope/tools',
      packageVersion: '1.2.3',
      lockFingerprint: 'lock:@scope/tools',
      description: 'Alpha command',
    });
  });

  it('detects current and stale command index generations', () => {
    const installs: TrustedInstallsFile = {
      schemaVersion: 1,
      generation: 'gen-1',
      installs: {},
    };
    const current: TrustedCommandsFile = {
      schemaVersion: 1,
      generation: 'gen-1',
      commands: {},
    };
    const stale: TrustedCommandsFile = {
      schemaVersion: 1,
      generation: 'gen-0',
      commands: {},
    };

    expect(compareCommandIndexGeneration(installs, current)).toEqual({
      current: true,
      diagnostics: [],
    });
    expect(compareCommandIndexGeneration(installs, stale)).toEqual({
      current: false,
      diagnostics: [
        expect.objectContaining({
          code: 'command-index-generation-mismatch',
          field: 'generation',
        }),
      ],
    });
  });

  it('reports command identity collisions while deriving an index', () => {
    const installs: TrustedInstallsFile = {
      schemaVersion: 1,
      generation: 'gen-1',
      installs: {
        first: installRecord('pkg', {
          build: { commandName: 'build', entry: 'fsms/build.fsm.ts' },
        }),
        second: installRecord('pkg', {
          build: { commandName: 'build', entry: 'commands/build.fsm.ts' },
        }),
      },
    };

    const result = deriveCommandIndexFromInstalls(installs);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-index-collision',
          commandName: 'build',
          field: 'commands.pkg/build',
        }),
      ]);
    }
  });
});
