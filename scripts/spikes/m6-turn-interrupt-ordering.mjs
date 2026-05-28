#!/usr/bin/env node
// scripts/spikes/m6-turn-interrupt-ordering.mjs
//
// Spike M6 — `turn/interrupt` ordering, two modes.
// docs/ideas/2026-05-11-headless-spikes.md §M6.
//
// ## Two questions, one spike
//
// The original M6 asked: "can we drop the watcher prelude and just call
// `turn/interrupt` mid-tool?" (mode `interrupt-mid`). Empirical answer:
// NO — `EventMsg::TurnAborted` resolves the `turn/interrupt` request ~3ms
// after dispatch, while the in-flight tool's `item/completed` lands
// asynchronously seconds later (see `handle_task_abort` in
// `codex-rs/core/src/tasks/mod.rs:724-774` — hardcoded 100ms grace then
// `task.handle.abort()`, emit `TurnAborted` immediately).
//
// Reality-check from the agent-researcher pass (see git history of this
// file's earlier comment block plus the recommendation in the chat):
// codex offers no race-free "drain-then-abort" primitive. The only
// race-safe pattern is the one already in `packages/core/src/
// daemon/main.ts::scheduleCrossStateRestart`:
//
//   wait for in-flight tool's `item/completed`
//   → issue `turn/interrupt({threadId, turnId})`
//   → await `TurnAborted` (the interrupt's empty response)
//   → issue `turn/start({input: orientationText})`
//
// The new default mode (`drain-then-interrupt`) measures whether that
// dance produces a usable next turn with no stray events leaking from
// the aborted old turn.
//
// ## Mode `drain-then-interrupt` (default) — the production pattern
//
// Per run (default 50):
//
//   1. Spawn fresh codex `app-server`; one WS client; `initialize`;
//      `thread/start({cwd: tempdir})`.
//   2. `turn/start` with a prompt that calls ONE shell tool fast
//      (`echo READY`) then asks the model to write a long essay. The
//      essay creates back-pressure: the model is still generating tokens
//      when we interrupt.
//   3. Wait for that tool's `item/started`, then its `item/completed`
//      — the watcher signal. Record `t_drained`.
//   4. Immediately call `turn/interrupt({threadId, turnId})`. Record
//      `t_interruptSent` → `t_interruptReplied` (= TurnAborted).
//   5. Settle for `--settle-ms` (default 3000). Collect every
//      `item/completed` notification that arrives after `t_drained` and
//      tag whether it landed before or after `t_interruptReplied`.
//   6. Issue a SECOND `turn/start({input: "Respond with exactly one word: PONG"})`
//      and wait up to `--second-turn-timeout-ms` (default 30_000) for
//      the model's reply containing PONG.
//
// Pass criterion (this mode):
//
//   (a) Zero `item/completed` events arrive between `t_interruptReplied`
//       and the end of the settle window. (Stray = race or async drain
//       leak.)
//   (b) The second `turn/start` succeeds; an assistant-message
//       `item/completed` containing "PONG" arrives within the timeout.
//   (c) Rollout JSONL: every `function_call` has a matching
//       `function_call_output`.
//
// ## Mode `interrupt-mid` (legacy)
//
//   Original probe: wait `--interrupt-after-ms` (default 200) after the
//   first tool `item/started`, then interrupt while the tool is still
//   running. Documented to fail wire-level ordering per the M6 finding
//   above. Kept reachable for archeology / regression checks.
//
// ## Deviation from spike-doc locked decisions
//
// docs/ideas/2026-05-11-headless-spikes.md §"Decisions locked" picks
// `approval_policy = OnRequest` for the headless DAEMON. The spike opts
// OUT (`approval_policy=never`, `sandbox_mode=danger-full-access`) to
// keep the measurement free of approval ServerRequests. Production
// daemon uses the locked policy; the measurement harness does not.
//
// ## CLI
//
//   node scripts/spikes/m6-turn-interrupt-ordering.mjs
//     [--mode drain-then-interrupt|interrupt-mid]  (default drain-then-interrupt)
//     [--runs N]                                   (default 50)
//     [--settle-ms MS]                             (default mode-dependent)
//     [--second-turn-timeout-ms MS]                (default 30_000; drain mode)
//     [--interrupt-after-ms MS]                    (default 200; interrupt-mid mode)
//     [--sleep-secs S]                             (default 3; interrupt-mid mode)
//     [--captures-dir PATH]                        (default scripts/spikes/captures)
//     [--no-rollout-check]                         (skip ~/.codex/sessions verification)

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { spawnAppServer, connectJsonRpc, sleep, tomlStr, now } from './lib.mjs';

