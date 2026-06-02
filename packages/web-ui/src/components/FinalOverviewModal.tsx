import type { RunCompletionStats } from '../types/events.js';

type FinalOverviewModalProps = {
  completionStats: RunCompletionStats | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

const numberFormat = new Intl.NumberFormat('en-US');

export function FinalOverviewModal({
  completionStats,
  loading,
  error,
  onClose,
}: FinalOverviewModalProps) {
  const outcome = completionStats?.outcome ?? 'unknown';
  const tone = outcome === 'success' ? 'success' : outcome === 'failure' ? 'failure' : 'partial';
  return (
    <div className="final-overview-layer" onClick={onClose}>
      <section
        className="final-overview-modal"
        data-outcome={tone}
        role="dialog"
        aria-modal="true"
        aria-labelledby="final-overview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="final-overview-head">
          <div>
            <p className="final-overview-eyebrow">Final overview</p>
            <h2 id="final-overview-title">{titleForStats(completionStats, loading)}</h2>
          </div>
          <button className="final-overview-close" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {error ? <p className="final-overview-error">{error}</p> : null}
        {loading && completionStats === null ? (
          <div className="final-overview-loading">Loading exact summary...</div>
        ) : null}

        {completionStats ? <StatsBody stats={completionStats} /> : null}
      </section>
    </div>
  );
}

function StatsBody({ stats }: { stats: RunCompletionStats }) {
  const topBuckets = stats.stateBuckets.slice(0, 6);
  const remainingBuckets = stats.stateBuckets.slice(6);
  const otherBucket =
    remainingBuckets.length === 0
      ? null
      : remainingBuckets.reduce(
          (acc, bucket) => ({
            elapsedMs: acc.elapsedMs + bucket.elapsedMs,
            eventCount: acc.eventCount + bucket.eventCount,
            transitionCount: acc.transitionCount + bucket.transitionCount,
            mainTurnCount: acc.mainTurnCount + bucket.mainTurnCount,
            subthreadTurnCount: acc.subthreadTurnCount + bucket.subthreadTurnCount,
            totalTokens: acc.totalTokens + bucket.tokenTotals.totalTokens,
          }),
          {
            elapsedMs: 0,
            eventCount: 0,
            transitionCount: 0,
            mainTurnCount: 0,
            subthreadTurnCount: 0,
            totalTokens: 0,
          },
        );

  return (
    <div className="final-overview-body">
      {stats.outcome === 'unknown' ? (
        <p className="final-overview-note">Partial terminal summary from available run events.</p>
      ) : null}

      <div className="final-overview-metrics" aria-label="Run completion metrics">
        <Metric label="Duration" value={formatDuration(stats.duration.elapsedMs)} />
        <Metric label="Transitions" value={formatNumber(stats.transitionCount)} />
        <Metric label="Fresh clears" value={formatNumber(stats.freshClearCount)} />
        <Metric label="Main turns" value={formatNumber(stats.mainTurnCount)} />
        <Metric label="Subthread turns" value={formatNumber(stats.subthreadTurnCount)} />
        <Metric label="Topology" value={stats.topologyStatus} />
      </div>

      <section className="final-overview-section">
        <h3>Tokens</h3>
        <div className="final-overview-metrics compact">
          <Metric label="Total" value={formatNumber(stats.tokenTotals.totalTokens)} />
          <Metric label="Input" value={formatNumber(stats.tokenTotals.inputTokens)} />
          <Metric label="Cached" value={formatNumber(stats.tokenTotals.cachedInputTokens)} />
          <Metric label="Output" value={formatNumber(stats.tokenTotals.outputTokens)} />
          <Metric label="Reasoning" value={formatNumber(stats.tokenTotals.reasoningOutputTokens)} />
          <Metric label="Main" value={formatNumber(stats.tokenTotals.mainTokens)} />
          <Metric label="Subthreads" value={formatNumber(stats.tokenTotals.subthreadTokens)} />
          <Metric label="Unattributed" value={formatNumber(stats.tokenTotals.unattributedTokens)} />
        </div>
      </section>

      <section className="final-overview-section">
        <h3>Committed Work</h3>
        {stats.workDelta.status === 'available' ? (
          <div className="final-overview-metrics compact">
            <Metric label="Files" value={formatNumber(stats.workDelta.filesChanged)} />
            <Metric label="Added" value={formatNumber(stats.workDelta.linesAdded)} />
            <Metric label="Deleted" value={formatNumber(stats.workDelta.linesDeleted)} />
          </div>
        ) : (
          <div className="final-overview-unavailable">
            <span>N/A</span>
            <p>Committed work delta was unavailable from recorded git facts.</p>
          </div>
        )}
      </section>

      <section className="final-overview-section">
        <h3>Top State Buckets</h3>
        <div className="final-overview-buckets" role="table" aria-label="Top state buckets">
          <div className="final-overview-bucket header" role="row">
            <span>State</span>
            <span>Time</span>
            <span>Events</span>
            <span>Turns</span>
            <span>Tokens</span>
          </div>
          {topBuckets.map((bucket) => (
            <div className="final-overview-bucket" role="row" key={bucket.id}>
              <span>{bucket.label}</span>
              <span>{formatDuration(bucket.elapsedMs)}</span>
              <span>{formatNumber(bucket.eventCount)}</span>
              <span>{formatNumber(bucket.mainTurnCount + bucket.subthreadTurnCount)}</span>
              <span>{formatNumber(bucket.tokenTotals.totalTokens)}</span>
            </div>
          ))}
          {otherBucket ? (
            <div className="final-overview-bucket" role="row">
              <span>Other states</span>
              <span>{formatDuration(otherBucket.elapsedMs)}</span>
              <span>{formatNumber(otherBucket.eventCount)}</span>
              <span>
                {formatNumber(otherBucket.mainTurnCount + otherBucket.subthreadTurnCount)}
              </span>
              <span>{formatNumber(otherBucket.totalTokens)}</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="final-overview-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function titleForStats(stats: RunCompletionStats | null, loading: boolean): string {
  if (stats === null) return loading ? 'Loading summary' : 'Summary unavailable';
  if (stats.outcome === 'success') return `${stats.fsmDisplayName} completed`;
  if (stats.outcome === 'failure') return `${stats.fsmDisplayName} failed`;
  return `${stats.fsmDisplayName} summary`;
}

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

function formatDuration(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) return 'N/A';
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${hours}h ${restMinutes.toString().padStart(2, '0')}m`;
}
