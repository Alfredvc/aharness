import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunMeta } from '../src/ui/events.js';
import type { BrowserReplyResult } from '../src/ui/reply.js';
import { startUiServer, type StartUiServerOptions, type UiServerHandle } from '../src/ui/server.js';
import { createUiEventLog, type UiEventLog } from '../src/ui/sse.js';

const runMeta: RunMeta = {
  runId: 'run-1',
  threadId: 'thread-1',
  repoRoot: '/repo',
  fsmFile: 'agent.fsm.ts',
  fsmHash6: 'abc123',
  codexPin: 'codex-test',
  startedAt: '2026-05-13T00:00:00.000Z',
};

const handles: UiServerHandle[] = [];
const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/ui/static');
const TEST_UI_TOKEN = 'test-ui-token';

afterEach(async () => {
  const openHandles = handles.splice(0);
  await Promise.all(openHandles.map((handle) => handle.close()));
});

type TestReplyHandler = (payload: unknown) => BrowserReplyResult | Promise<BrowserReplyResult>;

async function startTestServer(
  eventLog: UiEventLog,
  replyHandler?: TestReplyHandler,
  runScoped?: StartUiServerOptions['runScoped'],
): Promise<UiServerHandle> {
  const handle = await startUiServer({
    host: '127.0.0.1',
    port: 0,
    uiToken: TEST_UI_TOKEN,
    eventLog,
    replyHandler,
    ...(runScoped === undefined ? {} : { runScoped }),
  });
  handles.push(handle);
  return handle;
}

function builtAssetPath(extension: 'css' | 'js'): string {
  const indexHtml = readFileSync(resolve(staticRoot, 'index.html'), 'utf8');
  const matches = [...indexHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)];
  const asset = matches.map((match) => match[1]).find((path) => path.endsWith(`.${extension}`));

  if (asset === undefined) {
    throw new Error(`Built ${extension} asset was not referenced by static index.html`);
  }

  return `/${asset}`;
}

describe('startUiServer', () => {
  it('returns the chosen loopback URL and a close handle', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof handle.close).toBe('function');
  });

  it('serves the built React index from / and /index.html', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    for (const path of ['/', '/index.html']) {
      const response = await fetch(`${handle.url}${path}`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(body).toContain('<title>aharness · run</title>');
      expect(body).toContain('<div id="root">');
      expect(body).toContain('id="aharness-preboot"');
      expect(body).toMatch(/(?:src|href)="\.\/assets\/index-[^"]+\.(?:js|css)"/);
    }
  });

  it('serves built assets with run-scoped production endpoints and correct content types', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const jsResponse = await fetch(`${handle.url}${builtAssetPath('js')}`);
    const jsBody = await jsResponse.text();
    const cssResponse = await fetch(`${handle.url}${builtAssetPath('css')}`);
    const cssBody = await cssResponse.text();

    expect(jsResponse.status).toBe(200);
    expect(jsResponse.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
    expect(jsBody).toContain('/api/runs/');
    expect(jsBody).not.toContain('/api/state');
    expect(jsBody).not.toContain('/api/stream');
    expect(jsBody).not.toContain('/api/reply');
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(cssBody).toContain('font-family');
  });

  it('returns 404 for unknown static files and rejects encoded traversal', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const missing = await fetch(`${handle.url}/assets/missing.js`);
    const traversal = await fetch(`${handle.url}/assets/%2e%2e/package.json`);
    const traversalBody = await traversal.text();

    expect(missing.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(traversalBody).not.toContain('"name"');
    expect(traversalBody).not.toContain('@aharness/core');
  });

  it('returns 405 for unsupported methods on static routes', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const indexResponse = await fetch(`${handle.url}/index.html`, { method: 'POST' });
    const assetResponse = await fetch(`${handle.url}${builtAssetPath('js')}`, { method: 'POST' });

    expect(indexResponse.status).toBe(405);
    expect(indexResponse.headers.get('allow')).toBe('GET');
    expect(assetResponse.status).toBe(405);
    expect(assetResponse.headers.get('allow')).toBe('GET');
  });

  it('does not serve flat snapshot-shaped browser API routes', async () => {
    const replyHandler = vi.fn<TestReplyHandler>().mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const handle = await startTestServer(createUiEventLog({ run: runMeta }), replyHandler);

    const stateResponse = await fetch(`${handle.url}/api/state?token=${TEST_UI_TOKEN}`);
    const streamResponse = await fetch(`${handle.url}/api/stream?token=${TEST_UI_TOKEN}`);
    const replyResponse = await fetch(`${handle.url}/api/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Aharness-Ui-Token': TEST_UI_TOKEN },
      body: JSON.stringify({ kind: 'user-prompt', text: 'continue' }),
    });

    expect(stateResponse.status).toBe(404);
    expect(streamResponse.status).toBe(404);
    expect(replyResponse.status).toBe(404);
    expect(replyHandler).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes and removed flat API methods', async () => {
    const handle = await startTestServer(createUiEventLog({ run: runMeta }));

    const unknown = await fetch(`${handle.url}/missing`);
    const unsupported = await fetch(`${handle.url}/api/state`, {
      method: 'POST',
    });

    expect(unknown.status).toBe(404);
    expect(unsupported.status).toBe(404);
    expect(unsupported.headers.get('allow')).toBeNull();
  });
});