// ---------- arg parsing ------------------------------------------------------

const MODES = new Set(['drain-then-interrupt', 'interrupt-mid']);

function parseArgs(argv) {
  const opts = {
    mode: 'drain-then-interrupt',
    runs: 50,
    interruptAfterMs: 200,
    sleepSecs: 3,
    // null ⇒ auto-derive per mode (see resolveSettleMs).
    settleMs: null,
    secondTurnTimeoutMs: 30_000,
    capturesDir: null,
    rolloutCheck: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--mode':
        opts.mode = String(next());
        break;
      case '--runs':
        opts.runs = Number(next());
        break;
      case '--interrupt-after-ms':
        opts.interruptAfterMs = Number(next());
        break;
      case '--sleep-secs':
        opts.sleepSecs = Number(next());
        break;
      case '--settle-ms':
        opts.settleMs = Number(next());
        break;
      case '--second-turn-timeout-ms':
        opts.secondTurnTimeoutMs = Number(next());
        break;
      case '--captures-dir':
        opts.capturesDir = next();
        break;
      case '--no-rollout-check':
        opts.rolloutCheck = false;
        break;
      case '-h':
      case '--help':
        printUsageAndExit(0);
        break;
      default:
        process.stderr.write(`unknown arg: ${a}\n`);
        printUsageAndExit(2);
    }
  }
  if (!MODES.has(opts.mode))
    throw new Error(`--mode must be one of ${[...MODES].join(', ')}, got ${opts.mode}`);
  if (!Number.isFinite(opts.runs) || opts.runs <= 0)
    throw new Error(`--runs must be > 0, got ${opts.runs}`);
  if (!Number.isFinite(opts.interruptAfterMs) || opts.interruptAfterMs < 0)
    throw new Error(`--interrupt-after-ms must be >= 0`);
  if (!Number.isFinite(opts.sleepSecs) || opts.sleepSecs <= 0)
    throw new Error(`--sleep-secs must be > 0`);
  if (!Number.isFinite(opts.secondTurnTimeoutMs) || opts.secondTurnTimeoutMs <= 0)
    throw new Error(`--second-turn-timeout-ms must be > 0`);
  if (opts.settleMs === null) opts.settleMs = resolveSettleMs(opts);
  return opts;
}

function resolveSettleMs(opts) {
  // Mode-dependent default.
  if (opts.mode === 'interrupt-mid') {
    // Settle must outlast the in-flight bash sleep, else its item/completed
    // never lands and we'd record a spurious fail_no_item_completed.
    return opts.sleepSecs * 1000 + 2500;
  }
  // drain-then-interrupt: tool already completed before interrupt, so
  // we only need long enough to catch any stray post-TurnAborted events.
  return 3000;
}

function printUsageAndExit(code) {
  process.stderr.write(`Usage: node scripts/spikes/m6-turn-interrupt-ordering.mjs [opts]

  --mode <mode>                 drain-then-interrupt | interrupt-mid (default drain-then-interrupt)
  --runs N                      number of runs (default 50)
  --settle-ms MS                drain after interrupt (default mode-dependent)
  --second-turn-timeout-ms MS   wait for PONG after second turn/start (default 30000; drain mode)
  --interrupt-after-ms MS       delay from first tool item/started to interrupt (default 200; interrupt-mid mode)
  --sleep-secs S                seconds the model is asked to sleep (default 3; interrupt-mid mode)
  --captures-dir PATH           output root (default scripts/spikes/captures)
  --no-rollout-check            skip rollout JSONL verification
`);
  process.exit(code);
}

// ---------- one run ----------------------------------------------------------

const SHELL_PROMPT_LEGACY = (sleepSecs) =>
  `Use your shell tool to run the exact command: sleep ${sleepSecs}. ` +
  `Do not explain. Do not echo anything. Just run that one command.`;

// Drain-then-interrupt prompt: fast tool + verbose follow-up. The shell
// completes in <100ms; the model then enters a long generation that we
// interrupt. If turn/interrupt is clean, no further item/completed for
// this turn arrives after TurnAborted.
const SHELL_PROMPT_DRAIN_THEN_INTERRUPT = `Step 1: Use your shell tool to run the exact command: echo READY.

Step 2 (after the shell completes): Write a detailed multi-paragraph essay
about deep-sea cephalopods. Cover at least five species, their habitats,
their anatomy, their hunting strategies, and their evolutionary history.
Take your time and be thorough. Aim for at least 1500 words.`;

