import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  type RunCompletionShareCardProps,
} from './RunCompletionShareCard.js';

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

export async function renderShareCardPngBlob(
  svg: SVGSVGElement,
  environment: ShareCardExportEnvironment = defaultEnvironment(),
): Promise<Blob> {
  const canvas = environment.document.createElement('canvas') as CanvasLike;
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;

  const context = canvas.getContext('2d');
  if (!context) throw new ShareCardExportError('encoding-failed');

  await drawSvgToCanvas(svg, canvas, context, environment);
  if (canvas.width !== SHARE_CARD_WIDTH || canvas.height !== SHARE_CARD_HEIGHT) {
    throw new ShareCardExportError('dimension-mismatch');
  }

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

class ShareCardExportError extends Error {
  constructor(readonly kind: 'encoding-failed' | 'dimension-mismatch') {
    super(kind);
  }
}
