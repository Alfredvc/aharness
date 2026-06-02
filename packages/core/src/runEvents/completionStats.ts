import { extname } from 'node:path';

import type {
  GitFactUnavailableReason,
  RunCompletionStateBucket,
  RunCompletionStats,
  RunCompletionTokenTotals,
  RunCompletionTopologyStatus,
  RunCompletionWorkDelta,
  RunEventEnvelope,
  RunEventWithOffset,
} from './types.js';

interface RunMetaLike {
  readonly fsmFile?: unknown;
}

interface CompletionStatsTopology {
  readonly nodes?: unknown;
}

interface TopologyNode {
  readonly id: string;
  readonly label?: string;
  readonly kind?: string;
  readonly parent?: string;
}

type TokenSnapshot = RunCompletionTokenTotals;

type MutableTokenTotals = {
  -readonly [K in keyof RunCompletionTokenTotals]: RunCompletionTokenTotals[K];
};

interface MutableBucket {
  id: string;
  label: string;
  path?: string;
  elapsedMs: number;
  eventCount: number;
  transitionCount: number;
  mainTurnCount: number;
  subthreadTurnCount: number;
  tokenTotals: MutableTokenTotals;
}

interface TerminalEvidence {
  readonly seq: number;
  readonly outcome: RunCompletionStats['outcome'];
  readonly event: RunEventEnvelope;
}

const ZERO_TOKENS: RunCompletionTokenTotals = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

