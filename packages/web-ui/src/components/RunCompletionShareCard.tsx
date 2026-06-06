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

export function RunCompletionShareCard(props: RunCompletionShareCardProps) {
  const tone = props.outcome === 'success' ? SHARE_TONES.success : SHARE_TONES.failure;
  const titleLines = splitTitleLines(props.fsmDisplayName);
  const outcomeLabel = props.outcome === 'success' ? 'Run completed' : 'Run failed';
  const workDeltaNote =
    props.lineDeltaDetailLabel === 'N/A'
      ? 'Committed delta unavailable'
      : props.lineDeltaDetailLabel;
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
          <stop offset="0" stopColor="#07131f" />
          <stop offset="0.58" stopColor="#0b1726" />
          <stop offset="1" stopColor="#132337" />
        </linearGradient>
        <linearGradient id="share-card-token-burn" x1="0" y1="0" x2="600" y2="0">
          <stop offset="0" stopColor="#f59e0b" />
          <stop offset="0.54" stopColor="#fb7185" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
        <linearGradient id="share-card-time-bars" x1="0" y1="0" x2="720" y2="0">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#60a5fa" />
        </linearGradient>
        <pattern id="share-card-grid" width="72" height="72" patternUnits="userSpaceOnUse">
          <path d="M 72 0 L 0 0 0 72" fill="none" stroke="#24364a" strokeWidth="2" />
        </pattern>
        <filter id="share-card-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="18" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect width="1320" height="2868" fill="url(#share-card-bg)" />
      <rect width="1320" height="2868" fill="url(#share-card-grid)" opacity="0.34" />
      <path d="M0 0 H1320 V620 C920 548 472 656 0 516 Z" fill="#102237" opacity="0.82" />
      <path d="M0 2300 C346 2206 668 2308 1320 2154 V2868 H0 Z" fill="#07131f" opacity="0.78" />
      <g opacity="0.78">
        <circle
          cx="1072"
          cy="338"
          r="138"
          fill={tone.aura}
          opacity="0.1"
          filter="url(#share-card-glow)"
        />
        <circle
          cx="1072"
          cy="338"
          r="120"
          fill="none"
          stroke={tone.accent}
          strokeWidth="3"
          opacity="0.34"
        />
        <path
          d="M1072 218 A120 120 0 0 1 1192 338"
          fill="none"
          stroke="#fff7ed"
          strokeLinecap="round"
          strokeWidth="6"
          opacity="0.16"
        />
        <path
          d="M966 338 H1038 M1106 338 H1178 M1072 232 V298 M1072 378 V444"
          fill="none"
          stroke={tone.accent}
          strokeLinecap="round"
          strokeWidth="4"
          opacity="0.28"
        />
        <circle cx="1072" cy="338" r="20" fill={tone.accent} opacity="0.38" />
      </g>

      <g transform="translate(96 104)">
        <text
          x="0"
          y="0"
          fill="#8ea4bb"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="30"
          fontWeight="800"
        >
          AHARNESS
        </text>
        <rect x="0" y="46" width={tone.pillWidth} height="76" rx="38" fill={tone.pillFill} />
        <circle cx="44" cy="84" r="12" fill={tone.accent} />
        <text
          x="70"
          y="98"
          fill={tone.pillText}
          fontFamily="Inter, Arial, sans-serif"
          fontSize="32"
          fontWeight="800"
        >
          {outcomeLabel}
        </text>
      </g>

      <text
        id="run-completion-share-title"
        x="96"
        y="382"
        fill="#fff7ed"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="92"
        fontWeight="900"
      >
        {titleLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x="96" dy={index === 0 ? 0 : 104}>
            {line}
          </tspan>
        ))}
      </text>
      <text
        x="98"
        y={titleLines.length > 1 ? 612 : 508}
        fill="#9fb4c8"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="34"
        fontWeight="700"
      >
        Display-safe terminal FSM run summary
      </text>

      <g transform="translate(96 704)">
        <rect width="682" height="420" rx="34" fill="#0f2234" stroke="#284258" strokeWidth="3" />
        <text
          x="42"
          y="78"
          fill="#8ea4bb"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="30"
          fontWeight="800"
        >
          TOTAL TIME
        </text>
        <text
          x="42"
          y="214"
          fill="#fff7ed"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="104"
          fontWeight="900"
        >
          {props.totalTimeLabel}
        </text>
        <text
          x="44"
          y="306"
          fill="#9fb4c8"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="36"
          fontWeight="700"
        >
          {props.totalTurnCountLabel} turns across main and subthreads
        </text>
        <text
          x="44"
          y="360"
          fill="#fbbf24"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="30"
          fontWeight="800"
        >
          {props.transitionCountLabel} transitions / {props.freshClearCountLabel} fresh clears
        </text>
      </g>

      <g transform="translate(826 704)">
        <rect width="398" height="420" rx="34" fill="#0f2234" stroke="#284258" strokeWidth="3" />
        <RingIndicator tone={tone} outcome={props.outcome} />
      </g>

      <g transform="translate(96 1190)">
        <rect width="1128" height="444" rx="34" fill="#111f31" stroke="#31465c" strokeWidth="3" />
        <text
          x="42"
          y="78"
          fill="#8ea4bb"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="30"
          fontWeight="800"
        >
          TOKEN BURN
        </text>
        <text
          x="42"
          y="188"
          fill="#fff7ed"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="84"
          fontWeight="900"
        >
          {props.totalTokenLabel}
        </text>
        <text x="46" y="244" fill="#9fb4c8" fontFamily="Inter, Arial, sans-serif" fontSize="30">
          total tokens
        </text>
        <TokenSplitBar
          x={42}
          y={300}
          mainPercent={props.mainTokenPercent}
          subthreadPercent={props.subthreadTokenPercent}
        />
        <MetricPair x={720} y={126} label="Output" value={props.outputTokenLabel} />
        <MetricPair x={720} y={262} label="Cache hit" value={props.cacheHitPercentageLabel} />
        <TokenSplitLabel
          x={42}
          y={386}
          main={props.mainTokenPercentageLabel}
          subthread={props.subthreadTokenPercentageLabel}
        />
      </g>

      <g transform="translate(96 1700)">
        <StatTile
          x={0}
          y={0}
          label="Transitions"
          value={props.transitionCountLabel}
          accent="#14b8a6"
        />
        <StatTile x={584} y={0} label="Turns" value={props.totalTurnCountLabel} accent="#60a5fa" />
        <StatTile
          x={0}
          y={260}
          label="Files changed"
          value={props.filesChangedLabel}
          accent="#fbbf24"
        />
        <StatTile
          x={584}
          y={260}
          label="Lines changed"
          value={props.linesChangedLabel}
          accent="#fb7185"
        />
      </g>

      <g transform="translate(96 2288)">
        <rect width="1128" height="462" rx="34" fill="#0f2234" stroke="#284258" strokeWidth="3" />
        <text
          x="42"
          y="76"
          fill="#fff7ed"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="44"
          fontWeight="900"
        >
          Time by state
        </text>
        <text
          x="42"
          y="124"
          fill="#9fb4c8"
          fontFamily="Inter, Arial, sans-serif"
          fontSize="28"
          fontWeight="700"
        >
          Top parent/root buckets plus other
        </text>
        {timeBucketRows.map((bucket, index) => (
          <TimeBucketBar key={`${bucket.label}-${index}`} bucket={bucket} y={176 + index * 82} />
        ))}
      </g>

      <text
        x="96"
        y="2806"
        fill="#fff7ed"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="32"
        fontWeight="900"
      >
        aharness
      </text>
      <text
        x="1224"
        y="2806"
        fill="#8ea4bb"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="24"
        fontWeight="700"
        textAnchor="end"
      >
        {workDeltaNote} / Display-safe poster
      </text>
    </svg>
  );
}

