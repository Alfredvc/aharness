import type { RunCompletionStats } from '../types/events.js';

export const SHARE_CARD_WIDTH = 1320;
export const SHARE_CARD_HEIGHT = 2868;

const numberFormat = new Intl.NumberFormat('en-US');
const MAX_BUCKET_ROWS = 5;
const MAX_DISPLAY_NAME_LENGTH = 76;
const MAX_BUCKET_LABEL_LENGTH = 34;

export type RunCompletionShareCardOutcome = 'success' | 'failure';

export type RunCompletionShareCardBucket = {
  label: string;
  durationLabel: string;
  turnCountLabel: string;
  tokenTotalLabel: string;
};

export type RunCompletionShareCardWorkDelta = {
  filesChangedLabel: string;
  linesAddedLabel: string;
  linesDeletedLabel: string;
};

export type RunCompletionShareCardProps = {
  fsmDisplayName: string;
  outcome: RunCompletionShareCardOutcome;
  durationLabel: string;
  transitionCountLabel: string;
  freshClearCountLabel: string;
  mainTurnCountLabel: string;
  subthreadTurnCountLabel: string;
  totalTokenLabel: string;
  mainTokenLabel: string;
  subthreadTokenLabel: string;
  workDelta: RunCompletionShareCardWorkDelta;
  buckets: ReadonlyArray<RunCompletionShareCardBucket>;
};

export function buildRunCompletionShareCardProps(
  stats: RunCompletionStats,
): RunCompletionShareCardProps | null {
  if (stats.outcome !== 'success' && stats.outcome !== 'failure') return null;

  return {
    fsmDisplayName: truncateDisplay(sanitizeDisplay(stats.fsmDisplayName), MAX_DISPLAY_NAME_LENGTH),
    outcome: stats.outcome,
    durationLabel: formatDuration(stats.duration.elapsedMs),
    transitionCountLabel: formatNumber(stats.transitionCount),
    freshClearCountLabel: formatNumber(stats.freshClearCount),
    mainTurnCountLabel: formatNumber(stats.mainTurnCount),
    subthreadTurnCountLabel: formatNumber(stats.subthreadTurnCount),
    totalTokenLabel: formatNumber(stats.tokenTotals.totalTokens),
    mainTokenLabel: formatNumber(stats.tokenTotals.mainTokens),
    subthreadTokenLabel: formatNumber(stats.tokenTotals.subthreadTokens),
    workDelta:
      stats.workDelta.status === 'available'
        ? {
            filesChangedLabel: formatNumber(stats.workDelta.filesChanged),
            linesAddedLabel: formatNumber(stats.workDelta.linesAdded),
            linesDeletedLabel: formatNumber(stats.workDelta.linesDeleted),
          }
        : {
            filesChangedLabel: 'N/A',
            linesAddedLabel: 'N/A',
            linesDeletedLabel: 'N/A',
          },
    buckets: buildBucketRows(stats),
  };
}

