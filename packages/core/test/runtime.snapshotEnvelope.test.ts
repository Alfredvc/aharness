/**
 * Tests for `runtime/snapshotEnvelope.ts` — headless snapshot envelope
 * reader/writer and cutover-detection. Spec §4.4, §5.8.
 *
 * The headless envelope schema is
 *   `{ xstate, harnessSubmitToolName: 'harness_submit', threadId }`.
 * Snapshots written by the legacy MCP-era daemon do not carry
 * `harnessSubmitToolName`; those are detected as incompatible so the
 * caller can refuse to resume across the cutover boundary.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  flushHeadlessSnapshotEnvelope,
  loadHeadlessSnapshotEnvelope,
  type CutoverDetectionResult,
} from '../src/runtime.js';

describe('headless snapshot envelope', () => {
  it('round-trips xstate + harnessSubmitToolName + threadId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-snap-'));
    try {
      const path = join(dir, 'snapshot.json');
      flushHeadlessSnapshotEnvelope(path, {
        xstate: { value: 'idle' },
        harnessSubmitToolName: 'harness_submit',
        threadId: 'tid-1',
      });
      const loaded = loadHeadlessSnapshotEnvelope(path);
      expect(loaded.kind).toBe('ok');
      if (loaded.kind === 'ok') {
        expect(loaded.envelope.harnessSubmitToolName).toBe('harness_submit');
        expect(loaded.envelope.threadId).toBe('tid-1');
        expect(loaded.envelope.xstate).toEqual({ value: 'idle' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores obsolete live-clear fields from older envelopes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-snap-'));
    try {
      const path = join(dir, 'snapshot.json');
      writeFileSync(
        path,
        JSON.stringify({
          xstate: { value: 'idle' },
          harnessSubmitToolName: 'harness_submit',
          threadId: 'tid-1',
          pendingClear: true,
          turnsSinceLastClear: 3,
          clearWindowEntries: [10, 20],
        }),
      );
      const loaded = loadHeadlessSnapshotEnvelope(path);
      expect(loaded.kind).toBe('ok');
      if (loaded.kind === 'ok') {
        expect(loaded.envelope).toEqual({
          xstate: { value: 'idle' },
          harnessSubmitToolName: 'harness_submit',
          threadId: 'tid-1',
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits obsolete live-clear fields on write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-snap-'));
    try {
      const path = join(dir, 'snapshot.json');
      flushHeadlessSnapshotEnvelope(path, {
        xstate: { value: 'idle' },
        harnessSubmitToolName: 'harness_submit',
        threadId: 'tid-1',
      });
      const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(written).not.toHaveProperty('pendingClear');
      expect(written).not.toHaveProperty('turnsSinceLastClear');
      expect(written).not.toHaveProperty('clearWindowEntries');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports cutover-detection failure when harnessSubmitToolName is absent (legacy)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-snap-'));
    try {
      const path = join(dir, 'snapshot.json');
      writeFileSync(path, JSON.stringify({ xstate: { value: 'idle' }, pendingClear: false }));
      const r: CutoverDetectionResult = loadHeadlessSnapshotEnvelope(path);
      expect(r.kind).toBe('incompatible');
      if (r.kind === 'incompatible') {
        expect(r.reason).toMatch(/harnessSubmitToolName/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports cutover-detection failure when harnessSubmitToolName mismatches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-snap-'));
    try {
      const path = join(dir, 'snapshot.json');
      writeFileSync(
        path,
        JSON.stringify({
          xstate: {},
          harnessSubmitToolName: 'mcp__harness_fsm__submit',
          threadId: 't',
        }),
      );
      const r = loadHeadlessSnapshotEnvelope(path);
      expect(r.kind).toBe('incompatible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns kind=absent when the file does not exist', () => {
    const r = loadHeadlessSnapshotEnvelope('/tmp/__does_not_exist__/snapshot.json');
    expect(r.kind).toBe('absent');
  });
});
