import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  type RunCompletionShareCardBucket,
  type RunCompletionShareCardOutcome,
  type RunCompletionShareCardProps,
  type RunCompletionShareCardTimeBucket,
  type RunCompletionShareCardWorkDelta,
} from './RunCompletionShareCard.js';
import type { RunCompletionStats } from '../types/events.js';

const numberFormat = new Intl.NumberFormat('en-US');
const compactNumberFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
});
const MAX_BUCKET_ROWS = 5;
const MAX_TIME_BUCKET_ROWS = 3;
const MAX_DISPLAY_NAME_LENGTH = 76;
const MAX_BUCKET_LABEL_LENGTH = 34;

export type ShareCardCopyStatus =
  | { ok: true; kind: 'copied' }
  | {
      ok: false;
      kind: 'unsupported' | 'permission-denied' | 'encoding-failed' | 'dimension-mismatch';
    };

export type ShareCardDownloadStatus =
  | { ok: true; filename: string }
  | { ok: false; kind: 'encoding-failed' | 'dimension-mismatch' };

type CanvasLike = HTMLCanvasElement & {
  getContext(type: '2d'): Pick<CanvasRenderingContext2D, 'drawImage'> | null;
};

type ShareCardExportEnvironment = {
  document: Pick<Document, 'createElement'>;
  Image: {
    new (): HTMLImageElement;
  };
  XMLSerializer: {
    new (): Pick<XMLSerializer, 'serializeToString'>;
  };
  URL: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  navigator?: {
    clipboard?: {
      write?: (items: ClipboardItem[]) => Promise<void>;
    };
  };
  ClipboardItem?: {
    new (items: Record<string, Blob>): ClipboardItem;
  };
};

export function buildRunCompletionShareCardProps(
  stats: RunCompletionStats,
): RunCompletionShareCardProps | null {
  if (stats.outcome !== 'success' && stats.outcome !== 'failure') return null;

  const outcome: RunCompletionShareCardOutcome = stats.outcome;
  const durationLabel = formatDuration(stats.duration.elapsedMs);
  const totalTurnCount = stats.mainTurnCount + stats.subthreadTurnCount;
  const totalTokens = stats.tokenTotals.totalTokens;
  const mainTokenPercent = safePercent(stats.tokenTotals.mainTokens, totalTokens);
  const subthreadTokenPercent = safePercent(stats.tokenTotals.subthreadTokens, totalTokens);
  const workDeltaLabels = buildWorkDeltaLabels(stats);

  return {
    fsmDisplayName: truncateDisplay(sanitizeDisplay(stats.fsmDisplayName), MAX_DISPLAY_NAME_LENGTH),
    outcome,
    durationLabel,
    totalTimeLabel: durationLabel,
    transitionCountLabel: formatNumber(stats.transitionCount),
    freshClearCountLabel: formatNumber(stats.freshClearCount),
    totalTurnCountLabel: formatNumber(totalTurnCount),
    mainTurnCountLabel: formatNumber(stats.mainTurnCount),
    subthreadTurnCountLabel: formatNumber(stats.subthreadTurnCount),
    totalTokenLabel: formatCompactNumber(stats.tokenTotals.totalTokens),
    mainTokenLabel: formatCompactNumber(stats.tokenTotals.mainTokens),
    subthreadTokenLabel: formatCompactNumber(stats.tokenTotals.subthreadTokens),
    cacheHitPercentageLabel: formatPercent(
      safePercent(stats.tokenTotals.cachedInputTokens, stats.tokenTotals.inputTokens),
    ),
    outputTokenLabel: formatCompactNumber(stats.tokenTotals.outputTokens),
    mainTokenPercent,
    subthreadTokenPercent,
    mainTokenPercentageLabel: formatPercent(mainTokenPercent),
    subthreadTokenPercentageLabel: formatPercent(subthreadTokenPercent),
    filesChangedLabel: workDeltaLabels.filesChangedLabel,
    linesChangedLabel: workDeltaLabels.linesChangedLabel,
    lineDeltaDetailLabel: workDeltaLabels.lineDeltaDetailLabel,
    workDelta: workDeltaLabels.workDelta,
    buckets: buildBucketRows(stats),
    topTimeBuckets: buildTopTimeBuckets(stats),
  };
}

export async function renderShareCardPngBlob(
  svg: SVGSVGElement,
  environment: ShareCardExportEnvironment = defaultEnvironment(),
): Promise<Blob> {
  const canvas = environment.document.createElement('canvas') as CanvasLike;
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;

  const context = canvas.getContext('2d');
  if (!context) throw new ShareCardExportError('encoding-failed');
  assertShareCardCanvasDimensions(canvas);

  await drawSvgToCanvas(svg, canvas, context, environment);
  assertShareCardCanvasDimensions(canvas);
  return encodeCanvasPng(canvas);
}

export async function downloadShareCardPng(
  svg: SVGSVGElement,
  props: RunCompletionShareCardProps,
  environment: ShareCardExportEnvironment = defaultEnvironment(),
): Promise<ShareCardDownloadStatus> {
  try {
    const blob = await renderShareCardPngBlob(svg, environment);
    const filename = buildShareCardFilename(props);
    const url = environment.URL.createObjectURL(blob);
    const link = environment.document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    environment.URL.revokeObjectURL(url);
    return { ok: true, filename };
  } catch (error) {
    return { ok: false, kind: exportErrorKind(error) };
  }
}