export function RunCompletionShareCard(props: RunCompletionShareCardProps) {
  const tone = props.outcome === 'success' ? SHARE_TONES.success : SHARE_TONES.failure;
  const outcomeLabel = props.outcome === 'success' ? 'Completed' : 'Failed';
  const bucketRows =
    props.buckets.length > 0
      ? props.buckets
      : [
          {
            label: 'No state buckets',
            durationLabel: 'N/A',
            turnCountLabel: '0',
            tokenTotalLabel: '0',
          },
        ];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={SHARE_CARD_WIDTH}
      height={SHARE_CARD_HEIGHT}
      viewBox={`0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}`}
      role="img"
      aria-labelledby="run-completion-share-title"
    >
      <rect width="1320" height="2868" fill="#f7f7f2" />
      <rect
        x="86"
        y="86"
        width="1148"
        height="2696"
        rx="42"
        fill="#ffffff"
        stroke="#1f2937"
        strokeWidth="4"
      />
      <rect x="86" y="86" width="1148" height="28" rx="14" fill={tone.accent} />

      <text
        x="126"
        y="184"
        fill="#4b5563"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="34"
        fontWeight="700"
        letterSpacing="4"
      >
        AHARNESS RUN SUMMARY
      </text>
      <text
        id="run-completion-share-title"
        x="126"
        y="338"
        fill="#111827"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="78"
        fontWeight="800"
      >
        {props.fsmDisplayName}
      </text>
      <rect
        x="126"
        y="414"
        width="314"
        height="92"
        rx="46"
        fill={tone.soft}
        stroke={tone.accent}
        strokeWidth="3"
      />
      <text
        x="166"
        y="474"
        fill={tone.text}
        fontFamily="Inter, Arial, sans-serif"
        fontSize="38"
        fontWeight="800"
      >
        {outcomeLabel}
      </text>

      <MetricGrid
        y={612}
        metrics={[
          ['Duration', props.durationLabel],
          ['Transitions', props.transitionCountLabel],
          ['Fresh clears', props.freshClearCountLabel],
          ['Main turns', props.mainTurnCountLabel],
          ['Subthread turns', props.subthreadTurnCountLabel],
          ['Total tokens', props.totalTokenLabel],
        ]}
      />

      <SectionTitle y={1278} title="Token split" />
      <MetricGrid
        y={1348}
        compact
        metrics={[
          ['Main', props.mainTokenLabel],
          ['Subthreads', props.subthreadTokenLabel],
          ['Total', props.totalTokenLabel],
        ]}
      />

      <SectionTitle y={1742} title="Committed work" />
      <MetricGrid
        y={1812}
        compact
        metrics={[
          ['Files', props.workDelta.filesChangedLabel],
          ['Added', props.workDelta.linesAddedLabel],
          ['Deleted', props.workDelta.linesDeletedLabel],
        ]}
      />

      <SectionTitle y={2206} title="Top state buckets" />
      <g transform="translate(126 2266)">
        <rect width="1068" height="504" rx="28" fill="#f9fafb" stroke="#d1d5db" strokeWidth="3" />
        <BucketHeader />
        {bucketRows.slice(0, 6).map((bucket, index) => (
          <BucketRow key={`${bucket.label}-${index}`} bucket={bucket} y={88 + index * 72} />
        ))}
      </g>

      <text
        x="126"
        y="2730"
        fill="#6b7280"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="26"
        fontWeight="700"
      >
        aharness
      </text>
      <text x="1016" y="2730" fill="#6b7280" fontFamily="Inter, Arial, sans-serif" fontSize="24">
        Display-safe summary
      </text>
    </svg>
  );
}

