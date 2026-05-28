/**
 * Snapshot envelope round-trip tests. Verifies that the flat
 * `flushSnapshot` helper composes the envelope shape `loadSnapshot`
 * reads.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { flushSnapshot } from '../src/runtime/snapshotFlush.js';
import { loadSnapshot } from '../src/snapshot.js';
import type { RunDir } from '../src/types.js';

function mkRunDir(): { runDir: RunDir; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'codex-snap-env-'));
  const snapshotPath = join(root, 'snapshot.json');
  const runDir: RunDir = {
    runId: 'env-test-run',
    root,
    snapshotPath,
    eventsPath: join(root, 'events.jsonl'),
    artifactsDir: join(root, 'artifacts'),
  };
  return {
    runDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('snapshot envelope', () => {
  it('round-trips xstate through flush/load', () => {
    const { runDir, cleanup } = mkRunDir();
    try {
      flushSnapshot(runDir.snapshotPath, {
        xstate: { value: 'foo' },
      });
      const loaded = loadSnapshot(runDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.xstate).toEqual({ value: 'foo' });
    } finally {
      cleanup();
    }
  });

  it('reads injectedSkills as empty when the field is absent', () => {
    const { runDir, cleanup } = mkRunDir();
    try {
      flushSnapshot(runDir.snapshotPath, { xstate: { value: 'bar' } });
      const loaded = loadSnapshot(runDir);
      expect(loaded?.injectedSkills).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reads a legacy snapshot with no envelope', () => {
    const { runDir, cleanup } = mkRunDir();
    try {
      // Pre-envelope shape: the whole file IS the XState slice.
      writeFileSync(runDir.snapshotPath, JSON.stringify({ value: 'legacy' }));
      const loaded = loadSnapshot(runDir);
      expect(loaded?.xstate).toEqual({ value: 'legacy' });
      expect(loaded?.injectedSkills).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('returns null when no snapshot file exists', () => {
    const { runDir, cleanup } = mkRunDir();
    try {
      expect(loadSnapshot(runDir)).toBeNull();
    } finally {
      cleanup();
    }
  });
});
