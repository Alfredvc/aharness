import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserReplyResult } from './reply.js';
import { serializeSseEvent, type UiEventLog } from './sse.js';

export type StartUiServerOptions = {
  host: string;
  port: number;
  uiToken: string;
  eventLog: UiEventLog;
  replyHandler?: (payload: unknown) => BrowserReplyResult | Promise<BrowserReplyResult>;
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
    join(moduleDir, '..', '..', 'src', 'ui', 'static'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return resolve(candidate);
    }
  }

  throw new Error('UI static index.html was not found');
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

  if (path === '/api/state') {
    if (method !== 'GET') {
      sendMethodNotAllowed(response, 'GET');
      return;
    }
    if (!isAuthorized(options, request, url, 'header-or-query')) {
      sendUnauthorized(response);
      return;
    }

    sendJson(response, 200, options.eventLog.snapshot());
    return;
  }

  if (path === '/api/stream') {
    if (method !== 'GET') {
      sendMethodNotAllowed(response, 'GET');
      return;
    }
    if (!isAuthorized(options, request, url, 'query-only')) {
      sendUnauthorized(response);
      return;
    }

    streamEvents(options.eventLog, activeStreams, request, response, url);
    return;
  }

  if (path === '/api/reply') {
    if (method !== 'POST') {
      sendMethodNotAllowed(response, 'POST');
      return;
    }
    if (!isAuthorized(options, request, url, 'header-only')) {
      sendUnauthorized(response);
      return;
    }

    await handleReplyRequest(options.replyHandler, request, response);
    return;
  }

  if (serveStatic(path, method, response)) {
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
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

function streamEvents(
  eventLog: UiEventLog,
  activeStreams: Set<StreamCleanup>,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
): void {
  response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  });
  response.flushHeaders();

  let lastSentId = readStreamCursor(request, url);
  let closed = false;

  const writePendingEvents = () => {
    if (closed) {
      return;
    }

    for (const event of eventLog.eventsAfter(lastSentId)) {
      response.write(serializeSseEvent(event));
      lastSentId =
        event.event.kind === 'ResyncRequired' ? eventLog.snapshot().latestEventId : event.id;
    }
  };

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  const unsubscribe = eventLog.subscribe(writePendingEvents);
  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    unsubscribe();
    if (pollInterval !== null) {
      clearInterval(pollInterval);
    }
    activeStreams.delete(cleanup);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  };

  activeStreams.add(cleanup);
  request.on('close', cleanup);
  writePendingEvents();
  if (!closed) {
    pollInterval = setInterval(writePendingEvents, 250);
  }
}

function readLastEventId(request: http.IncomingMessage): string | null {
  const header = request.headers['last-event-id'];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }

  return header ?? null;
}

function readStreamCursor(request: http.IncomingMessage, url: URL): string | null {
  return readLastEventId(request) ?? url.searchParams.get('after');
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