function MetricGrid({
  y,
  metrics,
  compact = false,
}: {
  y: number;
  metrics: ReadonlyArray<readonly [string, string]>;
  compact?: boolean;
}) {
  const columns = compact ? 3 : 2;
  const cellWidth = compact ? 336 : 514;
  const cellHeight = 164;
  return (
    <g transform={`translate(126 ${y})`}>
      {metrics.map(([label, value], index) => {
        const x = (index % columns) * (cellWidth + 30);
        const row = Math.floor(index / columns);
        return (
          <g key={label} transform={`translate(${x} ${row * (cellHeight + 30)})`}>
            <rect
              width={cellWidth}
              height={cellHeight}
              rx="26"
              fill="#f9fafb"
              stroke="#d1d5db"
              strokeWidth="3"
            />
            <text
              x="30"
              y="58"
              fill="#6b7280"
              fontFamily="Inter, Arial, sans-serif"
              fontSize="28"
              fontWeight="700"
            >
              {label}
            </text>
            <text
              x="30"
              y="118"
              fill="#111827"
              fontFamily="Inter, Arial, sans-serif"
              fontSize="46"
              fontWeight="800"
            >
              {value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function SectionTitle({ y, title }: { y: number; title: string }) {
  return (
    <text
      x="126"
      y={y}
      fill="#111827"
      fontFamily="Inter, Arial, sans-serif"
      fontSize="42"
      fontWeight="800"
    >
      {title}
    </text>
  );
}

function BucketHeader() {
  return (
    <g transform="translate(30 52)">
      <text
        x="0"
        y="0"
        fill="#6b7280"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="24"
        fontWeight="800"
      >
        State
      </text>
      <text
        x="492"
        y="0"
        fill="#6b7280"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="24"
        fontWeight="800"
      >
        Time
      </text>
      <text
        x="680"
        y="0"
        fill="#6b7280"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="24"
        fontWeight="800"
      >
        Turns
      </text>
      <text
        x="842"
        y="0"
        fill="#6b7280"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="24"
        fontWeight="800"
      >
        Tokens
      </text>
    </g>
  );
}

function BucketRow({ bucket, y }: { bucket: RunCompletionShareCardBucket; y: number }) {
  return (
    <g transform={`translate(30 ${y})`}>
      <line x1="0" y1="-30" x2="1008" y2="-30" stroke="#e5e7eb" strokeWidth="2" />
      <text
        x="0"
        y="0"
        fill="#111827"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="30"
        fontWeight="700"
      >
        {bucket.label}
      </text>
      <text x="492" y="0" fill="#374151" fontFamily="Inter, Arial, sans-serif" fontSize="30">
        {bucket.durationLabel}
      </text>
      <text x="680" y="0" fill="#374151" fontFamily="Inter, Arial, sans-serif" fontSize="30">
        {bucket.turnCountLabel}
      </text>
      <text x="842" y="0" fill="#374151" fontFamily="Inter, Arial, sans-serif" fontSize="30">
        {bucket.tokenTotalLabel}
      </text>
    </g>
  );
}

function buildBucketRows(stats: RunCompletionStats): RunCompletionShareCardBucket[] {
  const visible = stats.stateBuckets.slice(0, MAX_BUCKET_ROWS);
  const remaining = stats.stateBuckets.slice(MAX_BUCKET_ROWS);
  const rows = visible.map((bucket) => ({
    label: truncateDisplay(sanitizeDisplay(bucket.label), MAX_BUCKET_LABEL_LENGTH),
    durationLabel: formatDuration(bucket.elapsedMs),
    turnCountLabel: formatNumber(bucket.mainTurnCount + bucket.subthreadTurnCount),
    tokenTotalLabel: formatNumber(bucket.tokenTotals.totalTokens),
  }));
  if (remaining.length > 0) {
    const other = remaining.reduce(
      (acc, bucket) => ({
        elapsedMs: acc.elapsedMs + bucket.elapsedMs,
        turnCount: acc.turnCount + bucket.mainTurnCount + bucket.subthreadTurnCount,
        totalTokens: acc.totalTokens + bucket.tokenTotals.totalTokens,
      }),
      { elapsedMs: 0, turnCount: 0, totalTokens: 0 },
    );
    rows.push({
      label: 'Other states',
      durationLabel: formatDuration(other.elapsedMs),
      turnCountLabel: formatNumber(other.turnCount),
      tokenTotalLabel: formatNumber(other.totalTokens),
    });
  }
  return rows;
}

function sanitizeDisplay(value: string): string {
  return (
    Array.from(value, (character) => (isControlCharacter(character) ? ' ' : character))
      .join('')
      .replace(/\s+/g, ' ')
      .trim() || 'workflow'
  );
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
}

function truncateDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
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

const SHARE_TONES: Record<
  RunCompletionShareCardOutcome,
  { accent: string; soft: string; text: string }
> = {
  success: { accent: '#047857', soft: '#d1fae5', text: '#065f46' },
  failure: { accent: '#be123c', soft: '#ffe4e6', text: '#9f1239' },
};
