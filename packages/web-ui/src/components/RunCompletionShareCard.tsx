export const SHARE_CARD_WIDTH = 1320;
export const SHARE_CARD_HEIGHT = 2868;

export type RunCompletionShareCardOutcome = 'success' | 'failure';

export type RunCompletionShareCardBucket = {
  label: string;
  durationLabel: string;
  turnCountLabel: string;
  tokenTotalLabel: string;
};

export type RunCompletionShareCardTimeBucket = {
  label: string;
  durationLabel: string;
  percent: number;
  percentageLabel: string;
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
  totalTimeLabel: string;
  transitionCountLabel: string;
  freshClearCountLabel: string;
  totalTurnCountLabel: string;
  mainTurnCountLabel: string;
  subthreadTurnCountLabel: string;
  totalTokenLabel: string;
  mainTokenLabel: string;
  subthreadTokenLabel: string;
  cacheHitPercentageLabel: string;
  outputTokenLabel: string;
  mainTokenPercent: number;
  subthreadTokenPercent: number;
  mainTokenPercentageLabel: string;
  subthreadTokenPercentageLabel: string;
  filesChangedLabel: string;
  linesChangedLabel: string;
  lineDeltaDetailLabel: string;
  workDelta: RunCompletionShareCardWorkDelta;
  buckets: ReadonlyArray<RunCompletionShareCardBucket>;
  topTimeBuckets: ReadonlyArray<RunCompletionShareCardTimeBucket>;
};

const INSET = 84;
const PANEL_WIDTH = SHARE_CARD_WIDTH - INSET * 2;
const MINT = '#28d0bd';
const PANEL = '#111923';
const LINE = '#314457';
const LINE_SOFT = '#263849';
const TEXT = '#fff7ec';
const MUTED = '#b7c4cf';
const FAINT = '#7d8d9b';