const SECOND_TURN_PROMPT = 'Respond with exactly one word: PONG';

// Item types we treat as non-tool conversational chatter and ignore when
// looking for "the in-flight tool call". Empirically observed values in
// codex's v2 item union: 'reasoning', 'agentMessage', 'userMessage',
// 'agentReasoning'. Anything else is candidate for the tool start.
const NON_TOOL_ITEM_TYPES = new Set([
  'reasoning',
  'agentReasoning',
  'agentMessage',
  'userMessage',
  'agentMessageDelta',
]);

// codex method-name literals — duplicated here so the spike has zero
// dependency on packages/core.
const M = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
};

async function runOnce(opts) {
  switch (opts.mode) {
    case 'drain-then-interrupt':
      return runOnceDrainThenInterrupt(opts);
    case 'interrupt-mid':
      return runOnceInterruptMid(opts);
    default:
      throw new Error(`unknown mode: ${opts.mode}`);
  }
}

// ---------- shared probe scaffold -------------------------------------------

// Sets up server + WS + initialize + thread/start; wires the standard
// notification subscriptions; returns a context object the mode-specific
// flow uses. Mode body is responsible for closing.
async function probeSetup({ runIdx, runDir }) {
  const wireLogPath = join(runDir, `run-${String(runIdx).padStart(3, '0')}.jsonl`);
  const wireFd = openAppend(wireLogPath);
  const wireWrite = (rec) => writeJsonl(wireFd, rec);

  const cwd = mkdtempSync(join(tmpdir(), `m6-cwd-`));

  const server = await spawnAppServer({
    cliOverrides: [
      ['approval_policy', tomlStr('never')],
      ['sandbox_mode', tomlStr('danger-full-access')],
    ],
    stderrSink: (s) => wireWrite({ kind: 'stderr', t: now(), data: s }),
  });

  const client = await connectJsonRpc(server.wsUrl, {
    onWire: (dir, msg, t) => wireWrite({ kind: dir, t, msg }),
  });

  await client.request(M.initialize, {
    clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  });

  return { server, client, cwd, wireLogPath, wireFd };
}

async function probeTeardown({ client, server, wireFd }) {
  try {
    if (client) await safeClose(client);
  } catch {
    // Best-effort client cleanup.
  }
  try {
    if (server) await server.close();
  } catch {
    // Best-effort server cleanup.
  }
  try {
    closeFd(wireFd);
  } catch {
    // Best-effort log cleanup.
  }
}

// ---------- mode: drain-then-interrupt --------------------------------------

