import { useEffect, useRef, useState, type MutableRefObject } from 'react';
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

function StatsBody({ stats }: { stats: RunCompletionStats }) {
  const shareProps = buildRunCompletionShareCardProps(stats);
  const dashboard = buildDashboardDisplay(stats, shareProps);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ShareCardCopyStatus | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<ShareCardDownloadStatus | null>(null);
  const [exporting, setExporting] = useState<'download' | 'copy' | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const shareSection = shareProps ? (
    <section className="final-overview-section final-overview-share-section">
      <div className="final-overview-share-row">
        <h3>Share Card</h3>
        <div className="final-overview-share-row-actions">
          <button
            className="final-overview-action"
            type="button"
            onClick={() => {
              setPreviewOpen((open) => !open);
              setCopyStatus(null);
              setDownloadStatus(null);
            }}
          >
            {previewOpen ? 'Hide preview' : 'Share'}
          </button>
          {previewOpen ? (
            <>
              <button
                className="final-overview-action"
                type="button"
                disabled={exporting !== null}
                onClick={() => {
                  const svg = svgRef.current;
                  if (!svg) return;
                  setExporting('download');
                  void downloadShareCardPng(svg, shareProps)
                    .then(setDownloadStatus)
                    .finally(() => setExporting(null));
                }}
              >
                {exporting === 'download' ? 'Downloading...' : 'Download PNG'}
              </button>
              <button
                className="final-overview-action"
                type="button"
                disabled={exporting !== null}
                onClick={() => {
                  const svg = svgRef.current;
                  if (!svg) return;
                  setExporting('copy');
                  void copyShareCardPng(svg)
                    .then(setCopyStatus)
                    .finally(() => setExporting(null));
                }}
              >
                {exporting === 'copy' ? 'Copying...' : 'Copy PNG'}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {previewOpen ? (
        <div className="final-overview-share-preview">
          <div className="final-overview-share-card-frame">
            <RunCompletionShareCardRef props={shareProps} svgRef={svgRef} />
          </div>
          <ShareExportStatus copyStatus={copyStatus} downloadStatus={downloadStatus} />
        </div>
      ) : null}
    </section>
  ) : null;

  if (previewOpen && shareSection) {
    return (
      <div className="final-overview-body" data-view="share-preview">
        {shareSection}
      </div>
    );
  }

  return (
    <div className="final-overview-body">
      {stats.outcome === 'unknown' ? (
        <p className="final-overview-note">Partial terminal summary from available run events.</p>
      ) : null}

      <section className="final-overview-dashboard-hero" aria-label="Run completion dashboard">
        <div className="final-overview-title-block">
          <span className="final-overview-outcome-pill" data-outcome={dashboard.tone}>
            {dashboard.statusLabel}
          </span>
          <h3>{stats.fsmDisplayName}</h3>
          <p>Display-safe terminal FSM run summary.</p>
        </div>
        <div className="final-overview-time-card">
          <span>Total time</span>
          <strong>{dashboard.totalTimeLabel}</strong>
          <p>{dashboard.totalTurnCountLabel} turns across main and subthreads</p>
          <small>
            {dashboard.transitionCountLabel} transitions / {dashboard.freshClearCountLabel} fresh
            clears
          </small>
        </div>
        <div className="final-overview-status-card">
          <div className="final-overview-status-ring" data-outcome={dashboard.tone}>
            <strong>{dashboard.statusValue}</strong>
            <span>{dashboard.statusLabel}</span>
          </div>
          <p>{dashboard.statusDetail}</p>
        </div>
      </section>

      {shareSection}

      <section className="final-overview-token-panel" aria-label="Token burn">
        <div className="final-overview-token-primary">
          <span>Token burn</span>
          <strong>{dashboard.totalTokenLabel}</strong>
          <p>total tokens</p>
        </div>
        <div className="final-overview-token-side">
          <div>
            <span>Output</span>
            <strong>{dashboard.outputTokenLabel}</strong>
          </div>
          <div>
            <span>Cache hit</span>
            <strong>{dashboard.cacheHitPercentageLabel}</strong>
          </div>
        </div>
        <div className="final-overview-token-split">
          <div className="final-overview-token-track" aria-hidden="true">
            <span style={{ width: `${dashboard.mainTokenPercent}%` }} />
            <span style={{ width: `${dashboard.subthreadTokenPercent}%` }} />
          </div>
          <div className="final-overview-token-legend">
            <span>Main {dashboard.mainTokenPercentageLabel}</span>
            <span>Subthreads {dashboard.subthreadTokenPercentageLabel}</span>
          </div>
        </div>
      </section>

      <section className="final-overview-tile-grid" aria-label="Run summary tiles">
        <DashboardTile
          label="Transitions"
          value={dashboard.transitionCountLabel}
          detail={`${dashboard.freshClearCountLabel} fresh clears`}
          accent="teal"
        />
        <DashboardTile
          label="Turns"
          value={dashboard.totalTurnCountLabel}
          detail={`${dashboard.mainTurnCountLabel} main / ${dashboard.subthreadTurnCountLabel} subthreads`}
          accent="blue"
        />
        <DashboardTile
          label="Committed Work"
          value={dashboard.filesChangedLabel}
          detail={
            stats.workDelta.status === 'available'
              ? `${dashboard.linesChangedLabel} lines changed (${dashboard.lineDeltaDetailLabel})`
              : 'Committed work delta was unavailable from recorded git facts.'
          }
          accent="amber"
        />
        <DashboardTile
          label="Lines changed"
          value={dashboard.linesChangedLabel}
          detail={
            stats.workDelta.status === 'available'
              ? dashboard.lineDeltaDetailLabel
              : 'N/A from recorded git facts'
          }
          accent="rose"
        />
      </section>

      <section className="final-overview-section">
        <h3>Where the time went</h3>
        <div className="final-overview-time-bars" aria-label="Where the time went">
          {dashboard.topTimeBuckets.length > 0 ? (
            dashboard.topTimeBuckets.map((bucket, index) => (
              <TimeBucketRow bucket={bucket} key={`${bucket.label}-${index}`} />
            ))
          ) : (
            <p>No state buckets were available in the recorded run events.</p>
          )}
        </div>
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
      className="final-overview-share-card"
      aria-label="Share-card preview"
    >
      <RunCompletionShareCard {...props} />
    </div>
  );
}

function ShareExportStatus({
  copyStatus,
  downloadStatus,
}: {
  copyStatus: ShareCardCopyStatus | null;
  downloadStatus: ShareCardDownloadStatus | null;
}) {
  if (!copyStatus && !downloadStatus) return null;
  return (
    <output className="final-overview-share-status">
      {downloadStatus ? <p>{downloadStatusLabel(downloadStatus)}</p> : null}
      {copyStatus ? <p>{copyStatusLabel(copyStatus)}</p> : null}
    </output>
  );
}

function downloadStatusLabel(status: ShareCardDownloadStatus): string {
  if (status.ok) return 'Download PNG ready.';
  if (status.kind === 'encoding-failed') return 'Download PNG failed while encoding.';
  return 'Download PNG failed because the image dimensions changed.';
}

function copyStatusLabel(status: ShareCardCopyStatus): string {
  if (status.ok) return 'Copy PNG complete.';
  if (status.kind === 'unsupported') return 'Copy PNG unsupported in this browser.';
  if (status.kind === 'permission-denied') return 'Copy PNG denied by the browser.';
  if (status.kind === 'encoding-failed') return 'Copy PNG failed while encoding.';
  return 'Copy PNG failed because the image dimensions changed.';
}

function DashboardTile({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail: string;
  accent: 'amber' | 'blue' | 'rose' | 'teal';
}) {
  return (
    <div className="final-overview-dashboard-tile" data-accent={accent}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function TimeBucketRow({ bucket }: { bucket: RunCompletionShareCardTimeBucket }) {
  return (
    <div className="final-overview-time-bar-row">
      <div>
        <strong>{bucket.label}</strong>
        <span>
          {bucket.percentageLabel} / {bucket.durationLabel}
        </span>
      </div>
      <div className="final-overview-time-bar-track" aria-hidden="true">
        <span style={{ width: `${bucket.percent}%` }} />
      </div>
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
  totalTurnCountLabel: string;
  transitionCountLabel: string;
  freshClearCountLabel: string;
  totalTokenLabel: string;
  outputTokenLabel: string;
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
  topTimeBuckets: ReadonlyArray<RunCompletionShareCardTimeBucket>;
};

function buildDashboardDisplay(
  stats: RunCompletionStats,
  shareProps: RunCompletionShareCardProps | null,
): FinalOverviewDashboardDisplay {
  const status = statusForOutcome(stats.outcome);
  if (shareProps) {
    return {
      ...status,
      totalTimeLabel: shareProps.totalTimeLabel,
      totalTurnCountLabel: shareProps.totalTurnCountLabel,
      transitionCountLabel: shareProps.transitionCountLabel,
      freshClearCountLabel: shareProps.freshClearCountLabel,
      totalTokenLabel: shareProps.totalTokenLabel,
      outputTokenLabel: shareProps.outputTokenLabel,
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
      topTimeBuckets: shareProps.topTimeBuckets,
    };
  }

  const totalTokens = stats.tokenTotals.totalTokens;
  const mainTokenPercent = safePercent(stats.tokenTotals.mainTokens, totalTokens);
  const subthreadTokenPercent = safePercent(stats.tokenTotals.subthreadTokens, totalTokens);
  const workDelta = buildFallbackWorkDeltaLabels(stats);

  return {
    ...status,
    totalTimeLabel: formatDuration(stats.duration.elapsedMs),
    totalTurnCountLabel: formatNumber(stats.mainTurnCount + stats.subthreadTurnCount),
    transitionCountLabel: formatNumber(stats.transitionCount),
    freshClearCountLabel: formatNumber(stats.freshClearCount),
    totalTokenLabel: formatCompactNumber(totalTokens),
    outputTokenLabel: formatCompactNumber(stats.tokenTotals.outputTokens),
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
    topTimeBuckets: buildFallbackTimeBuckets(stats),
  };
}

function statusForOutcome(
  outcome: RunCompletionStats['outcome'],
): Pick<FinalOverviewDashboardDisplay, 'statusDetail' | 'statusLabel' | 'statusValue' | 'tone'> {
  if (outcome === 'success') {
    return {
      tone: 'success',
      statusLabel: 'Run completed',
      statusValue: '100%',
      statusDetail: 'Reached a terminal success state.',
    };
  }
  if (outcome === 'failure') {
    return {
      tone: 'failure',
      statusLabel: 'Run failed',
      statusValue: 'HALT',
      statusDetail: 'Reached a terminal failure state.',
    };
  }
  return {
    tone: 'partial',
    statusLabel: 'Partial summary',
    statusValue: 'N/A',
    statusDetail: 'Terminal evidence was incomplete, so sharing is disabled.',
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

function buildFallbackTimeBuckets(stats: RunCompletionStats): RunCompletionShareCardTimeBucket[] {
  const visible = stats.stateBuckets.slice(0, 3);
  const remaining = stats.stateBuckets.slice(3);
  const denominator =
    stats.duration.elapsedMs !== undefined
      ? stats.duration.elapsedMs
      : stats.stateBuckets.reduce((total, bucket) => total + bucket.elapsedMs, 0);
  const rows = visible.map((bucket) => {
    const percent = safePercent(bucket.elapsedMs, denominator);
    return {
      label: bucket.label,
      durationLabel: formatDuration(bucket.elapsedMs),
      percent,
      percentageLabel: formatPercent(percent),
    };
  });

  if (remaining.length > 0) {
    const elapsedMs = remaining.reduce((total, bucket) => total + bucket.elapsedMs, 0);
    const percent = safePercent(elapsedMs, denominator);
    rows.push({
      label: 'Other states',
      durationLabel: formatDuration(elapsedMs),
      percent,
      percentageLabel: formatPercent(percent),
    });
  }

  return rows;
}

function safePercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

function formatPercent(value: number): string {
  return `${value}%`;
}