export function RunCompletionShareCard(props: RunCompletionShareCardProps) {
  const tone = props.outcome === 'success' ? SHARE_TONES.success : SHARE_TONES.failure;
  const titleLines = splitTextLines(props.fsmDisplayName, 28, 3);
  const longestTitleLine = Math.max(...titleLines.map((line) => line.length));
  const titleFontSize =
    titleLines.length > 2 ? 58 : titleLines.length > 1 ? 66 : longestTitleLine > 20 ? 72 : 84;
  const summaryLines = splitTextLines(buildSummaryLine(props), 42, 2);
  const timeBucketRows =
    props.topTimeBuckets.length > 0
      ? props.topTimeBuckets
      : [
          {
            label: 'No state buckets',
            durationLabel: 'N/A',
            percent: 0,
            percentageLabel: '0%',
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
      <defs>
        <linearGradient id="share-card-bg" x1="0" y1="0" x2="1320" y2="2868">
          <stop offset="0" stopColor="#162435" />
          <stop offset="0.36" stopColor="#121c29" />
          <stop offset="0.362" stopColor="#0b1119" />
          <stop offset="1" stopColor="#0b1119" />
        </linearGradient>
        <pattern id="share-card-grid" width="144" height="144" patternUnits="userSpaceOnUse">
          <path d="M 144 0 L 0 0 0 144" fill="none" stroke="#819aad" strokeWidth="2" />
        </pattern>
      </defs>

      <rect width="1320" height="2868" fill="url(#share-card-bg)" />
      <rect width="1320" height="2868" fill="url(#share-card-grid)" opacity="0.055" />

      <PosterHeader tone={tone} />
      <PosterHero
        summaryLines={summaryLines}
        titleFontSize={titleFontSize}
        titleLines={titleLines}
      />
      <OutcomeBand props={props} tone={tone} />
      <TokenPanel props={props} />
      <PosterStatStrip props={props} />
      <TimeByStatePanel rows={timeBucketRows} />
      <PosterFooter />
    </svg>
  );
}

function PosterHeader({ tone }: { tone: ShareCardTone }) {
  return (
    <g transform="translate(84 126)">
      <text
        x="0"
        y="0"
        fill={MUTED}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="34"
        fontWeight="900"
        letterSpacing="5"
      >
        AHARNESS
      </text>
      <g transform={`translate(${PANEL_WIDTH - tone.pillWidth} -46)`}>
        <rect
          width={tone.pillWidth}
          height="78"
          rx="39"
          fill={tone.pillFill}
          stroke={tone.pillStroke}
          strokeWidth="2"
        />
        <circle cx="44" cy="39" r="12" fill={tone.accent} />
        <text
          x="76"
          y="50"
          fill={tone.pillText}
          fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
          fontSize="25"
          fontWeight="900"
          letterSpacing="4"
        >
          {tone.pillLabel.toUpperCase()}
        </text>
      </g>
    </g>
  );
}

function PosterHero({
  summaryLines,
  titleFontSize,
  titleLines,
}: {
  summaryLines: ReadonlyArray<string>;
  titleFontSize: number;
  titleLines: ReadonlyArray<string>;
}) {
  const titleLineHeight = titleFontSize + 10;
  const titleY = titleLines.length > 2 ? 386 : titleLines.length > 1 ? 420 : 470;
  const summaryY = titleY + (titleLines.length - 1) * titleLineHeight + titleFontSize + 52;

  return (
    <g>
      <text
        id="run-completion-share-title"
        x={INSET}
        y={titleY}
        fill={TEXT}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize={titleFontSize}
        fontWeight="900"
      >
        {titleLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={INSET} dy={index === 0 ? 0 : titleFontSize + 10}>
            {line}
          </tspan>
        ))}
      </text>
      <text
        x={INSET}
        y={summaryY}
        fill={MUTED}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="32"
        fontWeight="800"
      >
        {summaryLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={INSET} dy={index === 0 ? 0 : 48}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function OutcomeBand({ props, tone }: { props: RunCompletionShareCardProps; tone: ShareCardTone }) {
  return (
    <g transform="translate(84 744)">
      <OutcomeTile
        x={0}
        label="Terminal state"
        value={tone.stateWord}
        valueColor={tone.accent}
        width={564}
      />
      <OutcomeTile x={588} label="Total time" value={props.totalTimeLabel} width={564} />
    </g>
  );
}

function OutcomeTile({
  label,
  value,
  valueColor = TEXT,
  width,
  x,
}: {
  label: string;
  value: string;
  valueColor?: string;
  width: number;
  x: number;
}) {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect width={width} height="300" rx="24" fill={PANEL} stroke={LINE} strokeWidth="3" />
      <MetricLabel x={48} y={78} text={label} />
      <text
        x="48"
        y="202"
        fill={valueColor}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="78"
        fontWeight="900"
      >
        {value}
      </text>
    </g>
  );
}

function TokenPanel({ props }: { props: RunCompletionShareCardProps }) {
  return (
    <g transform="translate(84 1090)">
      <rect width={PANEL_WIDTH} height="386" rx="24" fill={PANEL} stroke={LINE} strokeWidth="3" />
      <MetricLabel x={48} y={76} text="Token burn" />
      <MetricLabel x={780} y={76} text="Cache hit" />
      <text
        x="48"
        y="188"
        fill={TEXT}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="78"
        fontWeight="900"
      >
        {props.totalTokenLabel}
      </text>
      <text
        x="780"
        y="188"
        fill={TEXT}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="78"
        fontWeight="900"
      >
        {props.cacheHitPercentageLabel}
      </text>
      <text
        x="48"
        y="238"
        fill={MUTED}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="28"
        fontWeight="800"
      >
        total tokens
      </text>
      <rect x="48" y="286" width="1056" height="36" rx="18" fill={LINE_SOFT} />
      <rect
        id="share-card-token-burn-bar"
        x="48"
        y="286"
        width="1056"
        height="36"
        rx="18"
        fill={MINT}
      />
    </g>
  );
}

function PosterStatStrip({ props }: { props: RunCompletionShareCardProps }) {
  return (
    <g transform="translate(84 1528)">
      <StatTile x={0} label="Transitions" value={props.transitionCountLabel} width={360} />
      <StatTile x={390} label="Turns" value={props.totalTurnCountLabel} width={276} />
      <StatTile
        x={696}
        label="Changes"
        value={buildChangesLabel(props)}
        width={456}
        valueFontSize="46"
      />
    </g>
  );
}

function StatTile({
  label,
  value,
  valueFontSize = '58',
  width,
  x,
}: {
  label: string;
  value: string;
  valueFontSize?: string;
  width: number;
  x: number;
}) {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect width={width} height="204" rx="20" fill={PANEL} stroke={LINE} strokeWidth="3" />
      <MetricLabel x={36} y={68} text={label} />
      <text
        x="36"
        y="150"
        fill={TEXT}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize={valueFontSize}
        fontWeight="900"
      >
        {value}
      </text>
    </g>
  );
}

function TimeByStatePanel({ rows }: { rows: ReadonlyArray<RunCompletionShareCardTimeBucket> }) {
  return (
    <g transform="translate(84 1792)">
      <rect width={PANEL_WIDTH} height="590" rx="24" fill={PANEL} stroke={LINE} strokeWidth="3" />
      <text
        x="48"
        y="82"
        fill={TEXT}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="46"
        fontWeight="900"
      >
        Time by state
      </text>
      <MetricLabel x={854} y={82} text="top buckets" />
      {rows.map((bucket, index) => (
        <TimeBucketBar key={`${bucket.label}-${index}`} bucket={bucket} y={158 + index * 88} />
      ))}
    </g>
  );
}

