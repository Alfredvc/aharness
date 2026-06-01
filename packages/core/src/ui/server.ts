import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserReplyResult } from './reply.js';
import { streamRunScopedSseEvents, type RunScopedSseEvent } from './runScopedSse.js';

export interface UiRunScopedRouteUnavailable {
  readonly ok: false;
  readonly error: 'run-event-log-unavailable';
  readonly diagnostics: ReadonlyArray<unknown>;
}

export type UiRunScopedBootstrapResult =
  | { readonly ok: true; readonly bootstrap: unknown }
  | UiRunScopedRouteUnavailable;

export type UiRunScopedRowPageResult =
  | {
      readonly ok: true;
      readonly rows: ReadonlyArray<unknown>;
      readonly nextCursor: string | null;
    }
  | UiRunScopedRouteUnavailable;

export type UiRunScopedEvent = RunScopedSseEvent;

export type UiRunScopedEventPageResult =
  | {
      readonly ok: true;
      readonly events: ReadonlyArray<UiRunScopedEvent>;
      readonly nextCursor: string | null;
      readonly diagnostics: ReadonlyArray<unknown>;
    }
  | { readonly ok: false; readonly error: 'invalid-event-cursor' }
  | {
      readonly ok: false;
      readonly error: 'event-cursor-out-of-range';
      readonly latestEventId: string | null;
    }
  | UiRunScopedRouteUnavailable;

export type UiRunScopedEventsAfterResult =
  | { readonly ok: true; readonly events: ReadonlyArray<UiRunScopedEvent> }
  | Exclude<UiRunScopedEventPageResult, { readonly ok: true }>;

export interface UiRunScopedRouteService {
  readonly runId: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getLatestEventId: () => string | null;
  readonly getBootstrap: <TRunMeta extends object, TTopology = unknown>(options: {
    readonly getRunMeta: () => TRunMeta;
    readonly topology?: TTopology;
    readonly recentLimit?: number;
  }) => UiRunScopedBootstrapResult;
  readonly getStateVisitRows: (
    stateVisitId: string,
    query?: { readonly cursor?: string | null; readonly limit?: number },
  ) => UiRunScopedRowPageResult;
  readonly getRecentRows: (query?: {
    readonly cursor?: string | null;
    readonly limit?: number;
  }) => UiRunScopedRowPageResult;
  readonly getEventPage: (query?: {
    readonly after?: string | null;
    readonly limit?: number;
  }) => UiRunScopedEventPageResult;
  readonly eventsAfter: (
    afterEventId?: string | null,
    options?: { readonly pageLimit?: number },
  ) => UiRunScopedEventsAfterResult;
}

export interface UiRunScopedRouteOptions<
  TRunMeta extends object = Record<string, unknown>,
  TTopology = unknown,
> {
  readonly activeRunId: string;
  readonly service: UiRunScopedRouteService;
  readonly getRunMeta: () => TRunMeta;
  readonly topology?: TTopology;
  readonly recentLimit?: number;
}

export type StartUiServerOptions = {
  host: string;
  port: number;
  uiToken: string;
  /**
   * @deprecated Legacy flat-event observation surface. The HTTP server no
   * longer exposes `/api/state`, `/api/stream`, or flat `/api/reply`.
   */
  eventLog?: unknown;
  replyHandler?: (payload: unknown) => BrowserReplyResult | Promise<BrowserReplyResult>;
  runScoped?: UiRunScopedRouteOptions;
};

export type UiServerHandle = {
  url: string;
  close(): Promise<void>;
};

type StreamCleanup = () => void;

const STATIC_ROOT = resolveStaticRoot();
const REPLY_BODY_LIMIT_BYTES = 32 * 1024;

function resolveStaticRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'static'),
    join(moduleDir, '..', '..', 'dist', 'ui', 'static'),
    join(moduleDir, '..', '..', '..', 'web-ui', 'dist'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return resolve(candidate);
    }
  }

  throw new Error('UI static index.html was not found; run `pnpm run build` first.');
}

