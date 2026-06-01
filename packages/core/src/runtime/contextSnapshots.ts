import type { RunEventAppendInput } from '../runEvents/types.js';
import type { RunEventAppendResult } from '../runEvents/writer.js';

export interface ContextSnapshotHost {
  readonly currentContext: () => Record<string, unknown>;
  readonly subscribeSnapshots: (listener: () => void) => () => void;
}

export interface ContextSnapshotRecorder {
  readonly recordInitialContext: () => RunEventAppendResult | null;
  readonly start: () => void;
  readonly close: () => void;
}

export function publicContextFromRunContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (key.startsWith('__aharness_')) continue;
    if (key === 'aharness') continue;
    out[key] = value;
  }
  return out;
}

export function createContextSnapshotRecorder(options: {
  readonly host: ContextSnapshotHost;
  readonly record: (input: RunEventAppendInput) => RunEventAppendResult;
}): ContextSnapshotRecorder {
  let lastSerialized: string | null = null;
  let recordedAny = false;
  let started = false;
  let closed = false;
  let scheduled = false;
  let latestContext: Record<string, unknown> | null = null;
  let unsubscribe: (() => void) | undefined;

  function readSerializablePublicContext(): {
    readonly context: Record<string, unknown>;
    readonly serialized: string;
  } | null {
    const context = publicContextFromRunContext(options.host.currentContext());
    try {
      return { context, serialized: JSON.stringify(context) };
    } catch {
      return null;
    }
  }

  function appendCurrentSnapshot(forceInitial: boolean): RunEventAppendResult | null {
    if (closed) return null;
    const read = readSerializablePublicContext();
    if (read === null) return null;
    if (!forceInitial && recordedAny && read.serialized === lastSerialized) return null;
    const type = recordedAny ? 'context.changed' : 'context.initialized';
    const result = options.record({ type, data: { context: read.context } });
    if (result.ok) {
      recordedAny = true;
      lastSerialized = read.serialized;
    }
    return result;
  }

  function flush(): void {
    scheduled = false;
    if (closed || latestContext === null) return;
    latestContext = null;
    appendCurrentSnapshot(false);
  }

  function scheduleFlush(): void {
    if (closed) return;
    latestContext = publicContextFromRunContext(options.host.currentContext());
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  return {
    recordInitialContext() {
      return appendCurrentSnapshot(true);
    },
    start() {
      if (started || closed) return;
      started = true;
      unsubscribe = options.host.subscribeSnapshots(scheduleFlush);
    },
    close() {
      if (closed) return;
      closed = true;
      latestContext = null;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