function TimeBucketBar({ bucket, y }: { bucket: RunCompletionShareCardTimeBucket; y: number }) {
  const width = Math.max(8, Math.round((bucket.percent / 100) * 520));
  return (
    <g transform={`translate(48 ${y})`}>
      <text
        x="0"
        y="0"
        fill={TEXT}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="32"
        fontWeight="900"
      >
        {bucket.label}
      </text>
      <rect x="390" y="-20" width="520" height="28" rx="14" fill={LINE_SOFT} />
      <rect x="390" y="-20" width={width} height="28" rx="14" fill={MINT} />
      <text
        x="1056"
        y="2"
        fill={MUTED}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="30"
        fontWeight="900"
        textAnchor="end"
      >
        {bucket.durationLabel}
      </text>
    </g>
  );
}

function PosterFooter() {
  return (
    <g>
      <line x1={INSET} y1="2618" x2={SHARE_CARD_WIDTH - INSET} y2="2618" stroke={LINE_SOFT} />
      <text
        x={SHARE_CARD_WIDTH / 2}
        y="2734"
        fill={MUTED}
        fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="30"
        fontWeight="800"
        letterSpacing="1.2"
        textAnchor="middle"
      >
        Run with npmjs.com/package/@aharness/core
      </text>
    </g>
  );
}

function MetricLabel({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <text
      x={x}
      y={y}
      fill={FAINT}
      fontFamily="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      fontSize="24"
      fontWeight="900"
      letterSpacing="5"
    >
      {text.toUpperCase()}
    </text>
  );
}

function buildSummaryLine(props: RunCompletionShareCardProps): string {
  return `Finished in ${props.totalTimeLabel} with ${pluralizeLabel(
    props.totalTurnCountLabel,
    'turn',
  )}, ${pluralizeLabel(props.transitionCountLabel, 'transition')}, and ${buildChangeSummary(
    props,
  )}.`;
}

function buildChangeSummary(props: RunCompletionShareCardProps): string {
  if (props.filesChangedLabel === 'N/A') return 'work delta unavailable';
  if (props.filesChangedLabel === '0' && props.linesChangedLabel === '0') {
    return 'no file changes';
  }
  return pluralizeLabel(props.filesChangedLabel, 'file change', 'file changes');
}

function buildChangesLabel(props: RunCompletionShareCardProps): string {
  if (props.filesChangedLabel === 'N/A') return 'N/A';
  return `${props.filesChangedLabel} files`;
}

function pluralizeLabel(label: string, singular: string, plural = `${singular}s`): string {
  return `${label} ${label === '1' ? singular : plural}`;
}

function splitTextLines(value: string, maxChars: number, maxLines: number): string[] {
  const words = value
    .replace(/([/-])/g, '$1 ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => splitLongToken(word, maxChars));
  const lines: string[] = [];

  for (const word of words) {
    const current = lines.at(-1);
    if (!current) {
      lines.push(word);
      continue;
    }
    const candidate = joinLineToken(current, word);
    if (candidate.length <= maxChars) {
      lines[lines.length - 1] = candidate;
      continue;
    }
    if (lines.length < maxLines) {
      lines.push(word);
      continue;
    }
    lines[lines.length - 1] = truncateDisplay(candidate, maxChars);
  }

  if (lines.length === 0) return ['workflow'];
  return lines.map((line) => truncateDisplay(line, maxChars));
}

function joinLineToken(current: string, word: string): string {
  return /[-/]$/.test(current) ? `${current}${word}` : `${current} ${word}`;
}

function splitLongToken(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += maxChars) {
    chunks.push(value.slice(index, index + maxChars));
  }
  return chunks;
}

function truncateDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

type ShareCardTone = {
  accent: string;
  pillFill: string;
  pillLabel: string;
  pillStroke: string;
  pillText: string;
  pillWidth: number;
  stateWord: string;
};

const SHARE_TONES: Record<RunCompletionShareCardOutcome, ShareCardTone> = {
  success: {
    accent: MINT,
    pillFill: '#164c4a',
    pillLabel: 'Run complete',
    pillStroke: '#246762',
    pillText: '#d7fff8',
    pillWidth: 344,
    stateWord: 'DONE',
  },
  failure: {
    accent: '#ff7892',
    pillFill: '#4c1f2d',
    pillLabel: 'Run failed',
    pillStroke: '#793045',
    pillText: '#ffe0e6',
    pillWidth: 272,
    stateWord: 'HALT',
  },
};
