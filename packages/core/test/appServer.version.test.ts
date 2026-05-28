import { describe, expect, it } from 'vitest';
import {
  parseCodexVersion,
  compareSemver,
  isGitPin,
  checkCodexVersion,
  MIN_CODEX_VERSION,
} from '../src/appServer/version.js';

describe('parseCodexVersion', () => {
  it('parses "codex 0.42.0" -> "0.42.0"', () => {
    expect(parseCodexVersion('codex 0.42.0\n')).toBe('0.42.0');
  });
  it('parses "codex-cli 0.42.1 (abc1234)"', () => {
    expect(parseCodexVersion('codex-cli 0.42.1 (abc1234)\n')).toBe('0.42.1');
  });
  it('returns null for unrecognized output', () => {
    expect(parseCodexVersion('garbage')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('returns negative when a<b', () => {
    expect(compareSemver('0.41.9', '0.42.0')).toBeLessThan(0);
  });
  it('returns 0 when equal', () => {
    expect(compareSemver('0.42.0', '0.42.0')).toBe(0);
  });
  it('returns positive when a>b', () => {
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });
});

describe('MIN_CODEX_VERSION', () => {
  it('is read from the script-pinned file', () => {
    expect(typeof MIN_CODEX_VERSION).toBe('string');
    expect(MIN_CODEX_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(isGitPin(MIN_CODEX_VERSION)).toBe(false);
  });
});

describe('isGitPin', () => {
  it('returns true for git-<hex> pins', () => {
    expect(isGitPin('git-127434cd8b96')).toBe(true);
    expect(isGitPin('git-abc1234')).toBe(true);
  });
  it('returns false for semver strings', () => {
    expect(isGitPin('0.42.0')).toBe(false);
    expect(isGitPin('1.2.3-pre.1')).toBe(false);
  });
  it('returns false for empty / unrecognized strings', () => {
    expect(isGitPin('')).toBe(false);
    expect(isGitPin('garbage')).toBe(false);
  });
});

describe('checkCodexVersion (semver-pinned min)', () => {
  const SEMVER_MIN = '0.42.0';

  it('returns ok=true when codex version >= semver min', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'codex 0.42.0\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn, SEMVER_MIN);
    expect(r.ok).toBe(true);
    expect(r.found).toBe('0.42.0');
    expect(r.required).toBe(SEMVER_MIN);
  });

  it('returns ok=false when codex version < semver min', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'codex 0.41.9\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn, SEMVER_MIN);
    expect(r.ok).toBe(false);
    expect(r.found).toBe('0.41.9');
    expect(r.required).toBe(SEMVER_MIN);
    expect(r.message).toContain('0.41.9');
    expect(r.message).toContain(SEMVER_MIN);
  });

  it('returns ok=false when codex is not on PATH', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => {
      throw new Error('ENOENT');
    };
    const r = await checkCodexVersion(spawn, SEMVER_MIN);
    expect(r.ok).toBe(false);
    expect(r.found).toBeNull();
    expect(r.message).toContain('codex');
  });

  it('returns ok=false when codex --version exits non-zero', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: '',
      status: 1,
    });
    const r = await checkCodexVersion(spawn, SEMVER_MIN);
    expect(r.ok).toBe(false);
    expect(r.found).toBeNull();
    expect(r.message).toContain('non-zero');
  });

  it('returns ok=false when --version output is unparseable', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'no version here\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn, SEMVER_MIN);
    expect(r.ok).toBe(false);
    expect(r.found).toBeNull();
    expect(r.message).toContain('unrecognized');
  });
});

describe('checkCodexVersion (git-pinned min)', () => {
  const GIT_MIN = 'git-127434cd8b96';

  it('returns ok=true with a warning message when min is a git-pin and codex is reachable', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'codex 0.42.0\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn, GIT_MIN);
    expect(r.ok).toBe(true);
    expect(r.found).toBe('0.42.0');
    expect(r.required).toBe(GIT_MIN);
    expect(r.message).toBeDefined();
    expect(r.message).toContain('git-pin');
  });

  it('still reports ok=true with warning when found version would be lower than any imagined semver', async () => {
    // git-pin path bypasses semver comparison entirely.
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'codex 0.0.1\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn, GIT_MIN);
    expect(r.ok).toBe(true);
    expect(r.found).toBe('0.0.1');
    expect(r.message).toContain('git-pin');
  });

  it('still returns ok=false when codex is not on PATH (independent of min format)', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => {
      throw new Error('ENOENT');
    };
    const r = await checkCodexVersion(spawn, GIT_MIN);
    expect(r.ok).toBe(false);
    expect(r.found).toBeNull();
  });

  it('still returns ok=false when --version output is unparseable (independent of min format)', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'garbage\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn, GIT_MIN);
    expect(r.ok).toBe(false);
    expect(r.found).toBeNull();
  });
});

describe('checkCodexVersion (default min from file)', () => {
  it('uses MIN_CODEX_VERSION when no explicit required arg is given', async () => {
    const spawn = async (): Promise<{ stdout: string; status: number }> => ({
      stdout: 'codex 99.99.99\n',
      status: 0,
    });
    const r = await checkCodexVersion(spawn);
    expect(r.required).toBe(MIN_CODEX_VERSION);
    expect(r.ok).toBe(true);
  });
});
