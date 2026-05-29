import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClearOnEntryCwd } from '../src/runtime/clearOnEntryCwd.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aharness-clear-cwd-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveClearOnEntryCwd', () => {
  it('resolves boolean clearOnEntry to the default launch cwd', () => {
    const defaultCwd = makeTempDir();

    expect(
      resolveClearOnEntryCwd({
        clearOnEntry: true,
        context: {},
        defaultCwd,
        stateId: 'fresh',
      }),
    ).toBe(defaultCwd);
  });

  it('resolves a valid absolute string cwd', () => {
    const cwd = makeTempDir();

    expect(
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toBe(cwd);
  });

  it('resolves a function cwd from the current machine context', () => {
    const cwd = makeTempDir();
    const context = { currentWorktreeDir: cwd };

    expect(
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd: (data) => String(data.currentWorktreeDir) },
        context,
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toBe(cwd);
  });

  it('rejects object-form clearOnEntry without cwd', () => {
    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: {},
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd/);
  });

  it('rejects function cwd errors with state and field details', () => {
    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: {
          cwd: () => {
            throw new Error('boom');
          },
        },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*boom/);
  });

  it('rejects non-string function cwd returns', () => {
    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd: () => 42 },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*string/);
  });

  it('rejects empty cwd strings', () => {
    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd: '' },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*non-empty/);
  });

  it('rejects relative cwd strings', () => {
    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd: 'relative/path' },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*absolute/);
  });

  it('rejects missing paths', () => {
    const missingPath = join(makeTempDir(), 'missing');

    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd: missingPath },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*does not exist/);
  });

  it('rejects file paths', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'file.txt');
    writeFileSync(filePath, 'not a directory');

    expect(() =>
      resolveClearOnEntryCwd({
        clearOnEntry: { cwd: filePath },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*directory/);
  });
});
