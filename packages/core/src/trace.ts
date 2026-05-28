/**
 * Trace emitter — `@aharness/core` companion to `events.ts`, defined by
 * `docs/SPEC_TRACE.md`.
 *
 * Each daemon launch gets its own `<runDir>/trace-<launchTs>.json`
 * (Chrome Trace Event JSON Object Format streaming variant). The file
 * is opened append-only at launch with the prologue `{"traceEvents":[\n`
 * and metadata events, then events are appended one per line separated
 * by `,\n`. The file is never closed at the JSON level; Perfetto parses
 * up to the last comma.
 *
 * Per-launch filenames sidestep the multi-instance ambiguity of one-file-
 * per-runDir: a restart writes a new file rather than mixing two runtime
 * lifetimes into one trace.
 *
 * The daemon owns one emitter per launch. A process-global runDir-keyed
 * registry lets `writeArtifact` (called from inside user FSM actions)
 * find the right emitter without threading it through XState input.
 *
 * Privacy posture mirrors `events.jsonl` (§4.9 of `SPEC_SDK.md`):
 *   - hook payloads digested by default; full only with HARNESS_TRACE_FULL=1
 *   - submit payloads NEVER written, even with HARNESS_TRACE_FULL=1
 *   - artifact contents NEVER written
 *   - subagent prompts/results digested by default; full with HARNESS_TRACE_FULL=1
 */
// Default import so vitest `vi.spyOn(fs, 'writeSync')` intercepts our calls.
// The ESM namespace object is non-configurable and cannot be spied on; the
// CommonJS default export's properties are writable/configurable.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { canonicalJson } from './internal/canonicalJson.js';
import type { RunDir } from './types.js';

export interface TraceOptions {
  readonly fullPayloads?: boolean;
  readonly flushEvery?: number;
  /** ms between idle-timer flushes. Default 1000. Set to 0 to disable. */
  readonly flushIntervalMs?: number;
  /** Override `Date.now()` for deterministic launch timestamps in tests. */
  readonly launchTs?: number;
  /**
   * FSM file basename (e.g. `"foo.fsm.ts"`). When provided, emitted as a
   * `process_labels` metadata event in the prologue so Perfetto can
   * disambiguate multiple per-launch trace files in one runDir
   * (SPEC_TRACE §4.10). Caller passes a basename — emitter does not parse
   * paths.
   */
  readonly fsmFile?: string;
}

export interface TraceFlowEnd {
  readonly tid: number;
  readonly ts: number;
}

export interface LeafDiff {
  readonly exited: readonly string[];
  readonly entered: readonly string[];
}