const GIT_FACT_UNAVAILABLE_REASONS = new Set<GitFactUnavailableReason>([
  'not-a-git-repository',
  'git-unavailable',
  'timeout',
  'head-unavailable',
  'object-unavailable',
  'diff-unavailable',
  'probe-failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dataOf(event: RunEventEnvelope): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function timestampMs(value: unknown): number | undefined {
  const text = readString(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

function safeDisplayText(value: string, fallback: string): string {
  const normalized = value
    .replace(/[^\p{L}\p{N}._ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 80) : fallback;
}

function safeIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'state'
  );
}

export function safeFsmDisplayName(runMeta: RunMetaLike): string {
  const raw = readString(runMeta.fsmFile);
  if (raw === undefined) return 'FSM Run';
  const file = raw.split(/[\\/]/).at(-1) ?? raw;
  const ext = extname(file);
  const stem = ext.length > 0 ? file.slice(0, -ext.length) : file;
  return safeDisplayText(stem, 'FSM Run');
}

function statePath(event: RunEventEnvelope): string | undefined {
  const data = dataOf(event);
  if (event.type === 'state.changed') {
    return readString(data['path']) ?? readString(data['to']);
  }
  return readString(data['path']);
}

function stateVisitId(event: RunEventEnvelope): string | undefined {
  return event.stateVisitId ?? readString(dataOf(event)['stateVisitId']);
}

function isTerminalStateChange(event: RunEventEnvelope): boolean {
  if (event.type !== 'state.changed') return false;
  const kind = readString(dataOf(event)['kind']);
  return kind === 'terminal' || kind === 'final';
}

function terminalEvidence(events: ReadonlyArray<RunEventWithOffset>): TerminalEvidence | null {
  let latest: TerminalEvidence | null = null;
  for (const { event } of events) {
    if (event.type === 'run.completed') {
      latest = { seq: event.seq, outcome: 'success', event };
    } else if (event.type === 'run.failed') {
      latest = { seq: event.seq, outcome: 'failure', event };
    } else if (isTerminalStateChange(event)) {
      latest = { seq: event.seq, outcome: 'unknown', event };
    }
  }
  return latest;
}

function readTopologyNodes(
  topology: CompletionStatsTopology | undefined,
): Map<string, TopologyNode> {
  const nodes = new Map<string, TopologyNode>();
  if (!isRecord(topology) || !Array.isArray(topology['nodes'])) return nodes;
  for (const raw of topology['nodes']) {
    if (!isRecord(raw)) continue;
    const id = readString(raw['id']);
    if (id === undefined) continue;
    const label = readString(raw['label']);
    const kind = readString(raw['kind']);
    const parent = readString(raw['parent']);
    nodes.set(id, {
      id,
      ...(label !== undefined ? { label } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(parent !== undefined ? { parent } : {}),
    });
  }
  return nodes;
}

function nearestKnownPath(path: string, nodes: ReadonlyMap<string, TopologyNode>): string {
  let current = path;
  for (;;) {
    if (nodes.has(current)) return current;
    const dot = current.lastIndexOf('.');
    if (dot < 0) return path;
    current = current.slice(0, dot);
  }
}

function topologyBucketPath(path: string, nodes: ReadonlyMap<string, TopologyNode>): string {
  const known = nearestKnownPath(path, nodes);
  let current: string | undefined = known;
  while (current !== undefined) {
    const node = nodes.get(current);
    if (node?.kind === 'embed') return current;
    const parent = node?.parent;
    if (parent !== undefined && nodes.get(parent)?.kind === 'embed') return parent;
    current = parent;
  }

  const segments = path.split('.');
  if (segments.length > 1) {
    const rootChild = `${segments[0]}.${segments[1]}`;
    if (nodes.has(rootChild)) return rootChild;
  }
  return known;
}

function fallbackBucketPath(path: string): string {
  return path.split('.')[0] ?? path;
}

function makeBucketId(
  path: string | undefined,
  topologyStatus: RunCompletionTopologyStatus,
): string {
  if (path === undefined) return 'unattributed';
  return `${topologyStatus === 'available' ? 'state' : 'fallback'}:${safeIdSegment(path)}`;
}

function bucketLabel(
  path: string | undefined,
  topologyStatus: RunCompletionTopologyStatus,
  nodes: ReadonlyMap<string, TopologyNode>,
): string {
  if (path === undefined) return 'Unattributed';
  if (topologyStatus === 'available') {
    const node = nodes.get(path);
    return safeDisplayText(node?.label ?? path.split('.').at(-1) ?? path, 'State');
  }
  return safeDisplayText(path, 'State');
}

function createBucket(
  path: string | undefined,
  topologyStatus: RunCompletionTopologyStatus,
  nodes: ReadonlyMap<string, TopologyNode>,
): MutableBucket {
  return {
    id: makeBucketId(path, topologyStatus),
    label: bucketLabel(path, topologyStatus, nodes),
    ...(path !== undefined ? { path } : {}),
    elapsedMs: 0,
    eventCount: 0,
    transitionCount: 0,
    mainTurnCount: 0,
    subthreadTurnCount: 0,
    tokenTotals: { ...ZERO_TOKENS },
  };
}

function bucketForPath(
  buckets: Map<string, MutableBucket>,
  path: string | undefined,
  topologyStatus: RunCompletionTopologyStatus,
  nodes: ReadonlyMap<string, TopologyNode>,
): MutableBucket {
  if (path === undefined) {
    const existing = buckets.get('unattributed');
    if (existing !== undefined) return existing;
    const created = createBucket(undefined, topologyStatus, nodes);
    buckets.set(created.id, created);
    return created;
  }
  const bucketPath =
    topologyStatus === 'available' ? topologyBucketPath(path, nodes) : fallbackBucketPath(path);
  const key = makeBucketId(bucketPath, topologyStatus);
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  const created = createBucket(bucketPath, topologyStatus, nodes);
  buckets.set(key, created);
  return created;
}

function readTokenSnapshot(event: RunEventEnvelope): TokenSnapshot | null {
  if (event.type !== 'token.updated' && event.type !== 'subthread.token.updated') return null;
  const data = dataOf(event);
  const total = isRecord(data['total']) ? data['total'] : data;
  return {
    totalTokens: readNumber(total['totalTokens']) ?? 0,
    inputTokens: readNumber(total['inputTokens']) ?? 0,
    cachedInputTokens: readNumber(total['cachedInputTokens']) ?? 0,
    outputTokens: readNumber(total['outputTokens']) ?? 0,
    reasoningOutputTokens: readNumber(total['reasoningOutputTokens']) ?? 0,
  };
}

function addTokens(target: MutableTokenTotals, delta: RunCompletionTokenTotals): void {
  target.totalTokens += delta.totalTokens;
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
}

function tokenDelta(previous: TokenSnapshot | undefined, current: TokenSnapshot): TokenSnapshot {
  if (previous === undefined || current.totalTokens < previous.totalTokens) return current;
  return {
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
  };
}

function readThreadId(event: RunEventEnvelope): string | undefined {
  return event.threadId ?? readString(dataOf(event)['threadId']);
}

function readTurnId(event: RunEventEnvelope): string | undefined {
  return event.turnId ?? readString(dataOf(event)['turnId']);
}

function readItemId(event: RunEventEnvelope): string | undefined {
  return event.itemId ?? readString(dataOf(event)['itemId']);
}

function readParentTurnId(event: RunEventEnvelope): string | undefined {
  return readString(dataOf(event)['parentTurnId']);
}

function readParentItemId(event: RunEventEnvelope): string | undefined {
  return readString(dataOf(event)['parentItemId']);
}

function readParentThreadId(event: RunEventEnvelope): string | undefined {
  return readString(dataOf(event)['parentThreadId']);
}

function readGitFactUnavailableReason(value: unknown): GitFactUnavailableReason | 'missing' {
  const reason = readString(value);
  if (reason === undefined) return 'missing';
  return GIT_FACT_UNAVAILABLE_REASONS.has(reason as GitFactUnavailableReason)
    ? (reason as GitFactUnavailableReason)
    : 'missing';
}

function readWorkDelta(
  events: ReadonlyArray<RunEventWithOffset>,
  terminalSeq: number,
): RunCompletionWorkDelta {
  let latest: RunCompletionWorkDelta | null = null;
  for (const { event } of events) {
    if (event.seq > terminalSeq) break;
    if (event.type !== 'git.diff.recorded') continue;
    const data = dataOf(event);
    if (data['status'] === 'available') {
      latest = {
        status: 'available',
        filesChanged: readNumber(data['filesChanged']) ?? 0,
        linesAdded: readNumber(data['linesAdded']) ?? 0,
        linesDeleted: readNumber(data['linesDeleted']) ?? 0,
      };
    } else {
      latest = {
        status: 'unavailable',
        reason: readGitFactUnavailableReason(data['reason']),
      };
    }
  }
  return latest ?? { status: 'unavailable', reason: 'missing' };
}

function terminalEndTime(terminal: TerminalEvidence): string | undefined {
  return readString(dataOf(terminal.event)['endedAt']) ?? terminal.event.time;
}

function runStartTime(events: ReadonlyArray<RunEventWithOffset>): string | undefined {
  const started = events.find((entry) => entry.event.type === 'run.started')?.event;
  if (started === undefined) return undefined;
  return readString(dataOf(started)['startedAt']) ?? started.time;
}

function freezeBuckets(
  buckets: Map<string, MutableBucket>,
): ReadonlyArray<RunCompletionStateBucket> {
  return [...buckets.values()]
    .filter(
      (bucket) =>
        bucket.eventCount > 0 ||
        bucket.elapsedMs > 0 ||
        bucket.tokenTotals.totalTokens > 0 ||
        bucket.transitionCount > 0,
    )
    .sort(
      (left, right) => right.elapsedMs - left.elapsedMs || left.label.localeCompare(right.label),
    )
    .map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      ...(bucket.path !== undefined ? { path: bucket.path } : {}),
      elapsedMs: bucket.elapsedMs,
      eventCount: bucket.eventCount,
      transitionCount: bucket.transitionCount,
      mainTurnCount: bucket.mainTurnCount,
      subthreadTurnCount: bucket.subthreadTurnCount,
      tokenTotals: { ...bucket.tokenTotals },
    }));
}