async function runOnceDrainThenInterrupt({
  runIdx,
  runDir,
  settleMs,
  secondTurnTimeoutMs,
  startEpochMs,
}) {
  const ctx = await probeSetup({ runIdx, runDir, startEpochMs });
  const { client, wireLogPath } = ctx;

  let threadId = null;
  let firstTurnId = null;
  let secondTurnId = null;

  let t_firstTurnStartSent;
  let t_firstToolItemStarted = null;
  let toolItem = null;
  let t_toolItemCompleted = null;
  let toolCompletedItem = null;
  let t_interruptSent = null;
  let t_interruptReplied = null;
  let t_firstTurnCompleted = null;

  let t_secondTurnStartSent = null;
  let t_secondTurnStartReplied = null;
  let t_pongCompleted = null;
  let pongItemText = null;

  // Every item/completed observed, with timestamp + which turn-window it
  // belongs to (relative to interrupt timing). Drives stray analysis.
  const allItemCompleted = [];

  try {
    let resolveThreadId;
    const threadIdReady = new Promise((res) => (resolveThreadId = res));
    client.onNotification(M.threadStarted, (p) => {
      const id = p?.thread?.id;
      if (typeof id === 'string') resolveThreadId(id);
    });

    let resolveFirstTurnId;
    const firstTurnIdReady = new Promise((res) => (resolveFirstTurnId = res));
    let resolveSecondTurnId;
    const secondTurnIdReady = new Promise((res) => (resolveSecondTurnId = res));
    let onTurnStartedFor = 'first';
    client.onNotification(M.turnStarted, (p) => {
      const id = p?.turn?.id ?? p?.turnId;
      if (typeof id !== 'string') return;
      if (onTurnStartedFor === 'first') resolveFirstTurnId(id);
      else resolveSecondTurnId(id);
    });

    client.onNotification(M.turnCompleted, () => {
      if (t_firstTurnCompleted === null) t_firstTurnCompleted = now();
    });

    client.onNotification(M.itemStarted, (p) => {
      const item = p?.item;
      if (item === null || typeof item !== 'object') return;
      if (t_firstToolItemStarted !== null) return;
      const type = String(item.type ?? '');
      if (NON_TOOL_ITEM_TYPES.has(type)) return;
      t_firstToolItemStarted = now();
      toolItem = item;
    });

    client.onNotification(M.itemCompleted, (p) => {
      const item = p?.item;
      if (item === null || typeof item !== 'object') return;
      const tNow = now();
      // Phase buckets the item by which turn-lifecycle phase it belongs
      // to. Items at `tNow >= t_secondTurnStartSent` belong to the
      // second turn — NOT strays from the aborted first turn. Items in
      // the window (t_interruptReplied, t_secondTurnStartSent) are the
      // diagnostic stray set: anything emitted by codex AFTER the abort
      // confirmed but BEFORE the new turn was kicked off.
      let phase = 'pre_interrupt';
      if (t_secondTurnStartSent !== null && tNow >= t_secondTurnStartSent) {
        phase = 'second_turn';
      } else if (t_interruptReplied !== null && tNow > t_interruptReplied) {
        phase = 'after_interrupt';
      } else if (t_interruptSent !== null && tNow > t_interruptSent) {
        phase = 'between_send_and_reply';
      }
      allItemCompleted.push({ t: tNow, phase, type: item.type ?? null, item });

      // Capture the drain signal: matching item/completed for the tool we
      // watched. Same id/type matching as before.
      if (toolItem !== null && t_toolItemCompleted === null) {
        const sameId = toolItem.id && item.id && toolItem.id === item.id;
        const sameTypeAndCall = toolItem.type === item.type && toolItem.callId === item.callId;
        if (sameId || sameTypeAndCall || toolItem.type === item.type) {
          t_toolItemCompleted = tNow;
          toolCompletedItem = item;
        }
      }

      // Capture the PONG response. Only agentMessage counts — userMessage
      // events are codex echoing the prompt input back, not the model's
      // reply.
      if (
        t_pongCompleted === null &&
        t_secondTurnStartSent !== null &&
        tNow >= t_secondTurnStartSent &&
        String(item.type ?? '') === 'agentMessage'
      ) {
        const text = extractAgentMessageText(item);
        if (text !== null) {
          t_pongCompleted = tNow;
          pongItemText = text;
        }
      }
    });

    const startResp = await client.request(M.threadStart, { cwd: ctx.cwd });
    threadId = startResp?.thread?.id ?? (await threadIdReady);

    // ---- first turn: provoke a tool then long generation ----
    t_firstTurnStartSent = now();
    const firstTurnPromise = client.request(M.turnStart, {
      threadId,
      input: [{ type: 'text', text: SHELL_PROMPT_DRAIN_THEN_INTERRUPT }],
    });
    firstTurnPromise.then(
      (resp) => {
        const id = resp?.turn?.id;
        if (typeof id === 'string') resolveFirstTurnId(id);
      },
      () => {},
    );

    firstTurnId = await Promise.race([
      firstTurnIdReady,
      sleep(15_000).then(() => {
        throw new Error('timeout waiting for first turnId');
      }),
    ]);

    // Wait for tool item/started, then for its item/completed (the drain
    // signal). 30s cap because the model occasionally reasons for a while
    // before calling the tool.
    const toolStartedDeadline = now() + 30_000;
    while (t_firstToolItemStarted === null && now() < toolStartedDeadline) {
      await sleep(20);
    }
    if (t_firstToolItemStarted === null) {
      await probeTeardown(ctx);
      return finalizeDrain({
        runIdx,
        wireLogPath,
        threadId,
        firstTurnId,
        verdict: 'no_tool_called',
        startEpochMs,
        toolItem,
        toolCompletedItem,
        allItemCompleted,
      });
    }

    const drainDeadline = now() + 30_000;
    while (t_toolItemCompleted === null && now() < drainDeadline) {
      await sleep(20);
    }
    if (t_toolItemCompleted === null) {
      await probeTeardown(ctx);
      return finalizeDrain({
        runIdx,
        wireLogPath,
        threadId,
        firstTurnId,
        verdict: 'no_drain_signal',
        startEpochMs,
        toolItem,
        toolCompletedItem,
        allItemCompleted,
      });
    }

    // ---- interrupt immediately after drain ----
    t_interruptSent = now();
    let interruptError = null;
    try {
      await client.request(M.turnInterrupt, { threadId, turnId: firstTurnId });
    } catch (e) {
      interruptError = e?.message ?? String(e);
    }
    t_interruptReplied = now();

    // Settle to collect any stray item/completed for the aborted turn.
    await sleep(settleMs);

    // ---- second turn: prove the thread is usable post-dance ----
    onTurnStartedFor = 'second';
    t_secondTurnStartSent = now();
    let secondTurnError = null;
    try {
      const r = await client.request(M.turnStart, {
        threadId,
        input: [{ type: 'text', text: SECOND_TURN_PROMPT }],
      });
      t_secondTurnStartReplied = now();
      const id = r?.turn?.id;
      if (typeof id === 'string') resolveSecondTurnId(id);
    } catch (e) {
      secondTurnError = e?.message ?? String(e);
    }

    if (!secondTurnError) {
      try {
        secondTurnId = await Promise.race([secondTurnIdReady, sleep(5_000).then(() => null)]);
      } catch {
        // Missing turn id is handled by the timeout path below.
      }
      const pongDeadline = now() + secondTurnTimeoutMs;
      while (t_pongCompleted === null && now() < pongDeadline) {
        await sleep(50);
      }
    }

    await probeTeardown(ctx);

    return finalizeDrain({
      runIdx,
      wireLogPath,
      threadId,
      firstTurnId,
      secondTurnId,
      toolItem,
      toolCompletedItem,
      allItemCompleted,
      times: {
        t_firstTurnStartSent,
        t_firstToolItemStarted,
        t_toolItemCompleted,
        t_interruptSent,
        t_interruptReplied,
        t_firstTurnCompleted,
        t_secondTurnStartSent,
        t_secondTurnStartReplied,
        t_pongCompleted,
      },
      interruptError,
      secondTurnError,
      pongItemText,
      startEpochMs,
    });
  } catch (e) {
    await probeTeardown(ctx);
    return finalizeDrain({
      runIdx,
      wireLogPath,
      threadId,
      firstTurnId,
      verdict: 'error',
      error: e?.stack ?? e?.message ?? String(e),
      toolItem,
      toolCompletedItem,
      allItemCompleted,
      startEpochMs,
    });
  }
}

