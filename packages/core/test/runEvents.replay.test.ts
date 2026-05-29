import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RUN_EVENT_SCHEMA, replayRunEvents, scanRunEvents } from '../src/runEvents/index.js';
import type { RunEventEnvelope } from '../src/runEvents/index.js';

const RUN_ID = 'run-replay';

function tempEventsPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'aharness-run-events-replay-')), 'events.jsonl');
}

function canonical(seq: number, overrides: Partial<RunEventEnvelope> = {}): RunEventEnvelope {
  const runId = overrides.runId ?? RUN_ID;
  return {
    schema: RUN_EVENT_SCHEMA,
    runId,
    seq,
    id: `${runId}:${seq}`,
    time: `2026-05-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
    type: 'test.event',
    ...overrides,
  };
}

function jsonl(...values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + '\n';
}

describe('canonical run event replay', () => {
  it('treats missing and empty files as an empty canonical log', () => {
    const missingPath = tempEventsPath();
    const missing = scanRunEvents({ runId: RUN_ID, eventsPath: missingPath });
    expect(missing).toEqual({
      ok: true,
      events: [],
      diagnostics: [],
      latestSeq: 0,
      nextSeq: 1,
      appendOffset: 0,
    });

    writeFileSync(missingPath, '');
    const empty = replayRunEvents({ runId: RUN_ID, eventsPath: missingPath });
    expect(empty).toEqual({
      ok: true,
      events: [],
      diagnostics: [],
      latestSeq: 0,
      nextSeq: 1,
      appendOffset: 0,
    });
  });

  it('replays valid canonical lines in file order with byte offsets and next sequence', () => {
    const eventsPath = tempEventsPath();
    const first = JSON.stringify(canonical(1, { type: 'run.started', data: { label: 'alpha' } }));
    const second = JSON.stringify(
      canonical(2, { type: 'state.changed', data: { label: 'snowman' } }),
    );
    writeFileSync(eventsPath, `${first}\n${second}\n`);

    const result = replayRunEvents({ runId: RUN_ID, eventsPath });

    expect(result.ok).toBe(true);
    expect(result.latestSeq).toBe(2);
    expect(result.nextSeq).toBe(3);
    expect(result.diagnostics).toEqual([]);
    expect(result.events.map((entry) => entry.event.id)).toEqual(['run-replay:1', 'run-replay:2']);
    expect(result.events.map((entry) => entry.offset)).toEqual([
      0,
      Buffer.byteLength(`${first}\n`, 'utf8'),
    ]);
    expect(result.events[1]?.lineBytes).toBe(Buffer.byteLength(`${second}\n`, 'utf8'));
    expect(result.appendOffset).toBe(Buffer.byteLength(`${first}\n${second}\n`, 'utf8'));
  });

  it('ignores only a malformed final line and preserves the latest valid sequence', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, `${jsonl(canonical(1), canonical(2))}{ "schema":`);

    const result = replayRunEvents({ runId: RUN_ID, eventsPath });

    expect(result.ok).toBe(true);
    expect(result.events.map((entry) => entry.event.seq)).toEqual([1, 2]);
    expect(result.latestSeq).toBe(2);
    expect(result.nextSeq).toBe(3);
    expect(result.appendOffset).toBe(Buffer.byteLength(jsonl(canonical(1), canonical(2)), 'utf8'));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'malformed-final-line',
      }),
    ]);
  });

  it('reports malformed non-final lines as corruption', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(
      eventsPath,
      `${JSON.stringify(canonical(1))}\nnot json\n${JSON.stringify(canonical(2))}\n`,
    );

    const result = replayRunEvents({ runId: RUN_ID, eventsPath });

    expect(result.ok).toBe(false);
    expect(result.events.map((entry) => entry.event.seq)).toEqual([1]);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: 'corruption',
        code: 'malformed-non-final-line',
      }),
    );
  });

  it('reports a newline-terminated malformed final line as corruption', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, `${JSON.stringify(canonical(1))}\n{ "schema":\n`);

    const result = replayRunEvents({ runId: RUN_ID, eventsPath });

    expect(result.ok).toBe(false);
    expect(result.events.map((entry) => entry.event.seq)).toEqual([1]);
    expect(result.appendOffset).toBe(
      Buffer.byteLength(`${JSON.stringify(canonical(1))}\n`, 'utf8'),
    );
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: 'corruption',
        code: 'malformed-non-final-line',
      }),
    );
  });

  it.each([
    ['old audit shape', { ts: '2026-05-29T00:00:00.000Z', kind: 'artifact' }, 'legacy-audit-entry'],
    ['wrong schema', { ...canonical(1), schema: 'other.schema' }, 'wrong-schema'],
    ['wrong run id', canonical(1, { runId: 'other-run', id: 'other-run:1' }), 'wrong-run-id'],
    ['id mismatch', canonical(1, { id: `${RUN_ID}:2` }), 'id-seq-mismatch'],
    ['missing type', { ...canonical(1), type: undefined }, 'missing-required-field'],
    ['invalid seq', { ...canonical(1), seq: 1.5, id: `${RUN_ID}:1.5` }, 'invalid-seq'],
    ['invalid time', { ...canonical(1), time: '' }, 'invalid-time'],
    ['invalid type', { ...canonical(1), type: '' }, 'invalid-type'],
    ['invalid correlation field', { ...canonical(1), threadId: 42 }, 'invalid-correlation-field'],
    ['invalid payload', { ...canonical(1), data: 'not-an-object' }, 'invalid-payload-field'],
  ])('rejects %s as canonical-log corruption', (_name, line, code) => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, jsonl(line));

    const result = replayRunEvents({ runId: RUN_ID, eventsPath });

    expect(result.ok).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: 'corruption',
        code,
      }),
    );
  });

  it('rejects old audit-shape lines even when the final line is not newline terminated', () => {
    const eventsPath = tempEventsPath();
    writeFileSync(eventsPath, JSON.stringify({ ts: '2026-05-29T00:00:00.000Z', kind: 'artifact' }));

    const result = replayRunEvents({ runId: RUN_ID, eventsPath });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: 'corruption',
        code: 'legacy-audit-entry',
      }),
    );
  });

  it('reports duplicate and decreasing sequence numbers instead of sorting them away', () => {
    const duplicatePath = tempEventsPath();
    writeFileSync(duplicatePath, jsonl(canonical(1), canonical(1)));

    const duplicate = replayRunEvents({ runId: RUN_ID, eventsPath: duplicatePath });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'non-increasing-seq',
        seq: 1,
      }),
    );

    const decreasingPath = tempEventsPath();
    writeFileSync(decreasingPath, jsonl(canonical(2), canonical(1)));

    const decreasing = replayRunEvents({ runId: RUN_ID, eventsPath: decreasingPath });
    expect(decreasing.ok).toBe(false);
    expect(decreasing.diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'non-increasing-seq',
        seq: 1,
      }),
    );
  });
});
