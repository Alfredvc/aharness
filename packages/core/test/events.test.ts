import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { appendEventEntry } from '../src/events.js';
import { writeArtifact } from '../src/artifact.js';
import {
  RUN_EVENT_SCHEMA,
  createLiveRunEventPublisher,
  resetRunEventRecordersForTesting,
  setRunEventWriterFactoryForTesting,
  type RunEventEnvelope,
} from '../src/runEvents/index.js';
import { createUiEventLog } from '../src/ui/sse.js';
import type { FsmState, RunMeta } from '../src/ui/events.js';
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

function readEnvelopes(runDir: RunDir): RunEventEnvelope[] {
  return readFileSync(runDir.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RunEventEnvelope);
}

function runMeta(runDir: RunDir): RunMeta {
  return {
    runId: runDir.runId,
    threadId: 'thread-1',
    repoRoot: '/repo',
    fsmFile: '/repo/demo.fsm.ts',
    fsmHash6: 'abc123',
    codexPin: 'codex-test',
    startedAt: '2026-05-29T00:00:00.000Z',
  };
}

const state: FsmState = {
  path: 'root.work',
  leaf: 'work',
  kind: 'stateful',
  exits: [{ name: 'done', kind: 'submit' }],
  visitCount: 1,
};

afterEach(() => {
  resetRunEventRecordersForTesting();
  setRunEventWriterFactoryForTesting(undefined);
});