export async function startUiServer(options: StartUiServerOptions): Promise<UiServerHandle> {
  const activeStreams = new Set<StreamCleanup>();
  const server = http.createServer((request, response) => {
    void handleRequest(options, activeStreams, request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: 'ui-server-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      response.destroy(error instanceof Error ? error : undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };

    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('UI server did not bind to a TCP address');
  }

  return {
    url: formatServerUrl(address),
    close: async () => {
      for (const cleanup of [...activeStreams]) {
        cleanup();
      }
      await closeServer(server);
    },
  };
}

function formatServerUrl(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function handleRequest(
  options: StartUiServerOptions,
  activeStreams: Set<StreamCleanup>,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (await handleRunScopedRequest(options, activeStreams, request, response, url, path, method)) {
    return;
  }

  if (serveStatic(path, method, response)) {
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

type RunScopedRoute =
  | { readonly kind: 'bootstrap'; readonly runId: string }
  | { readonly kind: 'visit-rows'; readonly runId: string; readonly visitId: string }
  | { readonly kind: 'recent-rows'; readonly runId: string }
  | { readonly kind: 'events'; readonly runId: string }
  | { readonly kind: 'stream'; readonly runId: string }
  | { readonly kind: 'reply'; readonly runId: string };

async function handleRunScopedRequest(
  options: StartUiServerOptions,
  activeStreams: Set<StreamCleanup>,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  path: string,
  method: string,
): Promise<boolean> {
  const route = parseRunScopedRoute(path);
  if (route.kind === 'not-run-scoped') {
    return false;
  }

  if (route.kind === 'not-found') {
    sendJson(response, 404, { error: 'run-scoped-route-not-found' });
    return true;
  }

  const allow = runScopedRouteAllow(route);
  if (method !== allow) {
    sendMethodNotAllowed(response, allow);
    return true;
  }

  if (!isAuthorized(options, request, url, runScopedRouteAuthMode(route))) {
    sendUnauthorized(response);
    return true;
  }

  const runScoped = options.runScoped;
  if (
    runScoped === undefined ||
    runScoped.activeRunId !== route.runId ||
    runScoped.service.runId !== route.runId
  ) {
    sendJson(response, 404, { error: 'run-not-found' });
    return true;
  }

  switch (route.kind) {
    case 'bootstrap':
      sendRunScopedResult(
        response,
        runScoped.service.getBootstrap({
          getRunMeta: runScoped.getRunMeta,
          ...(runScoped.topology !== undefined ? { topology: runScoped.topology } : {}),
          ...(runScoped.recentLimit !== undefined ? { recentLimit: runScoped.recentLimit } : {}),
        }),
        (result) => result.bootstrap,
      );
      return true;
    case 'visit-rows':
      sendRunScopedResult(
        response,
        runScoped.service.getStateVisitRows(route.visitId, rowPageQuery(url)),
        (result) => ({ rows: result.rows, nextCursor: result.nextCursor }),
      );
      return true;
    case 'recent-rows':
      sendRunScopedResult(
        response,
        runScoped.service.getRecentRows(rowPageQuery(url)),
        (result) => ({ rows: result.rows, nextCursor: result.nextCursor }),
      );
      return true;
    case 'events':
      sendRunScopedEventPage(response, runScoped.service.getEventPage(eventPageQuery(url)));
      return true;
    case 'stream':
      streamRunScopedSseEvents({
        queryService: runScoped.service,
        request,
        response,
        url,
        activeStreams,
      });
      return true;
    case 'reply':
      await handleReplyRequest(options.replyHandler, request, response);
      return true;
  }
}

function parseRunScopedRoute(
  path: string,
): { readonly kind: 'not-run-scoped' } | { readonly kind: 'not-found' } | RunScopedRoute {
  const rawSegments = path.split('/');
  if (rawSegments[1] !== 'api' || rawSegments[2] !== 'runs') {
    return { kind: 'not-run-scoped' };
  }

  const runId = decodePathSegment(rawSegments[3]);
  if (runId === null) {
    return { kind: 'not-found' };
  }

  const segment4 = rawSegments[4];
  if (rawSegments.length === 5 && segment4 === 'bootstrap') {
    return { kind: 'bootstrap', runId };
  }
  if (rawSegments.length === 5 && segment4 === 'events') {
    return { kind: 'events', runId };
  }
  if (rawSegments.length === 5 && segment4 === 'stream') {
    return { kind: 'stream', runId };
  }
  if (rawSegments.length === 5 && segment4 === 'reply') {
    return { kind: 'reply', runId };
  }
  if (rawSegments.length === 6 && segment4 === 'rows' && rawSegments[5] === 'recent') {
    return { kind: 'recent-rows', runId };
  }
  if (rawSegments.length === 7 && segment4 === 'visits' && rawSegments[6] === 'rows') {
    const visitId = decodePathSegment(rawSegments[5]);
    return visitId === null ? { kind: 'not-found' } : { kind: 'visit-rows', runId, visitId };
  }

  return { kind: 'not-found' };
}

function decodePathSegment(rawSegment: string | undefined): string | null {
  if (rawSegment === undefined || rawSegment.length === 0) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(rawSegment);
    return decoded.length > 0 && !decoded.includes('/') ? decoded : null;
  } catch {
    return null;
  }
}

function runScopedRouteAllow(route: RunScopedRoute): 'GET' | 'POST' {
  return route.kind === 'reply' ? 'POST' : 'GET';
}

function runScopedRouteAuthMode(route: RunScopedRoute): TokenMode {
  if (route.kind === 'stream') return 'query-only';
  if (route.kind === 'reply') return 'header-only';
  return 'header-or-query';
}

function rowPageQuery(url: URL): { readonly cursor?: string | null; readonly limit?: number } {
  const cursor = url.searchParams.get('cursor');
  const limit = optionalNumber(url.searchParams.get('limit'));
  return {
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function eventPageQuery(url: URL): { readonly after?: string | null; readonly limit?: number } {
  const after = url.searchParams.get('after');
  const limit = optionalNumber(url.searchParams.get('limit'));
  return {
    ...(after !== null ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function optionalNumber(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

function sendRunScopedResult<TOk extends { readonly ok: true }>(
  response: http.ServerResponse,
  result: TOk | UiRunScopedRouteUnavailable,
  okBody: (result: TOk) => unknown,
): void {
  if (!result.ok) {
    sendRunEventLogUnavailable(response, result.diagnostics);
    return;
  }

  sendJson(response, 200, okBody(result));
}

function sendRunScopedEventPage(
  response: http.ServerResponse,
  result: UiRunScopedEventPageResult,
): void {
  if (result.ok) {
    sendJson(response, 200, {
      events: result.events,
      nextCursor: result.nextCursor,
      diagnostics: result.diagnostics,
    });
    return;
  }

  if (result.error === 'run-event-log-unavailable') {
    sendRunEventLogUnavailable(response, result.diagnostics);
    return;
  }

  if (result.error === 'event-cursor-out-of-range') {
    sendJson(response, 409, {
      error: result.error,
      latestEventId: result.latestEventId,
    });
    return;
  }

  sendJson(response, 400, { error: result.error });
}

function sendRunEventLogUnavailable(
  response: http.ServerResponse,
  diagnostics: ReadonlyArray<unknown>,
): void {
  sendJson(response, 503, { error: 'run-event-log-unavailable', diagnostics });
}

type TokenMode = 'header-or-query' | 'query-only' | 'header-only';

function isAuthorized(
  options: StartUiServerOptions,
  request: http.IncomingMessage,
  url: URL,
  mode: TokenMode,
): boolean {
  const header = readSingleHeader(request.headers['x-aharness-ui-token']);
  const query = url.searchParams.get('token');
  if (mode === 'header-or-query') {
    return header === options.uiToken || query === options.uiToken;
  }
  if (mode === 'query-only') {
    return query === options.uiToken;
  }
  return header === options.uiToken;
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendUnauthorized(response: http.ServerResponse): void {
  sendJson(response, 401, { error: 'unauthorized' });
}

async function handleReplyRequest(
  replyHandler: StartUiServerOptions['replyHandler'],
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const readResult = await readJsonRequestBody(request, REPLY_BODY_LIMIT_BYTES);
  if (readResult.kind === 'too-large') {
    sendJson(response, 413, { error: 'reply-body-too-large' });
    return;
  }

  if (readResult.kind === 'malformed-json') {
    sendJson(response, 400, { error: 'malformed-json' });
    return;
  }

  if (replyHandler === undefined) {
    sendJson(response, 503, { error: 'reply-handler-unavailable' });
    return;
  }

  const result = await replyHandler(readResult.payload);
  sendJson(response, result.status, result.body);
}

type JsonBodyReadResult =
  | { kind: 'ok'; payload: unknown }
  | { kind: 'malformed-json' }
  | { kind: 'too-large' };

function readJsonRequestBody(
  request: http.IncomingMessage,
  limitBytes: number,
): Promise<JsonBodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let tooLarge = false;

    request.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > limitBytes) {
        tooLarge = true;
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) {
        resolve({ kind: 'too-large' });
        return;
      }

      try {
        resolve({ kind: 'ok', payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ kind: 'malformed-json' });
      }
    });

    request.on('error', () => {
      resolve({ kind: 'malformed-json' });
    });
  });
}

function serveStatic(path: string, method: string, response: http.ServerResponse): boolean {
  const relativePath = staticRelativePath(path);
  if (relativePath === null) {
    return false;
  }

  if (method !== 'GET') {
    sendMethodNotAllowed(response, 'GET');
    return true;
  }

  const filePath = resolve(STATIC_ROOT, relativePath);
  if (!isInsideStaticRoot(filePath) || !isReadableFile(filePath)) {
    sendJson(response, 404, { error: 'Not found' });
    return true;
  }

  // Each run prints a fresh per-process URL, so caching the bundle across
  // runs is never desirable: the user iterates on the aharness and expects
  // the new code, not whatever the browser cached. Tell the browser not to
  // hold on to anything we serve from here.
  response.setHeader('cache-control', 'no-store, must-revalidate');
  sendBuffer(response, 200, contentTypeFor(filePath), readFileSync(filePath));
  return true;
}

function staticRelativePath(path: string): string | null {
  if (path === '/' || path === '/index.html') {
    return 'index.html';
  }

  if (!path.startsWith('/assets/')) {
    return null;
  }

  try {
    return decodeURIComponent(path.slice(1));
  } catch {
    return 'assets/__invalid__';
  }
}

function isInsideStaticRoot(filePath: string): boolean {
  const relativePath = relative(STATIC_ROOT, filePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isReadableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function sendMethodNotAllowed(response: http.ServerResponse, allow: string): void {
  response.statusCode = 405;
  response.setHeader('allow', allow);
  response.end();
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  sendText(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(body));
}

function sendBuffer(
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', contentType);
  response.end(body);
}

function sendText(
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', contentType);
  response.end(body);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