function RingIndicator({
  tone,
  outcome,
}: {
  tone: ShareCardTone;
  outcome: RunCompletionShareCardOutcome;
}) {
  const dash = outcome === 'success' ? '100 0' : '72 28';
  return (
    <g>
      <circle cx="199" cy="202" r="136" fill="#07131f" stroke="#1f3347" strokeWidth="2" />
      <circle cx="199" cy="202" r="108" fill="none" stroke="#1f3347" strokeWidth="22" />
      <circle
        cx="199"
        cy="202"
        r="108"
        fill="none"
        stroke={tone.accent}
        strokeWidth="22"
        strokeDasharray={dash}
        pathLength="100"
        strokeLinecap={outcome === 'success' ? 'butt' : 'round'}
        transform="rotate(-90 199 202)"
      />
      <circle
        cx="199"
        cy="202"
        r="72"
        fill="#0f2234"
        stroke={tone.accent}
        strokeWidth="2"
        opacity="0.84"
      />
      <text
        x="199"
        y="192"
        fill="#fff7ed"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="40"
        fontWeight="900"
        textAnchor="middle"
      >
        {outcome === 'success' ? 'DONE' : 'HALT'}
      </text>
      <text
        x="199"
        y="238"
        fill="#9fb4c8"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="24"
        fontWeight="800"
        textAnchor="middle"
      >
        terminal state
      </text>
    </g>
  );
}