export async function copyShareCardPng(
  svg: SVGSVGElement,
  environment: ShareCardExportEnvironment = defaultEnvironment(),
): Promise<ShareCardCopyStatus> {
  if (!environment.navigator?.clipboard?.write || !environment.ClipboardItem) {
    return { ok: false, kind: 'unsupported' };
  }

  try {
    const blob = await renderShareCardPngBlob(svg, environment);
    await environment.navigator.clipboard.write([
      new environment.ClipboardItem({ [blob.type || 'image/png']: blob }),
    ]);
    return { ok: true, kind: 'copied' };
  } catch (error) {
    if (error instanceof ShareCardExportError) return { ok: false, kind: error.kind };
    return { ok: false, kind: 'permission-denied' };
  }
}

export function buildShareCardFilename(props: RunCompletionShareCardProps): string {
  const name = props.fsmDisplayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54);
  return `aharness-${name || 'run'}-${props.outcome}.png`;
}

async function drawSvgToCanvas(
  svg: SVGSVGElement,
  canvas: CanvasLike,
  context: Pick<CanvasRenderingContext2D, 'drawImage'>,
  environment: ShareCardExportEnvironment,
): Promise<void> {
  const serialized = new environment.XMLSerializer().serializeToString(svg);
  const source = serialized.includes('xmlns=')
    ? serialized
    : serialized.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = environment.URL.createObjectURL(svgBlob);
  try {
    const image = new environment.Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new ShareCardExportError('encoding-failed'));
      image.src = objectUrl;
    });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    environment.URL.revokeObjectURL(objectUrl);
  }
}

function encodeCanvasPng(canvas: CanvasLike): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new ShareCardExportError('encoding-failed'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function exportErrorKind(error: unknown): 'encoding-failed' | 'dimension-mismatch' {
  return error instanceof ShareCardExportError ? error.kind : 'encoding-failed';
}

function assertShareCardCanvasDimensions(canvas: CanvasLike): void {
  if (canvas.width !== SHARE_CARD_WIDTH || canvas.height !== SHARE_CARD_HEIGHT) {
    throw new ShareCardExportError('dimension-mismatch');
  }
}

function defaultEnvironment(): ShareCardExportEnvironment {
  return {
    document,
    Image,
    XMLSerializer,
    URL,
    navigator,
    ClipboardItem: typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem,
  };
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

function buildTopTimeBuckets(stats: RunCompletionStats): RunCompletionShareCardTimeBucket[] {
  const visible = stats.stateBuckets.slice(0, MAX_TIME_BUCKET_ROWS);
  const remaining = stats.stateBuckets.slice(MAX_TIME_BUCKET_ROWS);
  const denominator =
    stats.duration.elapsedMs !== undefined
      ? stats.duration.elapsedMs
      : stats.stateBuckets.reduce((total, bucket) => total + bucket.elapsedMs, 0);
  const rows = visible.map((bucket) => {
    const percent = safePercent(bucket.elapsedMs, denominator);
    return {
      label: truncateDisplay(sanitizeDisplay(bucket.label), MAX_BUCKET_LABEL_LENGTH),
      durationLabel: formatDuration(bucket.elapsedMs),
      percent,
      percentageLabel: formatPercent(percent),
    };
  });

  if (remaining.length > 0) {
    const otherElapsedMs = remaining.reduce((total, bucket) => total + bucket.elapsedMs, 0);
    const percent = safePercent(otherElapsedMs, denominator);
    rows.push({
      label: 'Other states',
      durationLabel: formatDuration(otherElapsedMs),
      percent,
      percentageLabel: formatPercent(percent),
    });
  }

  return rows;
}

function buildWorkDeltaLabels(stats: RunCompletionStats): {
  filesChangedLabel: string;
  linesChangedLabel: string;
  lineDeltaDetailLabel: string;
  workDelta: RunCompletionShareCardWorkDelta;
} {
  if (stats.workDelta.status !== 'available') {
    const unavailableWorkDelta = {
      filesChangedLabel: 'N/A',
      linesAddedLabel: 'N/A',
      linesDeletedLabel: 'N/A',
    };
    return {
      filesChangedLabel: 'N/A',
      linesChangedLabel: 'N/A',
      lineDeltaDetailLabel: 'N/A',
      workDelta: unavailableWorkDelta,
    };
  }

  const linesChanged = stats.workDelta.linesAdded + stats.workDelta.linesDeleted;
  return {
    filesChangedLabel: formatNumber(stats.workDelta.filesChanged),
    linesChangedLabel: formatNumber(linesChanged),
    lineDeltaDetailLabel: `+${formatNumber(stats.workDelta.linesAdded)} / -${formatNumber(
      stats.workDelta.linesDeleted,
    )}`,
    workDelta: {
      filesChangedLabel: formatNumber(stats.workDelta.filesChanged),
      linesAddedLabel: formatNumber(stats.workDelta.linesAdded),
      linesDeletedLabel: formatNumber(stats.workDelta.linesDeleted),
    },
  };
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

function formatCompactNumber(value: number): string {
  const normalized = Math.max(0, value);
  if (normalized < 1_000_000) return formatNumber(normalized);
  return compactNumberFormat.format(normalized);
}

function safePercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

function formatPercent(value: number): string {
  return `${value}%`;
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

class ShareCardExportError extends Error {
  constructor(readonly kind: 'encoding-failed' | 'dimension-mismatch') {
    super(kind);
  }
}