function extractAgentMessageText(item) {
  // Codex agentMessage items vary: { text } | { content: [{type:'text', text}] }
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) {
    const out = [];
    for (const c of item.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string') out.push(c.text);
    }
    if (out.length) return out.join('');
  }
  // Some shapes wrap under message.content
  if (item.message && Array.isArray(item.message.content)) {
    const out = [];
    for (const c of item.message.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string') out.push(c.text);
    }
    if (out.length) return out.join('');
  }
  return null;
}

function finalizeDrain({
  runIdx,
  wireLogPath,
  verdict: explicitVerdict,
  threadId,
  firstTurnId,
  secondTurnId,
  toolItem,
  toolCompletedItem,
  allItemCompleted = [],
  times,
  interruptError,
  secondTurnError,
  pongItemText,
  error,
  startEpochMs,
}) {
  let verdict = explicitVerdict ?? null;

  // Bucket items.
  const strayAfterInterrupt = allItemCompleted.filter((e) => e.phase === 'after_interrupt');
  const betweenSendAndReply = allItemCompleted.filter((e) => e.phase === 'between_send_and_reply');

  let abortClean = null;
  let secondTurnOk = null;
  let pongOk = null;

  if (verdict === null) {
    abortClean = strayAfterInterrupt.length === 0;
    secondTurnOk = !secondTurnError;
    pongOk = typeof pongItemText === 'string' && /\bPONG\b/i.test(pongItemText);
    if (!abortClean) verdict = 'fail_stray_after_interrupt';
    else if (!secondTurnOk) verdict = 'fail_second_turn_error';
    else if (!pongOk) verdict = 'fail_no_pong';
    else verdict = 'pass';
  }

  return {
    runIdx,
    mode: 'drain-then-interrupt',
    verdict,
    abortClean,
    secondTurnOk,
    pongOk,
    threadId,
    firstTurnId,
    secondTurnId,
    toolItemType: toolItem?.type ?? null,
    toolItemSnapshot: toolItem ?? null,
    toolCompletedItemSnapshot: toolCompletedItem ?? null,
    strayAfterInterruptCount: strayAfterInterrupt.length,
    strayAfterInterruptItems: strayAfterInterrupt.map((e) => ({
      t: e.t,
      type: e.type,
    })),
    betweenSendAndReplyCount: betweenSendAndReply.length,
    times: times ?? null,
    pongItemText: pongItemText ?? null,
    interruptError: interruptError ?? null,
    secondTurnError: secondTurnError ?? null,
    error: error ?? null,
    wireLogPath,
    startEpochMs,
  };
}

