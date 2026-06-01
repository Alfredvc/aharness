import { describe, expect, it } from 'vitest';

import {
  createContextSnapshotRecorder,
  publicContextFromRunContext,
} from '../src/runtime/contextSnapshots.js';
import { RUN_EVENT_SCHEMA, type RunEventAppendInput } from '../src/runEvents/types.js';
import type { RunEventAppendResult } from '../src/runEvents/writer.js';

type SnapshotListener = () => void;

function createFakeContextHost(initial: Record<string, unknown>) {
  let context = initial;
  const listeners = new Set<SnapshotListener>();
  return {
    currentContext: () => context,
    subscribeSnapshots(listener: SnapshotListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setContext(next: Record<string, unknown>) {
      context = next;
      for (const listener of listeners) listener();
    },
  };
}

function okAppend(type: string): RunEventAppendResult {
  return {
    ok: true,
    envelope: {
      schema: RUN_EVENT_SCHEMA,
      runId: 'run-context',
      seq: 1,
      id: 'run-context:1',
      time: '2026-06-01T00:00:00.000Z',
      type,
    },
    offset: 0,
    lineBytes: 1,
  };
}

function failedAppend(type: string): RunEventAppendResult {
  return {
    ok: false,
    warning: {
      code: 'append-failed',
      message: 'disk full',
      eventsPath: '/tmp/events.jsonl',
      offset: 0,
      envelope: {
        schema: RUN_EVENT_SCHEMA,
        runId: 'run-context',
        seq: 1,
        id: 'run-context:1',
        time: '2026-06-01T00:00:00.000Z',
        type,
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('context snapshot recorder', () => {
  it('filters framework-owned context fields from public context snapshots', () => {
    expect(
      publicContextFromRunContext({
        visible: 1,
        __aharness_visitCount: { plan: 1 },
        aharness: { runId: 'run-1' },
      }),
    ).toEqual({ visible: 1 });
  });

  it('records initialization and changed snapshots', async () => {
    const host = createFakeContextHost({ n: 1 });
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({ n: 2 });
    await flushMicrotasks();

    expect(recorded).toEqual([
      { type: 'context.initialized', data: { context: { n: 1 } } },
      { type: 'context.changed', data: { context: { n: 2 } } },
    ]);
  });

  it('emits context.initialized for an empty initial context', () => {
    const host = createFakeContextHost({});
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();

    expect(recorded).toEqual([{ type: 'context.initialized', data: { context: {} } }]);
  });

  it('does not emit context.changed for identical serialized public context', async () => {
    const host = createFakeContextHost({ n: 1 });
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({ n: 1 });
    await flushMicrotasks();

    expect(recorded).toEqual([{ type: 'context.initialized', data: { context: { n: 1 } } }]);
  });

  it('does not emit context.changed for framework-only context changes', async () => {
    const host = createFakeContextHost({
      n: 1,
      __aharness_visitCount: { plan: 1 },
      aharness: { runId: 'run-1' },
    });
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({
      n: 1,
      __aharness_visitCount: { plan: 2 },
      aharness: { runId: 'run-2' },
    });
    await flushMicrotasks();

    expect(recorded).toEqual([{ type: 'context.initialized', data: { context: { n: 1 } } }]);
  });

  it('skips BigInt and circular references without advancing the previous baseline', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const host = createFakeContextHost({ n: 1 });
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({ n: 2, big: 1n });
    await flushMicrotasks();
    host.setContext(circular);
    await flushMicrotasks();
    host.setContext({ n: 2 });
    await flushMicrotasks();

    expect(recorded).toEqual([
      { type: 'context.initialized', data: { context: { n: 1 } } },
      { type: 'context.changed', data: { context: { n: 2 } } },
    ]);
  });

  it('does not advance the baseline after append failure', async () => {
    const host = createFakeContextHost({ n: 1 });
    const recorded: RunEventAppendInput[] = [];
    let failNextChange = true;
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        if (input.type === 'context.changed' && failNextChange) {
          failNextChange = false;
          return failedAppend(input.type);
        }
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({ n: 2 });
    await flushMicrotasks();
    host.setContext({ n: 2 });
    await flushMicrotasks();

    expect(recorded).toEqual([
      { type: 'context.initialized', data: { context: { n: 1 } } },
      { type: 'context.changed', data: { context: { n: 2 } } },
      { type: 'context.changed', data: { context: { n: 2 } } },
    ]);
  });

  it('coalesces multiple synchronous changes before a microtask flush', async () => {
    const host = createFakeContextHost({ n: 1 });
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({ n: 2 });
    host.setContext({ n: 3 });
    host.setContext({ n: 4 });
    await flushMicrotasks();

    expect(recorded).toEqual([
      { type: 'context.initialized', data: { context: { n: 1 } } },
      { type: 'context.changed', data: { context: { n: 4 } } },
    ]);
  });

  it('close unsubscribes and makes a pending microtask flush a no-op', async () => {
    const host = createFakeContextHost({ n: 1 });
    const recorded: RunEventAppendInput[] = [];
    const recorder = createContextSnapshotRecorder({
      host,
      record: (input) => {
        recorded.push(input);
        return okAppend(input.type);
      },
    });

    recorder.recordInitialContext();
    recorder.start();
    host.setContext({ n: 2 });
    recorder.close();
    await flushMicrotasks();
    host.setContext({ n: 3 });
    await flushMicrotasks();

    expect(recorded).toEqual([{ type: 'context.initialized', data: { context: { n: 1 } } }]);
  });
});
