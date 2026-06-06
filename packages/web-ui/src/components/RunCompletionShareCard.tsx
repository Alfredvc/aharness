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
const MINT = '#35d7c8';
const WARM = '#ff6a32';
const PLASMA = '#ff4f78';
const AMBER = '#ffd15a';
const INDIGO = '#7686ff';
const PANEL = '#101826';
const PANEL_DEEP = '#0c141f';
const LINE = '#31495f';
const LINE_SOFT = '#273a4d';
const TEXT = '#fff7ec';
const MUTED = '#b7c4cf';
const FAINT = '#7d8d9b';
const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';

export function RunCompletionShareCard(props: RunCompletionShareCardProps) {
  const tone = props.outcome === 'success' ? SHARE_TONES.success : SHARE_TONES.failure;
  const titleLines = splitTextLines(props.fsmDisplayName, 23, 3);
  const longestTitleLine = Math.max(...titleLines.map((line) => line.length));
  const titleFontSize =
    titleLines.length > 2 ? 70 : titleLines.length > 1 ? 78 : longestTitleLine > 20 ? 86 : 96;
  const summaryLines = splitTextLines(buildSummaryLine(props, tone), 44, 2);
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
          <stop offset="0" stopColor="#172333" />
          <stop offset="0.32" stopColor="#111a27" />
          <stop offset="0.62" stopColor="#0a1018" />
          <stop offset="1" stopColor="#090d14" />
        </linearGradient>
        <linearGradient id="share-card-route" x1="84" y1="654" x2="1168" y2="82">
          <stop offset="0" stopColor={WARM} />
          <stop offset="0.48" stopColor="#ff5538" />
          <stop offset="1" stopColor={PLASMA} />
        </linearGradient>
        <linearGradient id="share-card-ring" x1="774" y1="0" x2="1084" y2="310">
          <stop offset="0" stopColor={AMBER} />
          <stop offset="0.5" stopColor={WARM} />
          <stop offset="1" stopColor={PLASMA} />
        </linearGradient>
        <pattern id="share-card-grid" width="144" height="144" patternUnits="userSpaceOnUse">
          <path d="M 144 0 L 0 0 0 144" fill="none" stroke="#819aad" strokeWidth="2" />
        </pattern>
        <filter id="share-card-route-glow" x="-18%" y="-80%" width="136%" height="260%">
          <feGaussianBlur stdDeviation="10" result="routeBlur" />
          <feMerge>
            <feMergeNode in="routeBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect width="1320" height="2868" fill="url(#share-card-bg)" />
      <rect width="1320" height="2868" fill="url(#share-card-grid)" opacity="0.055" />
      <DecorativeBackdrop tone={tone} />

      <PosterHeader tone={tone} />
      <PosterHero
        summaryLines={summaryLines}
        titleFontSize={titleFontSize}
        titleLines={titleLines}
      />
      <ProgressPanel props={props} tone={tone} />
      <TokenPanel props={props} />
      <PosterStatGrid props={props} />
      <TimeByStatePanel rows={timeBucketRows} />
      <PosterFooter />
    </svg>
  );
}

function DecorativeBackdrop({ tone }: { tone: ShareCardTone }) {
  return (
    <g aria-hidden="true">
      <circle cx="1118" cy="96" r="540" fill={tone.ambient} opacity="0.26" />
      <circle cx="-72" cy="2490" r="560" fill={MINT} opacity="0.12" />
      <circle cx="1210" cy="2518" r="440" fill={INDIGO} opacity="0.12" />
      <path
        d="M 90 654 C 220 642 374 646 536 624 C 688 604 772 576 856 486 C 950 386 1010 168 1168 86"
        fill="none"
        stroke="#03060a"
        strokeLinecap="round"
        strokeWidth="46"
        opacity="0.32"
      />
      <path
        d="M 90 654 C 220 642 374 646 536 624 C 688 604 772 576 856 486 C 950 386 1010 168 1168 86"
        fill="none"
        stroke="url(#share-card-route)"
        strokeLinecap="round"
        strokeWidth="20"
        filter="url(#share-card-route-glow)"
        opacity={tone.routeOpacity}
      />
      <circle cx="96" cy="652" r="23" fill={MINT} />
      <circle cx="1168" cy="86" r="25" fill={AMBER} />
    </g>
  );
}

