import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RUN_EVENT_SCHEMA, createRunEventWriter, replayRunEvents } from '../src/runEvents/index.js';
import type { RunEventEnvelope } from '../src/runEvents/index.js';

function tempEventsPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aharness-run-events-storage-'));
  mkdirSync(root, { recursive: true });
  return join(root, 'events.jsonl');
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('canonical run event writer', () => {
  it('appends one canonical JSON object per line with deterministic ids and raw preservation', () => {
    const eventsPath = tempEventsPath();
    const writer = createRunEventWriter({
      runId: 'run-1',
      eventsPath,
      clock: () => '2026-05-29T00:00:00.000Z',
    });

    const first = writer.append({
      type: 'run.started',
      threadId: 'thread-1',
      data: { status: 'running' },
      meta: { model: 'codex-test' },
      raw: { ownerInput: { isSecret: true, value: 'persist me' } },
    });
    const second = writer.append({
      type: 'state.changed',
      stateVisitId: 'visit-1',
      data: { from: null, to: 'executeSlice', path: 'executeSlice' },
    });

    expect(first).toEqual(
      expect.objectContaining({
        ok: true,
        offset: 0,
      }),
    );
    expect(second).toEqual(
      expect.objectContaining({
        ok: true,
        offset: expect.any(Number),
      }),
    );
    if (!first.ok || !second.ok) throw new Error('expected successful appends');

    const file = readFileSync(eventsPath, 'utf8');
    expect(file.endsWith('\n')).toBe(true);

    const lines = readLines(eventsPath);
    expect(lines).toHaveLength(2);
    expect(second.offset).toBe(Buffer.byteLength(`${lines[0]}\n`, 'utf8'));

    const parsed = lines.map((line) => JSON.parse(line) as RunEventEnvelope);
    expect(parsed[0]).toEqual({
      schema: RUN_EVENT_SCHEMA,
      runId: 'run-1',
      seq: 1,
      id: 'run-1:1',
      time: '2026-05-29T00:00:00.000Z',
      type: 'run.started',
      threadId: 'thread-1',
      data: { status: 'running' },
      meta: { model: 'codex-test' },
      raw: { ownerInput: { isSecret: true, value: 'persist me' } },
    });
    expect(parsed[1]).toEqual(
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        runId: 'run-1',
        seq: 2,
        id: 'run-1:2',
        type: 'state.changed',
        stateVisitId: 'visit-1',
      }),
    );
    expect(writer.nextSeq()).toBe(3);
    expect(writer.offset()).toBe(Buffer.byteLength(file, 'utf8'));
  });

  it('starts from a supplied sequence and byte offset', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, 'x'.repeat(123));
    const writer = createRunEventWriter({
      runId: 'run-2',
      eventsPath,
      nextSeq: 7,
      initialOffset: 123,
      clock: () => '2026-05-29T00:00:01.000Z',
    });

    const result = writer.append({ type: 'turn.started', turnId: 'turn-7' });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        offset: 123,
      }),
    );
    if (!result.ok) throw new Error('expected successful append');
    expect(result.envelope).toEqual(
      expect.objectContaining({
        seq: 7,
        id: 'run-2:7',
        turnId: 'turn-7',
      }),
    );
    expect(writer.nextSeq()).toBe(8);
  });

  it('returns structured warnings and invokes the warning reporter on append failure', () => {
    const eventsPath = tempEventsPath();
    const onWarning = vi.fn();
    const writer = createRunEventWriter({
      runId: 'run-3',
      eventsPath,
      clock: () => '2026-05-29T00:00:02.000Z',
      append: () => {
        throw new Error('disk full');
      },
      onWarning,
    });

    const result = writer.append({ type: 'run.started' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected append warning');
    expect(result.warning).toEqual(
      expect.objectContaining({
        code: 'append-failed',
        message: 'disk full',
        eventsPath,
        offset: 0,
      }),
    );
    expect(result.warning.envelope).toEqual(
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        runId: 'run-3',
        seq: 1,
        id: 'run-3:1',
      }),
    );
    expect(onWarning).toHaveBeenCalledWith(result.warning);
    expect(writer.nextSeq()).toBe(1);
    expect(writer.offset()).toBe(0);
  });

  it('returns structured warnings for serialization failures without advancing sequence', () => {
    const eventsPath = tempEventsPath();
    const onWarning = vi.fn();
    const writer = createRunEventWriter({
      runId: 'run-serialize',
      eventsPath,
      clock: () => '2026-05-29T00:00:02.500Z',
      onWarning,
    });

    const result = writer.append({
      type: 'run.started',
      raw: { value: 1n },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        warning: expect.objectContaining({ code: 'serialize-failed' }),
      }),
    );
    if (result.ok) throw new Error('expected serialization warning');
    expect(onWarning).toHaveBeenCalledWith(result.warning);
    expect(writer.nextSeq()).toBe(1);
    expect(writer.offset()).toBe(0);
  });

  it('returns structured warnings when tail truncation fails', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, 'x'.repeat(64));
    const append = vi.fn();
    const writer = createRunEventWriter({
      runId: 'run-truncate',
      eventsPath,
      initialOffset: 32,
      clock: () => '2026-05-29T00:00:02.750Z',
      append,
      truncate: () => {
        throw new Error('truncate denied');
      },
    });

    const result = writer.append({ type: 'run.started' });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        warning: expect.objectContaining({
          code: 'truncate-failed',
          message: 'truncate denied',
          offset: 32,
        }),
      }),
    );
    expect(append).not.toHaveBeenCalled();
    expect(writer.nextSeq()).toBe(1);
    expect(writer.offset()).toBe(32);
  });

  it('does not throw when the append warning reporter throws', () => {
    const eventsPath = tempEventsPath();
    const writer = createRunEventWriter({
      runId: 'run-4',
      eventsPath,
      clock: () => '2026-05-29T00:00:03.000Z',
      append: () => {
        throw new Error('disk full');
      },
      onWarning: () => {
        throw new Error('reporter failed');
      },
    });

    expect(() => writer.append({ type: 'run.started' })).not.toThrow();
    const result = writer.append({ type: 'run.started' });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        warning: expect.objectContaining({ code: 'append-failed' }),
      }),
    );
  });

  it('truncates an ignored malformed tail before appending at replay appendOffset', () => {
    const eventsPath = tempEventsPath();
    const first = {
      schema: RUN_EVENT_SCHEMA,
      runId: 'run-5',
      seq: 1,
      id: 'run-5:1',
      time: '2026-05-29T00:00:04.000Z',
      type: 'run.started',
    } satisfies RunEventEnvelope;
    const firstLine = `${JSON.stringify(first)}\n`;
    writeFileSync(eventsPath, `${firstLine}{ "schema":`);

    const replay = replayRunEvents({ runId: 'run-5', eventsPath });
    expect(replay).toEqual(
      expect.objectContaining({
        ok: true,
        nextSeq: 2,
        appendOffset: Buffer.byteLength(firstLine, 'utf8'),
      }),
    );

    const writer = createRunEventWriter({
      runId: 'run-5',
      eventsPath,
      nextSeq: replay.nextSeq,
      initialOffset: replay.appendOffset,
      clock: () => '2026-05-29T00:00:05.000Z',
    });
    const result = writer.append({ type: 'turn.started', turnId: 'turn-1' });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        offset: Buffer.byteLength(firstLine, 'utf8'),
      }),
    );
    expect(readLines(eventsPath).map((line) => JSON.parse(line) as RunEventEnvelope)).toEqual([
      first,
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        runId: 'run-5',
        seq: 2,
        id: 'run-5:2',
        type: 'turn.started',
        turnId: 'turn-1',
      }),
    ]);
  });

  it('truncates an unterminated valid canonical tail before appending', () => {
    const eventsPath = tempEventsPath();
    const first = {
      schema: RUN_EVENT_SCHEMA,
      runId: 'run-6',
      seq: 1,
      id: 'run-6:1',
      time: '2026-05-29T00:00:06.000Z',
      type: 'run.started',
    } satisfies RunEventEnvelope;
    const unterminatedSecond = {
      schema: RUN_EVENT_SCHEMA,
      runId: 'run-6',
      seq: 2,
      id: 'run-6:2',
      time: '2026-05-29T00:00:07.000Z',
      type: 'turn.started',
      turnId: 'turn-lost',
    } satisfies RunEventEnvelope;
    const firstLine = `${JSON.stringify(first)}\n`;
    writeFileSync(eventsPath, `${firstLine}${JSON.stringify(unterminatedSecond)}`);

    const replay = replayRunEvents({ runId: 'run-6', eventsPath });
    expect(replay).toEqual(
      expect.objectContaining({
        ok: true,
        nextSeq: 2,
        appendOffset: Buffer.byteLength(firstLine, 'utf8'),
        diagnostics: [expect.objectContaining({ code: 'malformed-final-line' })],
      }),
    );

    const writer = createRunEventWriter({
      runId: 'run-6',
      eventsPath,
      nextSeq: replay.nextSeq,
      initialOffset: replay.appendOffset,
      clock: () => '2026-05-29T00:00:08.000Z',
    });
    const result = writer.append({ type: 'turn.started', turnId: 'turn-2' });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(readLines(eventsPath).map((line) => JSON.parse(line) as RunEventEnvelope)).toEqual([
      first,
      expect.objectContaining({
        schema: RUN_EVENT_SCHEMA,
        runId: 'run-6',
        seq: 2,
        id: 'run-6:2',
        type: 'turn.started',
        turnId: 'turn-2',
      }),
    ]);
  });
});
