import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { appendEventEntry, type EventLogEntry } from '../src/events.js';
import type { RunDir } from '../src/types.js';

function tempRunDir(): RunDir {
  const root = mkdtempSync(join(tmpdir(), 'h-events-'));
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(artifactsDir);
  return {
    runId: 'events-test',
    root,
    snapshotPath: join(root, 'snapshot.json'),
    eventsPath: join(root, 'events.jsonl'),
    artifactsDir,
  };
}

function readEntries(runDir: RunDir): EventLogEntry[] {
  return readFileSync(runDir.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as EventLogEntry);
}

describe('events.jsonl writer', () => {
  it('writes abandoned-thread residue without raw payload details', () => {
    const runDir = tempRunDir();

    appendEventEntry(runDir, {
      kind: 'abandonedThreadResidue',
      threadId: 'thread-old',
      source: 'commandApproval',
      message: 'abandoned command approval declined',
    });

    expect(readEntries(runDir)).toEqual([
      expect.objectContaining({
        kind: 'abandonedThreadResidue',
        threadId: 'thread-old',
        source: 'commandApproval',
        message: 'abandoned command approval declined',
      }),
    ]);
  });

  it('caps abandoned-thread residue source and message fields', () => {
    const runDir = tempRunDir();
    const long = 'x'.repeat(2_000);

    appendEventEntry(runDir, {
      kind: 'abandonedThreadResidue',
      threadId: 'thread-old',
      source: long,
      message: long,
    });

    const [entry] = readEntries(runDir);
    expect(entry).toEqual(
      expect.objectContaining({
        kind: 'abandonedThreadResidue',
        threadId: 'thread-old',
      }),
    );
    if (entry?.kind !== 'abandonedThreadResidue') {
      throw new Error('expected abandonedThreadResidue entry');
    }
    expect(Buffer.byteLength(entry.source, 'utf8')).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(entry.message, 'utf8')).toBeLessThanOrEqual(512);
    expect(entry.source).toContain('[truncated]');
    expect(entry.message).toContain('[truncated]');
  });
});