// ---------- mode: interrupt-mid (legacy) ------------------------------------

async function runOnceInterruptMid({
  runIdx,
  runDir,
  interruptAfterMs,
  sleepSecs,
  settleMs,
  startEpochMs,
}) {
  const ctx = await probeSetup({ runIdx, runDir, startEpochMs });
  const { client, wireLogPath } = ctx;

  let threadId = null;
  let turnId = null;
  let t_turnStartSent;
  let t_turnStartReplied = null;
  let t_firstToolItemStarted = null;
  let toolItem = null;
  let t_toolItemCompleted = null;
  let toolCompletedItem = null;
  let t_interruptSent;
  let t_interruptReplied;
  let t_turnCompleted = null;

  try {
    let resolveThreadId;
    const threadIdReady = new Promise((res) => (resolveThreadId = res));
    client.onNotification(M.threadStarted, (p) => {
      const id = p?.thread?.id;
      if (typeof id === 'string') resolveThreadId(id);
    });
    let resolveTurnId;
    const turnIdReady = new Promise((res) => (resolveTurnId = res));
    client.onNotification(M.turnStarted, (p) => {
      const id = p?.turn?.id ?? p?.turnId;
      if (typeof id === 'string') resolveTurnId(id);
    });
    client.onNotification(M.turnCompleted, () => {
      if (t_turnCompleted === null) t_turnCompleted = now();
    });
    client.onNotification(M.itemStarted, (p) => {
      const item = p?.item;
      if (item === null || typeof item !== 'object') return;
      if (t_firstToolItemStarted !== null) return;
      const type = String(item.type ?? '');
      if (NON_TOOL_ITEM_TYPES.has(type)) return;
      t_firstToolItemStarted = now();
      toolItem = item;
    });
    client.onNotification(M.itemCompleted, (p) => {
      const item = p?.item;
      if (item === null || typeof item !== 'object') return;
      if (toolItem === null) return;
      if (t_toolItemCompleted !== null) return;
      const sameId = toolItem.id && item.id && toolItem.id === item.id;
      const sameTypeAndCall = toolItem.type === item.type && toolItem.callId === item.callId;
      if (sameId || sameTypeAndCall || toolItem.type === item.type) {
        t_toolItemCompleted = now();
        toolCompletedItem = item;
      }
    });

    const startResp = await client.request(M.threadStart, { cwd: ctx.cwd });
    threadId = startResp?.thread?.id ?? (await threadIdReady);

    t_turnStartSent = now();
    const turnPromise = client.request(M.turnStart, {
      threadId,
      input: [{ type: 'text', text: SHELL_PROMPT_LEGACY(sleepSecs) }],
    });
    turnPromise.then(
      (resp) => {
        t_turnStartReplied = now();
        const id = resp?.turn?.id;
        if (typeof id === 'string') resolveTurnId(id);
      },
      () => {
        t_turnStartReplied = now();
      },
    );

    turnId = await Promise.race([
      turnIdReady,
      sleep(15_000).then(() => {
        throw new Error('timeout waiting for turnId');
      }),
    ]);

    const firstItemDeadline = now() + 15_000;
    while (t_firstToolItemStarted === null && now() < firstItemDeadline) {
      await sleep(20);
    }
    if (t_firstToolItemStarted === null) {
      await probeTeardown(ctx);
      return finalizeMid({
        runIdx,
        wireLogPath,
        verdict: 'no_tool_called',
        threadId,
        turnId,
        toolItem,
        startEpochMs,
      });
    }

    const interruptAt = t_firstToolItemStarted + interruptAfterMs;
    const wait = interruptAt - now();
    if (wait > 0) await sleep(wait);

    t_interruptSent = now();
    let interruptError = null;
    try {
      await client.request(M.turnInterrupt, { threadId, turnId });
    } catch (e) {
      interruptError = e?.message ?? String(e);
    }
    t_interruptReplied = now();

    await sleep(settleMs);

    await probeTeardown(ctx);

    return finalizeMid({
      runIdx,
      wireLogPath,
      threadId,
      turnId,
      toolItem,
      toolCompletedItem,
      times: {
        t_turnStartSent,
        t_turnStartReplied,
        t_firstToolItemStarted,
        t_toolItemCompleted,
        t_interruptSent,
        t_interruptReplied,
        t_turnCompleted,
      },
      interruptError,
      startEpochMs,
    });
  } catch (e) {
    await probeTeardown(ctx);
    return finalizeMid({
      runIdx,
      wireLogPath,
      verdict: 'error',
      error: e?.stack ?? e?.message ?? String(e),
      threadId,
      turnId,
      toolItem,
      startEpochMs,
    });
  }
}

