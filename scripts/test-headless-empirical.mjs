#!/usr/bin/env node
/**
 * Empirical tests for headless-codex feasibility.
 *
 * Test 1: Subscription. Spawn app-server, connect single WS client.
 *   thread/start + turn/start with simple prompt. Log every notification
 *   received. Assert item/completed arrives at sole client.
 *
 * Test 2: Hook injection. Same as above, but pass `-c hooks.Stop=...` to
 *   app-server. Confirm Stop hook fires (script writes to a sentinel file).
 *
 * Test 3: request_user_input headless. Same client, prompt instructs model
 *   to call request_user_input. Confirm ServerRequest reaches sole client.
 *
 * Run from repo root:
 *   AHARNESS_HEADLESS_TEST_MODEL=gpt-5-mini node scripts/test-headless-empirical.mjs
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnAppServer } from '../packages/core/dist/appServer/spawn.js';
import { connectWs } from '../packages/core/dist/jsonrpc/wsTransport.js';
import { JsonRpcClient } from '../packages/core/dist/jsonrpc/client.js';

const REPO_ROOT = process.cwd();

const ts = () => new Date().toISOString().slice(11, 23);

function log(scope, msg) {
  console.log(`[${ts()}] [${scope}] ${msg}`);
}

async function initAndStart(client, log) {
  log('rpc', 'initialize');
  await client.request('initialize', {
    clientInfo: { name: 'headless-empirical', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  });
  log('rpc', 'thread/start');
  const t = await client.request('thread/start', { cwd: REPO_ROOT });
  log('rpc', `thread/start → ${JSON.stringify(t)}`);
  return t;
}

function attachLoggers(client, log, observed) {
  // Common app-server notifications.
  const kinds = [
    'thread/started',
    'turn/started',
    'turn/completed',
    'item/started',
    'item/completed',
    'rawResponseItem/completed',
    'thread/tokenUsage/updated',
    'thread/goalUpdated',
    'agentMessage/delta',
    'agentReasoning/delta',
    'mcpToolCall/started',
    'mcpToolCall/completed',
  ];
  for (const k of kinds) {
    client.onNotification(k, (params) => {
      observed.notifications.add(k);
      observed.events.push({ t: ts(), kind: k, params });
      log('notif', `${k} ${JSON.stringify(params).slice(0, 200)}`);
    });
  }

  // Wildcard: log unknown notifications by patching transport.
  // (JsonRpcClient drops unknown notifications silently — patch handleIncoming via a wrapper.)
  // Skip wildcard for now; codex's notification surface is bounded.
}

function attachServerRequestLoggers(client, log, observed) {
  // Known server-requests from codex.
  const requests = [
    'item/tool/requestUserInput',
    'tool/requestUserInput',
    'item/tool/applyPatchApprovalRequest',
    'tool/applyPatchApprovalRequest',
    'item/tool/execApprovalRequest',
    'tool/execApprovalRequest',
    'item/tool/dynamicCall',
    'tool/dynamicCall',
  ];
  for (const m of requests) {
    client.onServerRequest(m, async (params) => {
      observed.serverRequests.add(m);
      observed.events.push({ t: ts(), kind: `req:${m}`, params });
      log('srvreq', `${m} ${JSON.stringify(params).slice(0, 300)}`);
      // Auto-respond minimally so model proceeds.
      if (m.endsWith('/requestUserInput')) {
        const qs = params?.questions ?? [];
        const answers = {};
        for (const q of qs) answers[q.id] = { kind: 'text', text: 'blue' };
        return { answers };
      }
      if (m.endsWith('/applyPatchApprovalRequest') || m.endsWith('/execApprovalRequest')) {
        return { decision: 'denied' };
      }
      return null;
    });
  }
}

async function runTurn(client, threadId, prompt, log) {
  log('rpc', `turn/start prompt=${JSON.stringify(prompt)}`);
  const params = {
    threadId,
    input: [{ type: 'text', text: prompt }],
  };
  if (process.env.AHARNESS_HEADLESS_TEST_MODEL)
    params.model = process.env.AHARNESS_HEADLESS_TEST_MODEL;
  const r = await client.request('turn/start', params);
  log('rpc', `turn/start → ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

async function waitForTurnComplete(observed, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (observed.notifications.has('turn/completed')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ---------------- TEST 1 ----------------

async function test1Subscription() {
  log('test1', '=== Subscription test ===');
  const observed = { notifications: new Set(), serverRequests: new Set(), events: [] };
  const handle = await spawnAppServer({
    stderrSink: (s) => process.stderr.write(`[app-server] ${s}`),
  });
  log('test1', `app-server up at ${handle.wsUrl}`);
  const transport = await connectWs(handle.wsUrl);
  const client = new JsonRpcClient(transport);
  attachLoggers(client, (s, m) => log(`test1.${s}`, m), observed);
  attachServerRequestLoggers(client, (s, m) => log(`test1.${s}`, m), observed);

  try {
    const t = await initAndStart(client, (s, m) => log(`test1.${s}`, m));
    const threadId = t.threadId ?? t.thread?.id;
    if (!threadId) throw new Error(`no threadId in ${JSON.stringify(t)}`);
    await runTurn(
      client,
      threadId,
      'Reply with the literal text "OK" and stop. Do not use any tools.',
      (s, m) => log(`test1.${s}`, m),
    );
    const ok = await waitForTurnComplete(observed, 60_000);
    log('test1', `turn/completed received: ${ok}`);
    log('test1', `notifications observed: ${[...observed.notifications].join(', ')}`);
    log(
      'test1',
      `server-requests observed: ${[...observed.serverRequests].join(', ') || '(none)'}`,
    );
    const itemCompleted = observed.notifications.has('item/completed');
    const turnStarted = observed.notifications.has('turn/started');
    log('test1', `RESULT item/completed=${itemCompleted} turn/started=${turnStarted}`);
    return { itemCompleted, turnStarted, completed: ok, observed };
  } finally {
    await client.close();
    await handle.close();
  }
}

// ---------------- TEST 2 ----------------

async function test2HookInjection() {
  log('test2', '=== Hook injection test ===');
  const observed = { notifications: new Set(), serverRequests: new Set(), events: [] };
  const tmp = join(tmpdir(), `headless-hook-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const sentinel = join(tmp, 'stop-fired.txt');
  const hookScript = join(tmp, 'stop.sh');
  writeFileSync(
    hookScript,
    `#!/bin/sh\necho "stop-hook-fired at $(date -u +%FT%T)" >> "${sentinel}"\ncat > "${tmp}/stop-payload.json"\necho '{}'\n`,
    'utf8',
  );
  chmodSync(hookScript, 0o755);
  log('test2', `hook script ${hookScript}`);

  // Codex matcher-group format: array of objects each with hooks=[{type,command,timeout}]
  const escaped = `"${hookScript.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const tomlEntry = `[{hooks=[{type="command",command=${escaped},timeout=10}]}]`;
  const handle = await spawnAppServer({
    cliOverrides: [['hooks.Stop', tomlEntry]],
    stderrSink: (s) => process.stderr.write(`[app-server] ${s}`),
  });
  log('test2', `app-server up at ${handle.wsUrl}`);
  const transport = await connectWs(handle.wsUrl);
  const client = new JsonRpcClient(transport);
  attachLoggers(client, (s, m) => log(`test2.${s}`, m), observed);
  attachServerRequestLoggers(client, (s, m) => log(`test2.${s}`, m), observed);

  try {
    const t = await initAndStart(client, (s, m) => log(`test2.${s}`, m));
    const threadId = t.threadId ?? t.thread?.id;
    await runTurn(
      client,
      threadId,
      'Reply with the literal text "DONE" and stop. Do not use any tools.',
      (s, m) => log(`test2.${s}`, m),
    );
    await waitForTurnComplete(observed, 60_000);
    // Give hook a moment to fire after model finishes.
    await new Promise((r) => setTimeout(r, 1000));
    const fired = existsSync(sentinel);
    const content = fired ? readFileSync(sentinel, 'utf8') : '(not fired)';
    log('test2', `RESULT stop-hook fired=${fired}: ${content.trim()}`);
    return { fired, content };
  } finally {
    await client.close();
    await handle.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort temp directory cleanup.
    }
  }
}

// ---------------- TEST 3 ----------------

async function test3RequestUserInput() {
  log('test3', '=== request_user_input headless test ===');
  const observed = { notifications: new Set(), serverRequests: new Set(), events: [] };
  const handle = await spawnAppServer({
    enabledFeatures: ['default_mode_request_user_input'],
    stderrSink: (s) => process.stderr.write(`[app-server] ${s}`),
  });
  log('test3', `app-server up at ${handle.wsUrl}`);
  const transport = await connectWs(handle.wsUrl);
  const client = new JsonRpcClient(transport);
  attachLoggers(client, (s, m) => log(`test3.${s}`, m), observed);
  attachServerRequestLoggers(client, (s, m) => log(`test3.${s}`, m), observed);

  try {
    const t = await initAndStart(client, (s, m) => log(`test3.${s}`, m));
    const threadId = t.threadId ?? t.thread?.id;
    await runTurn(
      client,
      threadId,
      'Use the request_user_input tool ONCE to ask: "What is your favorite color?". After receiving the user reply, repeat their answer back and stop.',
      (s, m) => log(`test3.${s}`, m),
    );
    await waitForTurnComplete(observed, 60_000);
    const reqDelivered = observed.serverRequests.has('tool/requestUserInput');
    log('test3', `RESULT request_user_input delivered=${reqDelivered}`);
    return { reqDelivered };
  } finally {
    await client.close();
    await handle.close();
  }
}

// ---------------- main ----------------

async function main() {
  const which = process.argv[2] || 'all';
  const results = {};
  if (which === 'all' || which === '1') results.test1 = await test1Subscription();
  if (which === 'all' || which === '2') results.test2 = await test2HookInjection();
  if (which === 'all' || which === '3') results.test3 = await test3RequestUserInput();
  console.log('\n========== SUMMARY ==========');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
