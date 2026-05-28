/**
 * Tests for `daemon/snapshotFlush.ts` — the daemon's atomic
 * `<runDir>/snapshot.json` writer (tmp + fsync + rename).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { flushSnapshot } from '../src/runtime/snapshotFlush.js';

describe('flushSnapshot', () => {
  it('writes the JSON-encoded snapshot to the target path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-snap-'));
    const path = join(dir, 'snap.json');
    try {
      flushSnapshot(path, { foo: 'bar', count: 3 });
      const contents = JSON.parse(readFileSync(path, 'utf8'));
      expect(contents).toEqual({ foo: 'bar', count: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the parent directory if it does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-snap-'));
    const nested = join(dir, 'a', 'b', 'c');
    const path = join(nested, 'snap.json');
    try {
      flushSnapshot(path, { v: 1 });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no `.tmp` file behind after a successful write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-snap-'));
    const path = join(dir, 'snap.json');
    try {
      flushSnapshot(path, { ok: true });
      const stragglers = readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
      expect(stragglers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing snapshot atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-snap-'));
    const path = join(dir, 'snap.json');
    try {
      flushSnapshot(path, { v: 1 });
      flushSnapshot(path, { v: 2 });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