describe('events.jsonl writer', () => {
  it('writes abandoned-thread residue as a canonical diagnostic event', () => {
    const runDir = tempRunDir();

    appendEventEntry(runDir, {
      kind: 'abandonedThreadResidue',
      threadId: 'thread-old',
      source: 'commandApproval',
      message: 'abandoned command approval declined',
    });

    const entries = readEnvelopes(runDir);
    expect(entries).toEqual([
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        runId: runDir.runId,
        seq: 1,
        id: `${runDir.runId}:1`,
        type: 'diagnostic.abandoned_thread',
        threadId: 'thread-old',
        data: {
          source: 'commandApproval',
          message: 'abandoned command approval declined',
        },
      }),
    ]);
    expect(entries[0]).not.toHaveProperty('kind');
    expect(entries[0]).not.toHaveProperty('ts');
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

    const [entry] = readEnvelopes(runDir);
    expect(entry).toEqual(
      expect.objectContaining({
        type: 'diagnostic.abandoned_thread',
        threadId: 'thread-old',
      }),
    );
    const data = entry?.data;
    if (data === undefined) throw new Error('expected diagnostic data');
    expect(Buffer.byteLength(String(data.source), 'utf8')).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(String(data.message), 'utf8')).toBeLessThanOrEqual(512);
    expect(String(data.source)).toContain('[truncated]');
    expect(String(data.message)).toContain('[truncated]');
  });

  it('maps all legacy public append kinds to canonical compatibility events', () => {
    const runDir = tempRunDir();

    appendEventEntry(runDir, { kind: 'hook', name: 'Stop', payloadDigest: 'abc123' });
    appendEventEntry(runDir, { kind: 'submit', stateId: 'plan', accepted: true });
    appendEventEntry(runDir, {
      kind: 'transition',
      from: 'plan',
      to: 'execute',
      eventType: 'SUBMIT__plan__done',
    });
    appendEventEntry(runDir, { kind: 'artifact', relPath: 'report.txt', bytes: 12 });
    appendEventEntry(runDir, { kind: 'terminal', state: 'done', terminal: 'success' });

    const entries = readEnvelopes(runDir);
    expect(entries.map((entry) => entry.type)).toEqual([
      'hook.observed',
      'submit.recorded',
      'transition.recorded',
      'artifact.written',
      'run.completed',
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(entries.every((entry) => entry.schema === RUN_EVENT_SCHEMA)).toBe(true);
    expect(entries.every((entry) => !('kind' in entry) && !('ts' in entry))).toBe(true);
  });

  it('shares one sequence stream across recorder handles for the same run file', () => {
    const runDir = tempRunDir();

    appendEventEntry(runDir, { kind: 'submit', stateId: 'plan', accepted: true });
    appendEventEntry(runDir, { kind: 'terminal', state: 'done', terminal: 'success' });

    expect(readEnvelopes(runDir).map((entry) => entry.id)).toEqual([
      `${runDir.runId}:1`,
      `${runDir.runId}:2`,
    ]);
  });

  it('keeps append failures best-effort for legacy callers', () => {
    const runDir = tempRunDir();
    setRunEventWriterFactoryForTesting((options) => ({
      append: () => ({
        ok: false,
        warning: {
          code: 'append-failed',
          message: 'disk full',
          eventsPath: options.eventsPath,
          offset: 0,
          envelope: {
            schema: RUN_EVENT_SCHEMA,
            runId: options.runId,
            seq: 1,
            id: `${options.runId}:1`,
            time: '2026-05-29T00:00:00.000Z',
            type: 'submit.recorded',
          },
        },
      }),
      nextSeq: () => 1,
      offset: () => 0,
    }));

    expect(() =>
      appendEventEntry(runDir, { kind: 'submit', stateId: 'plan', accepted: false }),
    ).not.toThrow();
    expect(existsSync(runDir.eventsPath)).toBe(false);
  });

  it('keeps recorder initialization failures best-effort for legacy callers', () => {
    const runDir = tempRunDir();
    mkdirSync(runDir.eventsPath);

    expect(() =>
      appendEventEntry(runDir, { kind: 'submit', stateId: 'plan', accepted: false }),
    ).not.toThrow();
  });

  it('does not truncate non-final corruption when compatibility append is refused', () => {
    const runDir = tempRunDir();
    const first: RunEventEnvelope = {
      schema: RUN_EVENT_SCHEMA,
      runId: runDir.runId,
      seq: 1,
      id: `${runDir.runId}:1`,
      time: '2026-05-29T00:00:00.000Z',
      type: 'run.started',
    };
    const corruptedLog = `${JSON.stringify(first)}\nnot json\n`;
    writeFileSync(runDir.eventsPath, corruptedLog);

    expect(() =>
      appendEventEntry(runDir, { kind: 'submit', stateId: 'plan', accepted: true }),
    ).not.toThrow();

    expect(readFileSync(runDir.eventsPath, 'utf8')).toBe(corruptedLog);
  });

  it('writeArtifact writes the artifact and records canonical metadata only', async () => {
    const runDir = tempRunDir();

    await expect(writeArtifact(runDir, 'reports/final.txt', 'hello')).resolves.toEqual({
      absolutePath: join(runDir.artifactsDir, 'reports/final.txt'),
    });

    expect(readFileSync(join(runDir.artifactsDir, 'reports/final.txt'), 'utf8')).toBe('hello');
    expect(readEnvelopes(runDir)).toEqual([
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        type: 'artifact.written',
        data: { relPath: 'reports/final.txt', bytes: 5 },
      }),
    ]);
  });

  it('writeArtifact keeps the artifact when canonical append fails', async () => {
    const runDir = tempRunDir();
    setRunEventWriterFactoryForTesting((options) => ({
      append: () => ({
        ok: false,
        warning: {
          code: 'append-failed',
          message: 'disk full',
          eventsPath: options.eventsPath,
          offset: 0,
          envelope: {
            schema: RUN_EVENT_SCHEMA,
            runId: options.runId,
            seq: 1,
            id: `${options.runId}:1`,
            time: '2026-05-29T00:00:00.000Z',
            type: 'artifact.written',
          },
        },
      }),
      nextSeq: () => 1,
      offset: () => 0,
    }));

    await expect(writeArtifact(runDir, 'reports/final.txt', 'hello')).resolves.toEqual({
      absolutePath: join(runDir.artifactsDir, 'reports/final.txt'),
    });
    expect(readFileSync(join(runDir.artifactsDir, 'reports/final.txt'), 'utf8')).toBe('hello');
    expect(existsSync(runDir.eventsPath)).toBe(false);
  });

  it('writeArtifact keeps the artifact when recorder initialization fails', async () => {
    const runDir = tempRunDir();
    mkdirSync(runDir.eventsPath);

    await expect(writeArtifact(runDir, 'reports/final.txt', 'hello')).resolves.toEqual({
      absolutePath: join(runDir.artifactsDir, 'reports/final.txt'),
    });
    expect(readFileSync(join(runDir.artifactsDir, 'reports/final.txt'), 'utf8')).toBe('hello');
  });

  it('keeps one canonical sequence across live, compatibility, artifact, and diagnostic writers', async () => {
    const runDir = tempRunDir();
    const publisher = createLiveRunEventPublisher({
      runDir,
      runMeta: runMeta(runDir),
      uiEventLog: createUiEventLog({ run: runMeta(runDir) }),
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    });

    publisher.publishRunStarted();
    publisher.publish({
      kind: 'StateChange',
      from: null,
      to: state.path,
      cause: 'boot',
      newState: state,
    });
    appendEventEntry(runDir, { kind: 'submit', stateId: state.path, accepted: true });
    await writeArtifact(runDir, 'reports/final.txt', 'hello');
    publisher.publish({
      kind: 'AbandonedThreadDiagnostic',
      id: 'diag-1',
      threadId: 'thread-old',
      source: 'turnCompleted',
      message: 'ignored after fresh clear',
    });

    const entries = readEnvelopes(runDir);
    expect(entries.map((entry) => entry.type)).toEqual([
      'run.started',
      'state.changed',
      'submit.recorded',
      'artifact.written',
      'diagnostic.abandoned_thread',
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(entries.map((entry) => entry.id)).toEqual([
      `${runDir.runId}:1`,
      `${runDir.runId}:2`,
      `${runDir.runId}:3`,
      `${runDir.runId}:4`,
      `${runDir.runId}:5`,
    ]);
    expect(entries.every((entry) => entry.schema === RUN_EVENT_SCHEMA)).toBe(true);
    expect(entries.every((entry) => !('kind' in entry) && !('ts' in entry))).toBe(true);
  });
});