function finalizeMid({
  runIdx,
  wireLogPath,
  verdict: explicitVerdict,
  threadId,
  turnId,
  toolItem,
  toolCompletedItem,
  times,
  interruptError,
  error,
  startEpochMs,
}) {
  let verdict = explicitVerdict ?? null;
  let orderingOk = null;
  let interruptCaughtInFlight = null;

  if (verdict === null) {
    interruptCaughtInFlight =
      times.t_toolItemCompleted === null ? true : times.t_toolItemCompleted > times.t_interruptSent;
    if (times.t_toolItemCompleted !== null && times.t_interruptReplied !== null) {
      orderingOk = times.t_toolItemCompleted < times.t_interruptReplied;
      verdict = orderingOk ? 'pass' : 'fail_ordering';
    } else if (times.t_toolItemCompleted === null) {
      verdict = 'fail_no_item_completed';
    } else {
      verdict = 'inconclusive';
    }
  }

  return {
    runIdx,
    mode: 'interrupt-mid',
    verdict,
    orderingOk,
    interruptCaughtInFlight,
    threadId,
    turnId,
    toolItemType: toolItem?.type ?? null,
    toolItemSnapshot: toolItem ?? null,
    toolCompletedItemSnapshot: toolCompletedItem ?? null,
    times: times ?? null,
    interruptError: interruptError ?? null,
    error: error ?? null,
    wireLogPath,
    startEpochMs,
  };
}

async function safeClose(client) {
  try {
    await client.close();
  } catch {
    // Best-effort client cleanup.
  }
}

// ---------- rollout JSONL verification --------------------------------------

// Find the rollout file for a threadId. codex writes either
// ~/.codex/sessions/<id>.jsonl or under date-bucketed subdirs; the spike
// scans both with `mtime > runStartEpochMs` to scope the search.
function findRolloutFile(threadId, runStartEpochMs) {
  const root = join(homedir(), '.codex', 'sessions');
  let st;
  try {
    st = statSync(root);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const candidates = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let s;
        try {
          s = statSync(p);
        } catch {
          continue;
        }
        if (s.mtimeMs < runStartEpochMs) continue;
        candidates.push(p);
      }
    }
  };
  walk(root);
  // Prefer filename match on threadId, else scan content of recents.
  const named = candidates.filter((p) => p.includes(threadId));
  if (named.length) return named[0];
  for (const p of candidates) {
    try {
      const head = readFileSync(p, 'utf8').slice(0, 4096);
      if (head.includes(threadId)) return p;
    } catch {
      // Ignore unreadable rollout candidates.
    }
  }
  return null;
}

function inspectRollout(path) {
  const txt = readFileSync(path, 'utf8');
  const fnCallIds = new Set();
  const fnOutputIds = new Set();
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex rollouts wrap items under various keys; the discriminator we
    // care about is the inner ResponseItem.type plus call_id.
    const visit = (v) => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const x of v) visit(x);
        return;
      }
      if (typeof v.type === 'string' && typeof v.call_id === 'string') {
        if (v.type === 'function_call') fnCallIds.add(v.call_id);
        else if (v.type === 'function_call_output') fnOutputIds.add(v.call_id);
      }
      for (const k of Object.keys(v)) visit(v[k]);
    };
    visit(obj);
  }
  const matched = [];
  const dangling = [];
  for (const id of fnCallIds) {
    if (fnOutputIds.has(id)) matched.push(id);
    else dangling.push(id);
  }
  return { fnCallIds: [...fnCallIds], fnOutputIds: [...fnOutputIds], matched, dangling };
}