export interface TraceEmitter {
  readonly path: string;
  state(stateId: string, phase: 'enter' | 'exit', ts: number, args?: Record<string, unknown>): void;
  transition(
    from: string,
    to: string,
    eventType: string,
    ts: number,
    args?: Record<string, unknown>,
  ): void;
  hook(name: string, ts: number, payloadDigest: string, sizeBytes: number, payload?: unknown): void;
  submit(stateId: string, ts: number, accepted: boolean, error?: string): void;
  artifact(relPath: string, ts: number, bytes: number): void;
  subagentBegin(
    subagentRunId: string,
    label: string,
    ts: number,
    promptDigest: string,
    promptBytes: number,
    prompt?: unknown,
  ): void;
  subagentEnd(
    subagentRunId: string,
    ts: number,
    resultDigest: string,
    resultBytes: number,
    result?: unknown,
  ): void;
  flow(from: TraceFlowEnd, to: TraceFlowEnd, id: string): void;
  counter(name: string, ts: number, value: number): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface RegistryEntry {
  readonly emitter: TraceEmitter;
  currentStateEnterTs: number | null;
  /** Total framework events seen (hooks + submits + artifacts), per spec §4.9. */
  eventCount: number;
}

const FIXED_TRACK_NAMES: ReadonlyArray<readonly [number, string]> = [
  [1, 'FSM state'],
  [2, 'Transitions'],
  [3, 'Hooks'],
  [4, 'Submits'],
  [5, 'Artifacts'],
  [6, 'Counters'],
];

const SUBAGENT_BASE_TID = 100;
const DEFAULT_FLUSH_EVERY = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/**
 * Process-global registry of active trace emitters, keyed by `runDir.root`.
 *
 * Module-level mutable state — this is intentional.
 *
 * Each daemon process runs a single Harness run, so a process-global
 * map is the right scope. The runDir-keyed lookup lets `writeArtifact`
 * (called from inside user FSM actions) find its emitter without
 * threading it through XState input. There is no second consumer in
 * the same process to disambiguate from.
 *
 * Tests that exercise the trace emitter across cases must call
 * `resetTraceRegistryForTesting()` between cases.
 *
 * @internal
 */
const REGISTRY = new Map<string, RegistryEntry>();

/**
 * Test-only escape hatch. Clears all registered emitters. Production
 * code should call `clearTraceEmitter(runDir)` for the run-scoped
 * cleanup.
 *
 * @internal
 */
export function resetTraceRegistryForTesting(): void {
  REGISTRY.clear();
}

export function getTraceEmitter(runDir: RunDir): TraceEmitter | undefined {
  return REGISTRY.get(runDir.root)?.emitter;
}

export function getCurrentStateEnterTs(runDir: RunDir): number | null {
  return REGISTRY.get(runDir.root)?.currentStateEnterTs ?? null;
}

export function setCurrentStateEnterTs(runDir: RunDir, ts: number | null): void {
  const entry = REGISTRY.get(runDir.root);
  if (entry) entry.currentStateEnterTs = ts;
}

export function clearTraceEmitter(runDir: RunDir): void {
  REGISTRY.delete(runDir.root);
}

export function incrementEventCount(runDir: RunDir): number {
  const entry = REGISTRY.get(runDir.root);
  if (!entry) return 0;
  entry.eventCount += 1;
  return entry.eventCount;
}

export function getEventCount(runDir: RunDir): number {
  return REGISTRY.get(runDir.root)?.eventCount ?? 0;
}

export function openTrace(runDir: RunDir, opts: TraceOptions = {}): TraceEmitter {
  if (process.env['HARNESS_TRACE'] === '0') {
    const noop = makeNoopEmitter();
    REGISTRY.set(runDir.root, { emitter: noop, currentStateEnterTs: null, eventCount: 0 });
    return noop;
  }
  const fullPayloads = opts.fullPayloads ?? process.env['HARNESS_TRACE_FULL'] === '1';
  const flushEvery = opts.flushEvery ?? DEFAULT_FLUSH_EVERY;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const launchTs = opts.launchTs ?? Date.now();
  const emitter = makeEmitter({
    runDir,
    fullPayloads,
    flushEvery,
    flushIntervalMs,
    launchTs,
    ...(opts.fsmFile !== undefined ? { fsmFile: opts.fsmFile } : {}),
  });
  REGISTRY.set(runDir.root, { emitter, currentStateEnterTs: null, eventCount: 0 });
  return emitter;
}

function makeNoopEmitter(): TraceEmitter {
  return {
    path: '',
    state() {},
    transition() {},
    hook() {},
    submit() {},
    artifact() {},
    subagentBegin() {},
    subagentEnd() {},
    flow() {},
    counter() {},
    flush() {
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

export function digestPayload(value: unknown): string {
  const hex = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `sha256:${hex.slice(0, 16)}`;
}

export function pidFromRunId(runId: string): number {
  const hex = createHash('sha256').update(runId).digest('hex').slice(0, 8);
  return parseInt(hex, 16) & 0x7fffffff;
}

export function diffActiveLeaves(prev: ReadonlySet<string>, next: ReadonlySet<string>): LeafDiff {
  const exited: string[] = [];
  const entered: string[] = [];
  for (const id of prev) if (!next.has(id)) exited.push(id);
  for (const id of next) if (!prev.has(id)) entered.push(id);
  return { exited, entered };
}

interface MakeEmitterOpts {
  readonly runDir: RunDir;
  readonly fullPayloads: boolean;
  readonly flushEvery: number;
  readonly flushIntervalMs: number;
  readonly launchTs: number;
  readonly fsmFile?: string;
}

interface EmitterState {
  readonly path: string;
  readonly pid: number;
  readonly fullPayloads: boolean;
  readonly flushEvery: number;
  buffer: string[];
  fd: number | null;
  subagentTids: Map<string, number>;
  nextSubagentTid: number;
  closed: boolean;
  /** Set once we've logged the ENOSPC stderr line. */
  enospcReported: boolean;
  timer: NodeJS.Timeout | null;
}

function makeEmitter(opts: MakeEmitterOpts): TraceEmitter {
  const path = join(opts.runDir.root, `trace-${opts.launchTs}.json`);
  const fd = fs.openSync(path, 'a');
  // Write the prologue + metadata events synchronously through the held fd.
  fs.writeSync(fd, '{"traceEvents":[\n');

  const state: EmitterState = {
    path,
    pid: pidFromRunId(opts.runDir.runId),
    fullPayloads: opts.fullPayloads,
    flushEvery: opts.flushEvery,
    buffer: [],
    fd,
    subagentTids: new Map(),
    nextSubagentTid: SUBAGENT_BASE_TID,
    closed: false,
    enospcReported: false,
    timer: null,
  };

  // Prologue + fixed-track metadata events are written directly through the
  // held fd, bypassing the buffer. They are framework setup, not user events,
  // so they should not count against `flushEvery`.
  const prologueEvents: Array<Record<string, unknown>> = [
    {
      ph: 'M',
      pid: state.pid,
      tid: 0,
      name: 'process_name',
      args: { name: `harness/${opts.runDir.runId}` },
    },
    {
      ph: 'M',
      pid: state.pid,
      tid: 0,
      name: 'process_sort_index',
      args: { sort_index: 0 },
    },
  ];
  // SPEC_TRACE §4.10: surface the FSM basename in Perfetto's process row
  // so multiple per-launch trace files in one runDir are distinguishable.
  if (opts.fsmFile !== undefined) {
    prologueEvents.push({
      ph: 'M',
      pid: state.pid,
      tid: 0,
      name: 'process_labels',
      args: { labels: `fsmFile=${opts.fsmFile}` },
    });
  }
  for (const [tid, threadName] of FIXED_TRACK_NAMES) {
    prologueEvents.push({
      ph: 'M',
      pid: state.pid,
      tid,
      name: 'thread_name',
      args: { name: threadName },
    });
  }
  fs.writeSync(fd, prologueEvents.map((ev) => JSON.stringify(ev)).join(',\n') + ',\n');

  if (opts.flushIntervalMs > 0) {
    state.timer = setInterval(() => flushSync(state), opts.flushIntervalMs);
    // Don't keep the event loop alive solely for the trace timer.
    state.timer.unref?.();
  }

  return {
    get path() {
      return state.path;
    },
    state(stateId, phase, ts, args) {
      const ph = phase === 'enter' ? 'B' : 'E';
      push(state, {
        ph,
        pid: state.pid,
        tid: 1,
        ts,
        name: stateId,
        cat: 'state',
        args: args ?? {},
      });
    },
    transition(from, to, eventType, ts, args) {
      push(state, {
        ph: 'i',
        pid: state.pid,
        tid: 2,
        ts,
        s: 'g',
        name: `${from}→${to}`,
        cat: 'transition',
        args: { event: eventType, ...(args ?? {}) },
      });
    },
    hook(name, ts, payloadDigest, sizeBytes, payload) {
      const args: Record<string, unknown> = { payloadDigest, sizeBytes };
      if (state.fullPayloads && payload !== undefined) args['payload'] = payload;
      push(state, {
        ph: 'i',
        pid: state.pid,
        tid: 3,
        ts,
        s: 't',
        name,
        cat: 'hook',
        args,
      });
    },
    submit(stateId, ts, accepted, error) {
      push(state, {
        ph: 'i',
        pid: state.pid,
        tid: 4,
        ts,
        s: 't',
        name: `submit_${stateId}`,
        cat: accepted ? 'submit' : 'submit-rejected',
        args: { stateId, accepted, error: error ?? null },
      });
    },
    artifact(relPath, ts, bytes) {
      push(state, {
        ph: 'i',
        pid: state.pid,
        tid: 5,
        ts,
        s: 't',
        name: relPath,
        cat: 'artifact',
        args: { relPath, bytes },
      });
    },
    subagentBegin(subagentRunId, label, ts, promptDigest, promptBytes, prompt) {
      let tid = state.subagentTids.get(subagentRunId);
      if (tid === undefined) {
        tid = state.nextSubagentTid++;
        state.subagentTids.set(subagentRunId, tid);
        push(state, {
          ph: 'M',
          pid: state.pid,
          tid,
          name: 'thread_name',
          args: { name: `Subagent: ${label}` },
        });
      }
      const args: Record<string, unknown> = { promptDigest, promptBytes };
      if (state.fullPayloads && prompt !== undefined) args['prompt'] = prompt;
      push(state, {
        ph: 'B',
        pid: state.pid,
        tid,
        ts,
        name: label,
        cat: 'subagent',
        args,
      });
    },
    subagentEnd(subagentRunId, ts, resultDigest, resultBytes, result) {
      const tid = state.subagentTids.get(subagentRunId);
      if (tid === undefined) return;
      const args: Record<string, unknown> = { resultDigest, resultBytes };
      if (state.fullPayloads && result !== undefined) args['result'] = result;
      push(state, { ph: 'E', pid: state.pid, tid, ts, cat: 'subagent', args });
    },
    flow(from, to, id) {
      push(state, {
        ph: 's',
        pid: state.pid,
        tid: from.tid,
        ts: from.ts,
        id,
        name: 'flow',
        cat: 'flow',
      });
      push(state, {
        ph: 'f',
        pid: state.pid,
        tid: to.tid,
        ts: to.ts,
        id,
        name: 'flow',
        cat: 'flow',
        bp: 'e',
      });
    },
    counter(name, ts, value) {
      push(state, {
        ph: 'C',
        pid: state.pid,
        tid: 6,
        ts,
        name,
        args: { value },
      });
    },
    flush(): Promise<void> {
      flushSync(state);
      return Promise.resolve();
    },
    close(): Promise<void> {
      if (state.closed) return Promise.resolve();
      flushSync(state);
      state.closed = true;
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      if (state.fd !== null) {
        fs.closeSync(state.fd);
        state.fd = null;
      }
      return Promise.resolve();
    },
  };
}

function push(state: EmitterState, event: Record<string, unknown>): void {
  if (state.closed) return;
  state.buffer.push(JSON.stringify(event));
  if (state.buffer.length >= state.flushEvery) flushSync(state);
}

function flushSync(state: EmitterState): void {
  if (state.buffer.length === 0) return;
  if (state.fd === null) {
    state.buffer = [];
    return;
  }
  const chunk = state.buffer.join(',\n') + ',\n';
  state.buffer = [];
  try {
    fs.writeSync(state.fd, chunk);
    fs.fsyncSync(state.fd);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOSPC') {
      if (!state.enospcReported) {
        process.stderr.write('trace: disk full, disabling further trace writes\n');
        state.enospcReported = true;
      }
      state.buffer = [];
      state.closed = true;
      return;
    }
    throw err;
  }
}
