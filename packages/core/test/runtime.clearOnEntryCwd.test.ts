import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClearOnEntryOptions } from '../src/runtime/clearOnEntryCwd.js';

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

describe('resolveClearOnEntryOptions', () => {
  it('resolves boolean clearOnEntry to the default launch cwd', () => {
    const defaultCwd = makeTempDir();

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: true,
        context: {},
        defaultCwd,
        stateId: 'fresh',
      }),
    ).toEqual({ cwd: defaultCwd });
  });

  it('resolves a valid absolute string cwd', () => {
    const cwd = makeTempDir();

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: { cwd },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toEqual({ cwd });
  });

  it('resolves a function cwd from the current machine context', () => {
    const cwd = makeTempDir();
    const context = { currentWorktreeDir: cwd };

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: { cwd: (data) => String(data.currentWorktreeDir) },
        context,
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toEqual({ cwd });
  });

  it('resolves model and reasoning effort options against the default cwd', () => {
    const defaultCwd = makeTempDir();

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: { model: 'gpt-5.1-codex' },
        context: {},
        defaultCwd,
        stateId: 'fresh',
      }),
    ).toEqual({ cwd: defaultCwd, model: 'gpt-5.1-codex' });

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: { reasoningEffort: 'high' },
        context: {},
        defaultCwd,
        stateId: 'fresh',
      }),
    ).toEqual({ cwd: defaultCwd, reasoningEffort: 'high' });

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: { model: 'gpt-5.1-codex', reasoningEffort: 'minimal' },
        context: {},
        defaultCwd,
        stateId: 'fresh',
      }),
    ).toEqual({
      cwd: defaultCwd,
      model: 'gpt-5.1-codex',
      reasoningEffort: 'minimal',
    });
  });

  it('resolves cwd, model, and reasoning effort together', () => {
    const cwd = makeTempDir();

    expect(
      resolveClearOnEntryOptions({
        clearOnEntry: { cwd, model: 'gpt-5.1-codex', reasoningEffort: 'low' },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toEqual({ cwd, model: 'gpt-5.1-codex', reasoningEffort: 'low' });
  });

  it('rejects object-form clearOnEntry without supported options', () => {
    expect(() =>
      resolveClearOnEntryOptions({
        clearOnEntry: {},
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*cwd, model, reasoningEffort/);
  });

  it('rejects malformed model and reasoning effort metadata defensively', () => {
    expect(() =>
      resolveClearOnEntryOptions({
        clearOnEntry: { model: 5 } as never,
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.model.*string/);

    expect(() =>
      resolveClearOnEntryOptions({
        clearOnEntry: { reasoningEffort: 'extreme' } as never,
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(
      /state "fresh".*clearOnEntry\.reasoningEffort.*none, minimal, low, medium, high, xhigh/,
    );
  });

  it('rejects function cwd errors with state and field details', () => {
    expect(() =>
      resolveClearOnEntryOptions({
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
      resolveClearOnEntryOptions({
        clearOnEntry: { cwd: () => 42 },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*string/);
  });

  it('rejects empty cwd strings', () => {
    expect(() =>
      resolveClearOnEntryOptions({
        clearOnEntry: { cwd: '' },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*non-empty/);
  });

  it('rejects relative cwd strings', () => {
    expect(() =>
      resolveClearOnEntryOptions({
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
      resolveClearOnEntryOptions({
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
      resolveClearOnEntryOptions({
        clearOnEntry: { cwd: filePath },
        context: {},
        defaultCwd: makeTempDir(),
        stateId: 'fresh',
      }),
    ).toThrow(/state "fresh".*clearOnEntry\.cwd.*directory/);
  });
});