function MetricPair({
  x,
  y,
  label,
  value,
}: {
  x: number;
  y: number;
  label: string;
  value: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <text fill="#8ea4bb" fontFamily="Inter, Arial, sans-serif" fontSize="28" fontWeight="800">
        {label}
      </text>
      <text
        y="68"
        fill="#fff7ed"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="52"
        fontWeight="900"
      >
        {value}
      </text>
    </g>
  );
}

function TokenSplitLabel({
  x,
  y,
  main,
  subthread,
}: {
  x: number;
  y: number;
  main: string;
  subthread: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx="10" cy="-8" r="8" fill="#14b8a6" />
      <text x="28" fill="#9fb4c8" fontFamily="Inter, Arial, sans-serif" fontSize="26">
        Main {main}
      </text>
      <circle cx="196" cy="-8" r="8" fill="#60a5fa" />
      <text x="214" fill="#9fb4c8" fontFamily="Inter, Arial, sans-serif" fontSize="26">
        Subthreads {subthread}
      </text>
    </g>
  );
}

function TokenSplitBar({
  x,
  y,
  mainPercent,
  subthreadPercent,
}: {
  x: number;
  y: number;
  mainPercent: number;
  subthreadPercent: number;
}) {
  const trackWidth = 600;
  const mainWidth = percentWidth(mainPercent, trackWidth);
  const subthreadWidth = percentWidth(subthreadPercent, trackWidth);

  return (
    <g transform={`translate(${x} ${y})`}>
      <clipPath id="share-card-token-split-clip">
        <rect width={trackWidth} height="32" rx="16" />
      </clipPath>
      <rect width={trackWidth} height="32" rx="16" fill="#1f3347" />
      <g clipPath="url(#share-card-token-split-clip)">
        <rect
          id="share-card-token-main-bar"
          width={mainWidth}
          height="32"
          fill="url(#share-card-token-burn)"
        />
        <rect
          id="share-card-token-subthread-bar"
          x={mainWidth}
          width={subthreadWidth}
          height="32"
          fill="#60a5fa"
          opacity="0.9"
        />
      </g>
    </g>
  );
}

function StatTile({
  x,
  y,
  label,
  value,
  accent,
}: {
  x: number;
  y: number;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="544" height="214" rx="28" fill="#0f2234" stroke="#284258" strokeWidth="3" />
      <rect x="24" y="24" width="78" height="8" rx="4" fill={accent} />
      <text
        x="28"
        y="82"
        fill="#8ea4bb"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="26"
        fontWeight="800"
      >
        {label}
      </text>
      <text
        x="28"
        y="154"
        fill="#fff7ed"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="56"
        fontWeight="900"
      >
        {value}
      </text>
    </g>
  );
}

function TimeBucketBar({ bucket, y }: { bucket: RunCompletionShareCardTimeBucket; y: number }) {
  const width = Math.max(8, Math.round((bucket.percent / 100) * 1000));
  return (
    <g transform={`translate(42 ${y})`}>
      <text
        x="0"
        y="0"
        fill="#fff7ed"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="28"
        fontWeight="800"
      >
        {bucket.label}
      </text>
      <text
        x="1000"
        y="0"
        fill="#9fb4c8"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="26"
        fontWeight="800"
        textAnchor="end"
      >
        {bucket.percentageLabel} / {bucket.durationLabel}
      </text>
      <rect x="0" y="24" width="1000" height="22" rx="11" fill="#1f3347" />
      <rect x="0" y="24" width={width} height="22" rx="11" fill="url(#share-card-time-bars)" />
    </g>
  );
}

function truncateDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function splitTitleLines(value: string): [string] | [string, string] {
  if (value.length <= 24) return [value];

  const words = value.split(' ');
  const firstLine: string[] = [];
  const secondLine: string[] = [];
  for (const word of words) {
    const target = firstLine.join(' ').length < 24 ? firstLine : secondLine;
    target.push(word);
  }

  const first = truncateDisplay(firstLine.join(' ') || value, 30);
  const second = truncateDisplay(secondLine.join(' '), 30);
  return second ? [first, second] : [first];
}

function percentWidth(percent: number, width: number): number {
  return Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
}

type ShareCardTone = {
  accent: string;
  aura: string;
  pillFill: string;
  pillText: string;
  pillWidth: number;
};

const SHARE_TONES: Record<RunCompletionShareCardOutcome, ShareCardTone> = {
  success: {
    accent: '#14b8a6',
    aura: '#14b8a6',
    pillFill: '#123f3d',
    pillText: '#a7f3d0',
    pillWidth: 318,
  },
  failure: {
    accent: '#f43f5e',
    aura: '#fb7185',
    pillFill: '#471b2c',
    pillText: '#fecdd3',
    pillWidth: 248,
  },
};
