import { describe, expect, it } from 'vitest';

import {
  parseCommandIdentity,
  resolveCommandFromIndex,
  type TrustedCommandsFile,
} from '../src/installStore/index.js';

const commandsFile: TrustedCommandsFile = {
  schemaVersion: 1,
  generation: 'gen-1',
  commands: {
    'pkg/build': {
      packageName: 'pkg',
      commandName: 'build',
      entry: 'fsms/build.fsm.ts',
      packageRoot: '/store/packages/node_modules/pkg',
      lockFingerprint: 'lock:pkg',
    },
    'pkg/deploy': {
      packageName: 'pkg',
      commandName: 'deploy',
      entry: 'fsms/deploy.fsm.ts',
      packageRoot: '/store/packages/node_modules/pkg',
      lockFingerprint: 'lock:pkg',
    },
    '@scope/tools/build': {
      packageName: '@scope/tools',
      commandName: 'build',
      entry: 'fsms/build.fsm.ts',
      packageRoot: '/store/packages/node_modules/@scope/tools',
      lockFingerprint: 'lock:@scope/tools',
    },
  },
};

describe('install store command identity parsing', () => {
  it('parses unscoped and scoped fully qualified command identities', () => {
    expect(parseCommandIdentity('pkg/build')).toEqual({
      ok: true,
      value: {
        kind: 'qualified',
        packageName: 'pkg',
        commandName: 'build',
        identity: 'pkg/build',
      },
    });
    expect(parseCommandIdentity('@scope/tools/build')).toEqual({
      ok: true,
      value: {
        kind: 'qualified',
        packageName: '@scope/tools',
        commandName: 'build',
        identity: '@scope/tools/build',
      },
    });
  });

  it('distinguishes bare commands from package-only scoped names', () => {
    expect(parseCommandIdentity('build')).toEqual({
      ok: true,
      value: {
        kind: 'bare',
        commandName: 'build',
      },
    });
    expect(parseCommandIdentity('@scope/tools')).toEqual({
      ok: true,
      value: {
        kind: 'package',
        packageName: '@scope/tools',
      },
    });
  });

  it('rejects identities with too many path segments', () => {
    const parsed = parseCommandIdentity('pkg/build/extra');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-identity-invalid',
          commandName: 'pkg/build/extra',
        }),
      ]);
    }
  });
});

describe('install store command resolver', () => {
  it('resolves exact fully qualified commands from the trusted index', () => {
    const resolved = resolveCommandFromIndex(commandsFile, '@scope/tools/build');

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.identity).toBe('@scope/tools/build');
      expect(resolved.value.entry.packageName).toBe('@scope/tools');
      expect(resolved.value.entry.commandName).toBe('build');
    }
  });

  it('resolves a unique bare command from the trusted index', () => {
    const resolved = resolveCommandFromIndex(commandsFile, 'deploy');

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.identity).toBe('pkg/deploy');
      expect(resolved.value.entry.commandName).toBe('deploy');
    }
  });

  it('fails unresolved commands with diagnostics', () => {
    const resolved = resolveCommandFromIndex(commandsFile, 'missing');

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-not-found',
          commandName: 'missing',
        }),
      ]);
    }
  });

  it('fails ambiguous bare commands with sorted fully qualified alternatives', () => {
    const resolved = resolveCommandFromIndex(commandsFile, 'build');

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-ambiguous',
          commandName: 'build',
          alternatives: ['@scope/tools/build', 'pkg/build'],
        }),
      ]);
    }
  });

  it('does not resolve package-only scoped names as commands', () => {
    const resolved = resolveCommandFromIndex(commandsFile, '@scope/tools');

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.diagnostics).toEqual([
        expect.objectContaining({
          code: 'command-identity-package-only',
          commandName: '@scope/tools',
        }),
      ]);
    }
  });
});