export interface BuildRunCompletionStatsOptions<TRunMeta extends RunMetaLike = RunMetaLike> {
  readonly events: ReadonlyArray<RunEventWithOffset>;
  readonly getRunMeta: () => TRunMeta;
  readonly topology?: CompletionStatsTopology | null;
}

/**
 * Builds an API-safe terminal completion projection from normalized canonical
 * event data. This function intentionally ignores event `raw` payloads.
 */
export function buildRunCompletionStats(
  options: BuildRunCompletionStatsOptions,
): RunCompletionStats | null {
  const terminal = terminalEvidence(options.events);
  if (terminal === null) return null;

  const topologyNodes = readTopologyNodes(options.topology ?? undefined);
  const topologyStatus: RunCompletionTopologyStatus =
    topologyNodes.size > 0 ? 'available' : 'fallback';
  const buckets = new Map<string, MutableBucket>();
  const visitPaths = new Map<string, string>();
  const turnBuckets = new Map<string, string>();
  const itemBuckets = new Map<string, string>();
  const threadBuckets = new Map<string, string>();
  const tokenSnapshots = new Map<string, TokenSnapshot>();
  const tokenTotals = {
    ...ZERO_TOKENS,
    mainTokens: 0,
    subthreadTokens: 0,
    unattributedTokens: 0,
  };

  let activePath: string | undefined;
  let activeStartedMs: number | undefined;
  let transitionCount = 0;
  let freshClearCount = 0;
  let mainTurnCount = 0;
  let subthreadTurnCount = 0;

  const resolveBucket = (event: RunEventEnvelope): MutableBucket => {
    const explicitVisit = stateVisitId(event);
    const explicitPath = explicitVisit === undefined ? undefined : visitPaths.get(explicitVisit);
    const normalizedPath = statePath(event);
    if (explicitPath !== undefined || normalizedPath !== undefined) {
      return bucketForPath(buckets, explicitPath ?? normalizedPath, topologyStatus, topologyNodes);
    }

    const itemId = readItemId(event);
    const itemBucket = itemId === undefined ? undefined : itemBuckets.get(itemId);
    if (itemBucket !== undefined) {
      return (
        buckets.get(itemBucket) ?? bucketForPath(buckets, undefined, topologyStatus, topologyNodes)
      );
    }

    const turnId = readTurnId(event);
    const turnBucket = turnId === undefined ? undefined : turnBuckets.get(turnId);
    if (turnBucket !== undefined) {
      return (
        buckets.get(turnBucket) ?? bucketForPath(buckets, undefined, topologyStatus, topologyNodes)
      );
    }

    const parentItemBucket = itemBuckets.get(readParentItemId(event) ?? '');
    if (parentItemBucket !== undefined) {
      return (
        buckets.get(parentItemBucket) ??
        bucketForPath(buckets, undefined, topologyStatus, topologyNodes)
      );
    }
    const parentTurnBucket = turnBuckets.get(readParentTurnId(event) ?? '');
    if (parentTurnBucket !== undefined) {
      return (
        buckets.get(parentTurnBucket) ??
        bucketForPath(buckets, undefined, topologyStatus, topologyNodes)
      );
    }
    const parentThreadBucket = threadBuckets.get(readParentThreadId(event) ?? '');
    if (parentThreadBucket !== undefined) {
      return (
        buckets.get(parentThreadBucket) ??
        bucketForPath(buckets, undefined, topologyStatus, topologyNodes)
      );
    }

    const threadId = readThreadId(event);
    const threadBucket = threadId === undefined ? undefined : threadBuckets.get(threadId);
    if (threadBucket !== undefined) {
      return (
        buckets.get(threadBucket) ??
        bucketForPath(buckets, undefined, topologyStatus, topologyNodes)
      );
    }

    if (!event.type.startsWith('subthread.') && activePath !== undefined) {
      return bucketForPath(buckets, activePath, topologyStatus, topologyNodes);
    }
    return bucketForPath(buckets, undefined, topologyStatus, topologyNodes);
  };

  for (const { event } of options.events) {
    if (event.seq > terminal.seq) break;

    if (event.type === 'state.changed') {
      const nextPath = statePath(event);
      const nextStartedMs = timestampMs(event.time);
      if (
        activePath !== undefined &&
        activeStartedMs !== undefined &&
        nextStartedMs !== undefined
      ) {
        bucketForPath(buckets, activePath, topologyStatus, topologyNodes).elapsedMs += Math.max(
          0,
          nextStartedMs - activeStartedMs,
        );
      }
      if (nextPath !== undefined) {
        activePath = nextPath;
        activeStartedMs = nextStartedMs;
        const visitId = stateVisitId(event);
        if (visitId !== undefined) visitPaths.set(visitId, nextPath);
      }
      transitionCount += 1;
    }

    const bucket = resolveBucket(event);
    bucket.eventCount += 1;

    if (event.type === 'state.changed') bucket.transitionCount += 1;
    if (event.type === 'fresh_clear.boundary') freshClearCount += 1;

    const bucketId = bucket.id;
    const turnId = readTurnId(event);
    const itemId = readItemId(event);
    const threadId = readThreadId(event);
    if (turnId !== undefined) turnBuckets.set(turnId, bucketId);
    if (itemId !== undefined) itemBuckets.set(itemId, bucketId);
    if (threadId !== undefined) threadBuckets.set(threadId, bucketId);

    if (event.type === 'turn.started') {
      mainTurnCount += 1;
      bucket.mainTurnCount += 1;
    } else if (event.type === 'subthread.turn.started') {
      subthreadTurnCount += 1;
      bucket.subthreadTurnCount += 1;
    }

    const snapshot = readTokenSnapshot(event);
    if (snapshot !== null) {
      const tokenKey =
        event.type === 'subthread.token.updated'
          ? `sub:${readThreadId(event) ?? readTurnId(event) ?? event.id}`
          : `main:${readThreadId(event) ?? 'main'}`;
      const delta = tokenDelta(tokenSnapshots.get(tokenKey), snapshot);
      tokenSnapshots.set(tokenKey, snapshot);
      addTokens(tokenTotals, delta);
      addTokens(bucket.tokenTotals, delta);
      if (event.type === 'subthread.token.updated') {
        tokenTotals.subthreadTokens += delta.totalTokens;
      } else {
        tokenTotals.mainTokens += delta.totalTokens;
      }
      if (bucket.id === 'unattributed') tokenTotals.unattributedTokens += delta.totalTokens;
    }
  }

  const endedMs = timestampMs(terminalEndTime(terminal));
  if (activePath !== undefined && activeStartedMs !== undefined && endedMs !== undefined) {
    bucketForPath(buckets, activePath, topologyStatus, topologyNodes).elapsedMs += Math.max(
      0,
      endedMs - activeStartedMs,
    );
  }

  const startedAt = runStartTime(options.events);
  const endedAt = terminalEndTime(terminal);
  const startMs = timestampMs(startedAt);
  const endMs = timestampMs(endedAt);

  return {
    outcome: terminal.outcome,
    fsmDisplayName: safeFsmDisplayName(options.getRunMeta()),
    duration: {
      ...(startedAt !== undefined && startMs !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined && endMs !== undefined ? { endedAt } : {}),
      ...(startMs !== undefined && endMs !== undefined
        ? { elapsedMs: Math.max(0, endMs - startMs) }
        : {}),
    },
    transitionCount,
    freshClearCount,
    mainTurnCount,
    subthreadTurnCount,
    tokenTotals,
    topologyStatus,
    stateBuckets: freezeBuckets(buckets),
    workDelta: readWorkDelta(options.events, terminal.seq),
  };
}