function PosterHeader({ tone }: { tone: ShareCardTone }) {
  return (
    <g transform="translate(84 126)">
      <text
        x="0"
        y="0"
        fill={MUTED}
        fontFamily={FONT}
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
          fontFamily={FONT}
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
  const titleY = titleLines.length > 2 ? 302 : titleLines.length > 1 ? 348 : 404;
  const summaryY = titleY + (titleLines.length - 1) * titleLineHeight + titleFontSize + 54;

  return (
    <g>
      <text
        id="run-completion-share-title"
        x={INSET}
        y={titleY}
        fill={TEXT}
        fontFamily={FONT}
        fontSize={titleFontSize}
        fontWeight="900"
      >
        {titleLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={INSET} dy={index === 0 ? 0 : titleFontSize + 10}>
            {line}
          </tspan>
        ))}
      </text>
      <text x={INSET} y={summaryY} fill={MUTED} fontFamily={FONT} fontSize="32" fontWeight="800">
        {summaryLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={INSET} dy={index === 0 ? 0 : 48}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function ProgressPanel({
  props,
  tone,
}: {
  props: RunCompletionShareCardProps;
  tone: ShareCardTone;
}) {
  return (
    <g transform="translate(84 650)">
      <rect x="0" y="18" width={PANEL_WIDTH} height="490" rx="46" fill="#03060a" opacity="0.34" />
      <rect
        width={PANEL_WIDTH}
        height="470"
        rx="44"
        fill={PANEL}
        stroke="#203144"
        strokeWidth="3"
      />
      <MetricLabel x={64} y={86} text="Total time" />
      <text x="62" y="258" fill={TEXT} fontFamily={FONT} fontSize="152" fontWeight="950">
        {props.totalTimeLabel}
      </text>
      <text x="66" y="340" fill={MUTED} fontFamily={FONT} fontSize="32" fontWeight="850">
        {props.transitionCountLabel} transitions / {props.freshClearCountLabel} fresh clears / final
        state: {tone.stateWord.toLowerCase()}
      </text>
      <g transform="translate(880 86)">
        <circle cx="150" cy="150" r="126" fill="none" stroke={LINE_SOFT} strokeWidth="28" />
        <circle
          cx="150"
          cy="150"
          r="126"
          fill="none"
          stroke="url(#share-card-ring)"
          strokeLinecap="round"
          strokeWidth="28"
        />
        <text
          x="150"
          y="151"
          fill={TEXT}
          fontFamily={FONT}
          fontSize={tone.ringValueFontSize}
          fontWeight="950"
          textAnchor="middle"
        >
          {tone.ringValue}
        </text>
        <text
          x="150"
          y="202"
          fill={MUTED}
          fontFamily={FONT}
          fontSize="28"
          fontWeight="850"
          textAnchor="middle"
        >
          {tone.ringLabel}
        </text>
      </g>
    </g>
  );
}

function TokenPanel({ props }: { props: RunCompletionShareCardProps }) {
  return (
    <g transform="translate(84 1200)">
      <rect width={PANEL_WIDTH} height="360" rx="34" fill="#131d2b" stroke={LINE} strokeWidth="3" />
      <MetricLabel x={48} y={76} text="Token burn" />
      <MetricLabel x={760} y={76} text="Cache hit" />
      <text x="48" y="188" fill={TEXT} fontFamily={FONT} fontSize="78" fontWeight="900">
        {props.totalTokenLabel}
      </text>
      <text x="760" y="188" fill={TEXT} fontFamily={FONT} fontSize="78" fontWeight="900">
        {props.cacheHitPercentageLabel}
      </text>
      <text x="48" y="238" fill={MUTED} fontFamily={FONT} fontSize="28" fontWeight="800">
        total tokens
      </text>
      <text x="760" y="238" fill={MUTED} fontFamily={FONT} fontSize="28" fontWeight="800">
        {props.outputTokenLabel} output tokens
      </text>
      <rect x="48" y="286" width="1056" height="34" rx="17" fill={LINE_SOFT} />
      <rect
        id="share-card-token-burn-bar"
        x="48"
        y="286"
        width="1056"
        height="34"
        rx="17"
        fill={MINT}
      />
    </g>
  );
}

function PosterStatGrid({ props }: { props: RunCompletionShareCardProps }) {
  return (
    <g transform="translate(84 1640)">
      <StatTile
        x={0}
        y={0}
        label="Turns"
        value={props.totalTurnCountLabel}
        detail="main + subthread turns"
      />
      <StatTile
        x={600}
        y={0}
        label="Transitions"
        value={props.transitionCountLabel}
        detail="actual FSM transitions"
      />
      <StatTile
        x={0}
        y={280}
        label="Files changed"
        value={buildChangesLabel(props)}
        detail="final work footprint"
      />
      <StatTile
        x={600}
        y={280}
        label="Lines changed"
        value={props.linesChangedLabel}
        detail={props.lineDeltaDetailLabel}
      />
    </g>
  );
}

function StatTile({
  detail,
  label,
  value,
  x,
  y,
}: {
  detail: string;
  label: string;
  value: string;
  x: number;
  y: number;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="552" height="232" rx="30" fill="#111a29" stroke="#273d52" strokeWidth="3" />
      <text
        x="48"
        y="70"
        fill={FAINT}
        fontFamily={FONT}
        fontSize="27"
        fontWeight="900"
        letterSpacing="4"
      >
        {label.toUpperCase()}
      </text>
      <text x="48" y="150" fill={TEXT} fontFamily={FONT} fontSize="76" fontWeight="950">
        {value}
      </text>
      <text x="48" y="196" fill={MUTED} fontFamily={FONT} fontSize="27" fontWeight="850">
        {detail}
      </text>
    </g>
  );
}

function TimeByStatePanel({ rows }: { rows: ReadonlyArray<RunCompletionShareCardTimeBucket> }) {
  return (
    <g transform="translate(84 2180)">
      <rect
        width={PANEL_WIDTH}
        height="410"
        rx="34"
        fill={PANEL_DEEP}
        stroke={LINE}
        strokeWidth="3"
      />
      <text x="48" y="82" fill={TEXT} fontFamily={FONT} fontSize="46" fontWeight="900">
        Time by state
      </text>
      <MetricLabel x={854} y={82} text="top buckets" />
      {rows.map((bucket, index) => (
        <TimeBucketBar key={`${bucket.label}-${index}`} bucket={bucket} y={156 + index * 76} />
      ))}
    </g>
  );
}

function TimeBucketBar({ bucket, y }: { bucket: RunCompletionShareCardTimeBucket; y: number }) {
  const width = Math.max(8, Math.round((bucket.percent / 100) * 520));
  return (
    <g transform={`translate(48 ${y})`}>
      <text x="0" y="0" fill={TEXT} fontFamily={FONT} fontSize="32" fontWeight="900">
        {bucket.label}
      </text>
      <rect x="390" y="-20" width="520" height="28" rx="14" fill={LINE_SOFT} />
      <rect x="390" y="-20" width={width} height="28" rx="14" fill={MINT} />
      <text
        x="1056"
        y="2"
        fill={MUTED}
        fontFamily={FONT}
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
      <line x1={INSET} y1="2686" x2={SHARE_CARD_WIDTH - INSET} y2="2686" stroke={LINE_SOFT} />
      <text
        x={SHARE_CARD_WIDTH / 2}
        y="2802"
        fill={MUTED}
        fontFamily={FONT}
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
      fontFamily={FONT}
      fontSize="24"
      fontWeight="900"
      letterSpacing="5"
    >
      {text.toUpperCase()}
    </text>
  );
}

function buildSummaryLine(props: RunCompletionShareCardProps, tone: ShareCardTone): string {
  return `${tone.stateWord} after ${props.totalTimeLabel} with ${pluralizeLabel(
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
  ambient: string;
  pillFill: string;
  pillLabel: string;
  pillStroke: string;
  pillText: string;
  pillWidth: number;
  ringLabel: string;
  ringValue: string;
  ringValueFontSize: string;
  routeOpacity: number;
  stateWord: string;
};

const SHARE_TONES: Record<RunCompletionShareCardOutcome, ShareCardTone> = {
  success: {
    accent: MINT,
    ambient: WARM,
    pillFill: '#164c4a',
    pillLabel: 'Run complete',
    pillStroke: '#246762',
    pillText: '#d7fff8',
    pillWidth: 344,
    ringLabel: 'finished',
    ringValue: '100%',
    ringValueFontSize: '58',
    routeOpacity: 0.94,
    stateWord: 'DONE',
  },
  failure: {
    accent: '#ff7892',
    ambient: PLASMA,
    pillFill: '#4c1f2d',
    pillLabel: 'Run failed',
    pillStroke: '#793045',
    pillText: '#ffe0e6',
    pillWidth: 272,
    ringLabel: 'failed',
    ringValue: 'HALT',
    ringValueFontSize: '54',
    routeOpacity: 0.82,
    stateWord: 'HALT',
  },
};