// ---------- file helpers (minimal; avoid pulling in `fs.promises`) ----------

import { openSync, writeSync, closeSync } from 'node:fs';

function openAppend(path) {
  mkdirSync(dirname(path), { recursive: true });
  return openSync(path, 'a');
}
function writeJsonl(fd, obj) {
  writeSync(fd, JSON.stringify(obj) + '\n');
}
function closeFd(fd) {
  try {
    closeSync(fd);
  } catch {
    // Best-effort log cleanup.
  }
}

// ---------- main -------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const capturesRoot = resolvePath(opts.capturesDir ?? join(__dirname, 'captures'));
  const startEpochMs = Date.now();
  const runDir = join(capturesRoot, `m6-${startEpochMs}`);
  mkdirSync(runDir, { recursive: true });

  process.stderr.write(`[m6] captures → ${runDir}\n`);
  process.stderr.write(
    `[m6] mode=${opts.mode} runs=${opts.runs} settle_ms=${opts.settleMs}` +
      (opts.mode === 'interrupt-mid'
        ? ` interrupt_after_ms=${opts.interruptAfterMs} sleep_secs=${opts.sleepSecs}\n`
        : ` second_turn_timeout_ms=${opts.secondTurnTimeoutMs}\n`),
  );

  const summaries = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = Date.now();
    process.stderr.write(`[m6] run ${i + 1}/${opts.runs} … `);
    const summary = await runOnce({
      mode: opts.mode,
      runIdx: i,
      runDir,
      interruptAfterMs: opts.interruptAfterMs,
      sleepSecs: opts.sleepSecs,
      settleMs: opts.settleMs,
      secondTurnTimeoutMs: opts.secondTurnTimeoutMs,
      startEpochMs,
    });
    if (opts.rolloutCheck && summary.threadId) {
      const rolloutPath = findRolloutFile(summary.threadId, startEpochMs - 1000);
      summary.rollout = { path: rolloutPath };
      if (rolloutPath) {
        try {
          const inspected = inspectRollout(rolloutPath);
          summary.rollout = { path: rolloutPath, ...inspected };
        } catch (e) {
          summary.rollout.error = e?.message ?? String(e);
        }
      }
    }
    summaries.push(summary);
    const tail =
      summary.mode === 'drain-then-interrupt'
        ? ` stray=${summary.strayAfterInterruptCount ?? '?'}`
        : '';
    process.stderr.write(`${summary.verdict}${tail} (${Date.now() - t0}ms)\n`);
  }

  // Aggregate
  const buckets = {};
  for (const s of summaries) buckets[s.verdict] = (buckets[s.verdict] ?? 0) + 1;

  const summary = {
    spike: 'M6',
    mode: opts.mode,
    startEpochMs,
    opts,
    runs: summaries.length,
    verdictCounts: buckets,
    perRun: summaries,
  };

  let totalOk;
  if (opts.mode === 'drain-then-interrupt') {
    const rolloutOk = (s) =>
      !opts.rolloutCheck ||
      (s.rollout?.matched &&
        s.rollout.matched.length > 0 &&
        (s.rollout.dangling?.length ?? 0) === 0);
    totalOk = summaries.length > 0 && summaries.every((s) => s.verdict === 'pass' && rolloutOk(s));
    summary.passCount = summaries.filter((s) => s.verdict === 'pass').length;
    summary.totalStrayAfterInterrupt = summaries.reduce(
      (n, s) => n + (s.strayAfterInterruptCount ?? 0),
      0,
    );
  } else {
    const inflight = summaries.filter((s) => s.interruptCaughtInFlight === true);
    const passInflight = inflight.filter((s) => s.verdict === 'pass').length;
    summary.inflightRuns = inflight.length;
    summary.inflightPassRate = inflight.length === 0 ? null : passInflight / inflight.length;
    process.stderr.write(`[m6] in-flight subset: ${passInflight}/${inflight.length} passed\n`);
    const rolloutOk = (s) =>
      !opts.rolloutCheck || (s.rollout?.matched && s.rollout.matched.length > 0);
    totalOk = inflight.length > 0 && inflight.every((s) => s.verdict === 'pass' && rolloutOk(s));
  }

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`[m6] verdicts: ${JSON.stringify(buckets)}\n`);
  if (opts.mode === 'drain-then-interrupt') {
    process.stderr.write(`[m6] total stray-after-interrupt: ${summary.totalStrayAfterInterrupt}\n`);
  }

  process.exit(totalOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[m6] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
