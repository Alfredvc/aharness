import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Download, Share2 } from 'lucide-react';
import type { RunCompletionStats } from '../types/events.js';
import {
  RunCompletionShareCard,
  type RunCompletionShareCardProps,
  type RunCompletionShareCardTimeBucket,
} from './RunCompletionShareCard.js';
import {
  buildRunCompletionShareCardProps,
  copyShareCardPng,
  downloadShareCardPng,
  type ShareCardCopyStatus,
  type ShareCardDownloadStatus,
} from './shareCardExport.js';

type FinalOverviewModalProps = {
  completionStats: RunCompletionStats | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

const numberFormat = new Intl.NumberFormat('en-US');
const compactNumberFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
});
const finalOverviewDialogStyle = {
  border: 0,
  margin: 0,
  maxHeight: 'none',
  maxWidth: 'none',
} as const;
const dialogBackdropButtonStyle = {
  background: 'transparent',
  border: 0,
  cursor: 'default',
  inset: 0,
  padding: 0,
  position: 'fixed',
  zIndex: 0,
} as const;
const dialogContentStyle = {
  position: 'relative',
  zIndex: 1,
} as const;

export function FinalOverviewModal({
  completionStats,
  loading,
  error,
  onClose,
}: FinalOverviewModalProps) {
  const outcome = completionStats?.outcome ?? 'unknown';
  const tone = outcome === 'success' ? 'success' : outcome === 'failure' ? 'failure' : 'partial';
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const shareProps = completionStats ? buildRunCompletionShareCardProps(completionStats) : null;
  const [exporting, setExporting] = useState<'copy' | 'download' | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (typeof dialog.showModal === 'function') {
      try {
        if (!dialog.open) dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }

    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, []);

  useEffect(() => {
    if (!toastMessage) return undefined;
    const timeout = window.setTimeout(() => setToastMessage(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [toastMessage]);

  const handleDownloadSummary = () => {
    const svg = svgRef.current;
    if (!svg || !shareProps) return;
    setExporting('download');
    void downloadShareCardPng(svg, shareProps)
      .then((status) => setToastMessage(downloadStatusLabel(status)))
      .finally(() => setExporting(null));
  };
  const handleCopySummary = () => {
    const svg = svgRef.current;
    if (!svg || !shareProps) return;
    setExporting('copy');
    void copyShareCardPng(svg)
      .then((status) => setToastMessage(copyStatusLabel(status)))
      .finally(() => setExporting(null));
  };

  return (
    <dialog
      ref={dialogRef}
      className="final-overview-layer"
      aria-modal="true"
      aria-labelledby="final-overview-title"
      style={finalOverviewDialogStyle}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section className="final-overview-modal" data-outcome={tone} style={dialogContentStyle}>
        <header className="final-overview-head">
          <div className="final-overview-head-title">
            <p className="final-overview-eyebrow">Final overview</p>
            <h2 id="final-overview-title">{titleForStats(completionStats, loading)}</h2>
          </div>
          <div className="final-overview-head-actions">
            {shareProps ? (
              <>
                <IconButton
                  label="Download summary image"
                  disabled={exporting !== null}
                  onClick={handleDownloadSummary}
                >
                  <Download aria-hidden="true" size={17} strokeWidth={2.4} />
                </IconButton>
                <IconButton
                  label="Copy summary image to clipboard"
                  disabled={exporting !== null}
                  onClick={handleCopySummary}
                >
                  <Share2 aria-hidden="true" size={17} strokeWidth={2.4} />
                </IconButton>
              </>
            ) : null}
            <button className="final-overview-close" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        {shareProps ? <RunCompletionShareCardRef props={shareProps} svgRef={svgRef} /> : null}
        {toastMessage ? (
          <output className="final-overview-toast" aria-live="polite">
            {toastMessage}
          </output>
        ) : null}

        {error ? <p className="final-overview-error">{error}</p> : null}
        {loading && completionStats === null ? (
          <div className="final-overview-loading">Loading exact summary...</div>
        ) : null}

        {completionStats ? <StatsBody shareProps={shareProps} stats={completionStats} /> : null}
      </section>
      <button
        type="button"
        aria-label="Close final overview"
        style={dialogBackdropButtonStyle}
        tabIndex={-1}
        onClick={onClose}
      />
    </dialog>
  );
}

function StatsBody({
  shareProps,
  stats,
}: {
  shareProps: RunCompletionShareCardProps | null;
  stats: RunCompletionStats;
}) {
  const dashboard = buildDashboardDisplay(stats, shareProps);

  return (
    <div className="final-overview-body">
      {stats.outcome === 'unknown' ? (
        <p className="final-overview-note">Partial terminal summary from available run events.</p>
      ) : null}

      <section
        className="final-overview-hero-grid"
        data-tone={dashboard.tone}
        aria-label="Run outcome"
      >
        <HeroCard
          label="Terminal state"
          value={dashboard.statusValue}
          detail={dashboard.statusDetail}
          tone={dashboard.tone}
        />
        <HeroCard
          label="Total time"
          value={dashboard.totalTimeLabel}
          detail={dashboard.timeDetailLabel}
        />
        <div className="final-overview-hero-metrics" aria-label="Run counts">
          <HeroMetric
            label="Turns"
            value={dashboard.totalTurnCountLabel}
            detail={dashboard.turnDetailLabel}
          />
          <HeroMetric
            label="Transitions"
            value={dashboard.transitionCountLabel}
            detail={`${dashboard.freshClearCountLabel} fresh clears`}
          />
          <HeroMetric
            label="Changes"
            value={dashboard.filesChangedLabel}
            detail={dashboard.changeDetailLabel}
          />
        </div>
      </section>

      <section className="final-overview-token-panel" aria-label="Token burn">
        <div className="final-overview-panel-head">
          <h3>Token burn</h3>
          <span>Cache hit {dashboard.cacheHitPercentageLabel}</span>
        </div>
        <div className="final-overview-token-content">
          <div className="final-overview-token-primary">
            <strong>{dashboard.totalTokenLabel}</strong>
            <p>
              {dashboard.mainTokenLabel} main / {dashboard.subthreadTokenLabel} subthread
            </p>
          </div>
          <div className="final-overview-token-breakdown">
            <div className="final-overview-token-metric-row">
              <TokenMetric label="Input" value={dashboard.inputTokenLabel} />
              <TokenMetric label="Cached input" value={dashboard.cachedInputTokenLabel} />
              <TokenMetric label="Output" value={dashboard.outputTokenLabel} />
              <TokenMetric label="Reasoning" value={dashboard.reasoningTokenLabel} />
            </div>
            <div className="final-overview-token-split">
              <div className="final-overview-token-track" aria-hidden="true">
                <span style={{ width: `${dashboard.mainTokenPercent}%` }} />
                <span style={{ width: `${dashboard.subthreadTokenPercent}%` }} />
              </div>
              <div className="final-overview-token-legend">
                <span>
                  <i aria-hidden="true" />
                  Main {dashboard.mainTokenPercentageLabel}
                </span>
                <span>
                  <i aria-hidden="true" />
                  Subthreads {dashboard.subthreadTokenPercentageLabel}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="final-overview-state-grid">
        <StateBucketPanel
          title="Time by state"
          eyebrow="top buckets"
          rows={dashboard.stateBuckets}
          metric="time"
        />
        <StateBucketPanel
          title="Tokens by state"
          eyebrow="total tokens"
          rows={dashboard.tokenStateBuckets}
          metric="tokens"
        />
      </div>

      <section className="final-overview-activity-panel" aria-label="State activity">
        <div className="final-overview-panel-head">
          <h3>State activity</h3>
          <span>events / transitions / turns</span>
        </div>
        <div className="final-overview-activity-table">
          <div className="final-overview-activity-row">
            <span>State</span>
            <span>Events</span>
            <span>Transitions</span>
            <span>Turns</span>
          </div>
          {dashboard.stateBuckets.map((bucket) => (
            <div className="final-overview-activity-row" key={`activity-${bucket.label}`}>
              <b>{bucket.label}</b>
              <strong>{bucket.eventCountLabel}</strong>
              <strong>{bucket.transitionCountLabel}</strong>
              <strong>{bucket.turnCountLabel}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="final-overview-detail-grid" aria-label="Run details">
        <DetailCell label="Started" value={dashboard.startedAtLabel} />
        <DetailCell label="Ended" value={dashboard.endedAtLabel} />
        <DetailCell label="Bucket source" value={dashboard.bucketSourceLabel} />
        <DetailCell label="Work delta" value={dashboard.lineDeltaDetailLabel} />
      </section>
    </div>
  );
}

function RunCompletionShareCardRef({
  props,
  svgRef,
}: {
  props: RunCompletionShareCardProps;
  svgRef: MutableRefObject<SVGSVGElement | null>;
}) {
  return (
    <div
      ref={(node) => {
        svgRef.current = node?.querySelector('svg') ?? null;
      }}
      className="final-overview-share-card-source"
      aria-hidden="true"
      hidden
    >
      <RunCompletionShareCard {...props} />
    </div>
  );
}

function downloadStatusLabel(status: ShareCardDownloadStatus): string {
  if (status.ok) return 'Summary image download ready.';
  if (status.kind === 'encoding-failed') return 'Summary image download failed while encoding.';
  return 'Summary image download failed because the image dimensions changed.';
}

function copyStatusLabel(status: ShareCardCopyStatus): string {
  if (status.ok) return 'summary copied to clipboard';
  if (status.kind === 'unsupported') return 'Copy Summary Image unsupported in this browser.';
  if (status.kind === 'permission-denied') return 'Copy Summary Image denied by the browser.';
  if (status.kind === 'encoding-failed') return 'Copy Summary Image failed while encoding.';
  return 'Copy Summary Image failed because the image dimensions changed.';
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="final-overview-icon-button"
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function HeroCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'failure' | 'partial' | 'success';
}) {
  return (
    <div className="final-overview-hero-card" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function HeroMetric({ detail, label, value }: { detail: string; label: string; value: string }) {
  return (
    <div className="final-overview-hero-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function TokenMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="final-overview-token-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StateBucketPanel({
  title,
  eyebrow,
  rows,
  metric,
}: {
  title: string;
  eyebrow: string;
  rows: ReadonlyArray<FinalOverviewStateBucketDisplay>;
  metric: 'time' | 'tokens';
}) {
  return (
    <section className="final-overview-state-panel" data-metric={metric}>
      <div className="final-overview-panel-head">
        <h3>{title}</h3>
        <span>{eyebrow}</span>
      </div>
      <div className="final-overview-state-list">
        {rows.length > 0 ? (
          rows.map((bucket) => (
            <StateBucketRow bucket={bucket} key={`${metric}-${bucket.label}`} metric={metric} />
          ))
        ) : (
          <p>No state buckets were available in the recorded run events.</p>
        )}
      </div>
    </section>
  );
}

function StateBucketRow({
  bucket,
  metric,
}: {
  bucket: FinalOverviewStateBucketDisplay;
  metric: 'time' | 'tokens';
}) {
  const percent = metric === 'time' ? bucket.timePercent : bucket.tokenPercent;
  const label =
    metric === 'time'
      ? `${bucket.percentageLabel} / ${bucket.durationLabel}`
      : bucket.tokenTotalLabel;

  return (
    <div className="final-overview-state-row">
      <b>{bucket.label}</b>
      <div className="final-overview-state-track" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span>{label}</span>
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="final-overview-detail-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function titleForStats(stats: RunCompletionStats | null, loading: boolean): string {
  if (stats === null) return loading ? 'Loading summary' : 'Summary unavailable';
  return stats.fsmDisplayName;
}

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

function formatCompactNumber(value: number): string {
  const normalized = Math.max(0, value);
  if (normalized < 1_000_000) return formatNumber(normalized);
  return compactNumberFormat.format(normalized);
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

type FinalOverviewDashboardDisplay = {
  tone: 'failure' | 'partial' | 'success';
  statusLabel: string;
  statusValue: string;
  statusDetail: string;
  totalTimeLabel: string;
  timeDetailLabel: string;
  totalTurnCountLabel: string;
  turnDetailLabel: string;
  transitionCountLabel: string;
  freshClearCountLabel: string;
  totalTokenLabel: string;
  inputTokenLabel: string;
  cachedInputTokenLabel: string;
  outputTokenLabel: string;
  reasoningTokenLabel: string;
  cacheHitPercentageLabel: string;
  mainTokenLabel: string;
  subthreadTokenLabel: string;
  mainTokenPercent: number;
  subthreadTokenPercent: number;
  mainTokenPercentageLabel: string;
  subthreadTokenPercentageLabel: string;
  mainTurnCountLabel: string;
  subthreadTurnCountLabel: string;
  filesChangedLabel: string;
  linesChangedLabel: string;
  lineDeltaDetailLabel: string;
  changeDetailLabel: string;
  bucketSourceLabel: string;
  startedAtLabel: string;
  endedAtLabel: string;
  stateBuckets: ReadonlyArray<FinalOverviewStateBucketDisplay>;
  tokenStateBuckets: ReadonlyArray<FinalOverviewStateBucketDisplay>;
};

type FinalOverviewStateBucketDisplay = RunCompletionShareCardTimeBucket & {
  timePercent: number;
  tokenPercent: number;
  tokenTotalLabel: string;
  eventCountLabel: string;
  transitionCountLabel: string;
  turnCountLabel: string;
};

function buildDashboardDisplay(
  stats: RunCompletionStats,
  shareProps: RunCompletionShareCardProps | null,
): FinalOverviewDashboardDisplay {
  const status = statusForOutcome(stats.outcome);
  const stateBuckets = buildStateBucketDisplay(stats, 'time');
  const tokenStateBuckets = buildStateBucketDisplay(stats, 'tokens');
  const timeDetailLabel = buildTimeDetailLabel(stateBuckets);
  const turnDetailLabel = buildTurnDetailLabel(stats);
  const timestampLabels = buildTimestampLabels(stats);
  const bucketSourceLabel = stats.topologyStatus === 'available' ? 'FSM topology' : 'Event buckets';
  if (shareProps) {
    return {
      ...status,
      totalTimeLabel: shareProps.totalTimeLabel,
      timeDetailLabel,
      totalTurnCountLabel: shareProps.totalTurnCountLabel,
      turnDetailLabel,
      transitionCountLabel: shareProps.transitionCountLabel,
      freshClearCountLabel: shareProps.freshClearCountLabel,
      totalTokenLabel: shareProps.totalTokenLabel,
      inputTokenLabel: formatCompactNumber(stats.tokenTotals.inputTokens),
      cachedInputTokenLabel: formatCompactNumber(stats.tokenTotals.cachedInputTokens),
      outputTokenLabel: shareProps.outputTokenLabel,
      reasoningTokenLabel: formatCompactNumber(stats.tokenTotals.reasoningOutputTokens),
      cacheHitPercentageLabel: shareProps.cacheHitPercentageLabel,
      mainTokenLabel: shareProps.mainTokenLabel,
      subthreadTokenLabel: shareProps.subthreadTokenLabel,
      mainTokenPercent: shareProps.mainTokenPercent,
      subthreadTokenPercent: shareProps.subthreadTokenPercent,
      mainTokenPercentageLabel: shareProps.mainTokenPercentageLabel,
      subthreadTokenPercentageLabel: shareProps.subthreadTokenPercentageLabel,
      mainTurnCountLabel: shareProps.mainTurnCountLabel,
      subthreadTurnCountLabel: shareProps.subthreadTurnCountLabel,
      filesChangedLabel: shareProps.filesChangedLabel,
      linesChangedLabel: shareProps.linesChangedLabel,
      lineDeltaDetailLabel: shareProps.lineDeltaDetailLabel,
      changeDetailLabel: buildChangeDetailLabel(stats, shareProps.linesChangedLabel),
      bucketSourceLabel,
      ...timestampLabels,
      stateBuckets,
      tokenStateBuckets,
    };
  }

  const totalTokens = stats.tokenTotals.totalTokens;
  const mainTokenPercent = safePercent(stats.tokenTotals.mainTokens, totalTokens);
  const subthreadTokenPercent = safePercent(stats.tokenTotals.subthreadTokens, totalTokens);
  const workDelta = buildFallbackWorkDeltaLabels(stats);

  return {
    ...status,
    totalTimeLabel: formatDuration(stats.duration.elapsedMs),
    timeDetailLabel,
    totalTurnCountLabel: formatNumber(stats.mainTurnCount + stats.subthreadTurnCount),
    turnDetailLabel,
    transitionCountLabel: formatNumber(stats.transitionCount),
    freshClearCountLabel: formatNumber(stats.freshClearCount),
    totalTokenLabel: formatCompactNumber(totalTokens),
    inputTokenLabel: formatCompactNumber(stats.tokenTotals.inputTokens),
    cachedInputTokenLabel: formatCompactNumber(stats.tokenTotals.cachedInputTokens),
    outputTokenLabel: formatCompactNumber(stats.tokenTotals.outputTokens),
    reasoningTokenLabel: formatCompactNumber(stats.tokenTotals.reasoningOutputTokens),
    cacheHitPercentageLabel: formatPercent(
      safePercent(stats.tokenTotals.cachedInputTokens, stats.tokenTotals.inputTokens),
    ),
    mainTokenLabel: formatCompactNumber(stats.tokenTotals.mainTokens),
    subthreadTokenLabel: formatCompactNumber(stats.tokenTotals.subthreadTokens),
    mainTokenPercent,
    subthreadTokenPercent,
    mainTokenPercentageLabel: formatPercent(mainTokenPercent),
    subthreadTokenPercentageLabel: formatPercent(subthreadTokenPercent),
    mainTurnCountLabel: formatNumber(stats.mainTurnCount),
    subthreadTurnCountLabel: formatNumber(stats.subthreadTurnCount),
    ...workDelta,
    changeDetailLabel: buildChangeDetailLabel(stats, workDelta.linesChangedLabel),
    bucketSourceLabel,
    ...timestampLabels,
    stateBuckets,
    tokenStateBuckets,
  };
}

function statusForOutcome(
  outcome: RunCompletionStats['outcome'],
): Pick<FinalOverviewDashboardDisplay, 'statusDetail' | 'statusLabel' | 'statusValue' | 'tone'> {
  if (outcome === 'success') {
    return {
      tone: 'success',
      statusLabel: 'Run completed',
      statusValue: 'DONE',
      statusDetail: 'Terminal success',
    };
  }
  if (outcome === 'failure') {
    return {
      tone: 'failure',
      statusLabel: 'Run failed',
      statusValue: 'HALT',
      statusDetail: 'Terminal failure',
    };
  }
  return {
    tone: 'partial',
    statusLabel: 'Partial summary',
    statusValue: 'N/A',
    statusDetail: 'Incomplete terminal evidence',
  };
}

function buildFallbackWorkDeltaLabels(
  stats: RunCompletionStats,
): Pick<
  FinalOverviewDashboardDisplay,
  'filesChangedLabel' | 'lineDeltaDetailLabel' | 'linesChangedLabel'
> {
  if (stats.workDelta.status !== 'available') {
    return {
      filesChangedLabel: 'N/A',
      linesChangedLabel: 'N/A',
      lineDeltaDetailLabel: 'N/A',
    };
  }

  const linesChanged = stats.workDelta.linesAdded + stats.workDelta.linesDeleted;
  return {
    filesChangedLabel: formatNumber(stats.workDelta.filesChanged),
    linesChangedLabel: formatNumber(linesChanged),
    lineDeltaDetailLabel: `+${formatNumber(stats.workDelta.linesAdded)} / -${formatNumber(
      stats.workDelta.linesDeleted,
    )}`,
  };
}

function buildStateBucketDisplay(
  stats: RunCompletionStats,
  sortBy: 'time' | 'tokens',
): FinalOverviewStateBucketDisplay[] {
  const sortedBuckets = Array.from(stats.stateBuckets);
  sortedBuckets.sort((left, right) => {
    const leftValue = sortBy === 'time' ? left.elapsedMs : left.tokenTotals.totalTokens;
    const rightValue = sortBy === 'time' ? right.elapsedMs : right.tokenTotals.totalTokens;
    return rightValue - leftValue;
  });
  const visible = sortedBuckets.slice(0, 3);
  const remaining = sortedBuckets.slice(3);
  const timeDenominator =
    stats.duration.elapsedMs !== undefined
      ? stats.duration.elapsedMs
      : stats.stateBuckets.reduce((total, bucket) => total + bucket.elapsedMs, 0);
  const tokenDenominator = stats.stateBuckets.reduce(
    (total, bucket) => total + bucket.tokenTotals.totalTokens,
    0,
  );
  const rows = visible.map((bucket) =>
    buildStateBucketRow(bucket, timeDenominator, tokenDenominator),
  );

  if (remaining.length > 0) {
    const other = remaining.reduce(
      (acc, bucket) => ({
        elapsedMs: acc.elapsedMs + bucket.elapsedMs,
        eventCount: acc.eventCount + bucket.eventCount,
        transitionCount: acc.transitionCount + bucket.transitionCount,
        turnCount: acc.turnCount + bucket.mainTurnCount + bucket.subthreadTurnCount,
        totalTokens: acc.totalTokens + bucket.tokenTotals.totalTokens,
      }),
      { elapsedMs: 0, eventCount: 0, transitionCount: 0, totalTokens: 0, turnCount: 0 },
    );
    const timePercent = safePercent(other.elapsedMs, timeDenominator);
    const tokenPercent = safePercent(other.totalTokens, tokenDenominator);
    rows.push({
      label: 'Other states',
      durationLabel: formatDuration(other.elapsedMs),
      percent: timePercent,
      percentageLabel: formatPercent(timePercent),
      timePercent,
      tokenPercent,
      tokenTotalLabel: formatCompactNumber(other.totalTokens),
      eventCountLabel: formatNumber(other.eventCount),
      transitionCountLabel: formatNumber(other.transitionCount),
      turnCountLabel: formatNumber(other.turnCount),
    });
  }

  return rows;
}

function buildStateBucketRow(
  bucket: RunCompletionStats['stateBuckets'][number],
  timeDenominator: number,
  tokenDenominator: number,
): FinalOverviewStateBucketDisplay {
  const timePercent = safePercent(bucket.elapsedMs, timeDenominator);
  const tokenPercent = safePercent(bucket.tokenTotals.totalTokens, tokenDenominator);
  return {
    label: displayBucketLabel(bucket.label),
    durationLabel: formatDuration(bucket.elapsedMs),
    percent: timePercent,
    percentageLabel: formatPercent(timePercent),
    timePercent,
    tokenPercent,
    tokenTotalLabel: formatCompactNumber(bucket.tokenTotals.totalTokens),
    eventCountLabel: formatNumber(bucket.eventCount),
    transitionCountLabel: formatNumber(bucket.transitionCount),
    turnCountLabel: formatNumber(bucket.mainTurnCount + bucket.subthreadTurnCount),
  };
}

function displayBucketLabel(value: string): string {
  const slashLeaf = value.split('/').at(-1) ?? value;
  const dotLeaf = slashLeaf.split('.').at(-1) ?? slashLeaf;
  return dotLeaf || value;
}

function buildTimeDetailLabel(rows: ReadonlyArray<FinalOverviewStateBucketDisplay>): string {
  const top = rows[0];
  if (!top) return 'No state timing';
  return `${top.durationLabel} in ${top.label}`;
}

function buildTurnDetailLabel(stats: RunCompletionStats): string {
  if (stats.subthreadTurnCount === 0) return 'main thread only';
  return `${formatNumber(stats.mainTurnCount)} main / ${formatNumber(
    stats.subthreadTurnCount,
  )} subthread`;
}

function buildChangeDetailLabel(stats: RunCompletionStats, linesChangedLabel: string): string {
  if (stats.workDelta.status !== 'available') return 'work delta unavailable';
  return `${linesChangedLabel} lines`;
}

function buildTimestampLabels(
  stats: RunCompletionStats,
): Pick<FinalOverviewDashboardDisplay, 'endedAtLabel' | 'startedAtLabel'> {
  return {
    startedAtLabel: formatTimestamp(stats.duration.startedAt),
    endedAtLabel: formatTimestamp(stats.duration.endedAt),
  };
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function safePercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

function formatPercent(value: number): string {
  return `${value}%`;
}
