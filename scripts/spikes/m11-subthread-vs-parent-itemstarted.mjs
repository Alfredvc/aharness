#!/usr/bin/env node
// scripts/spikes/m11-subthread-vs-parent-itemstarted.mjs
//
// Spike M11 — sub-thread `ThreadStarted` vs parent `ItemStarted(spawn_agent)`.
// docs/ideas/2026-05-11-headless-spikes.md §M11.
//
// ## Question
//
// When the model calls `spawn_agent`, two notifications race onto the parent
// thread's WS connection from independent tokio tasks
// (`thread_manager.rs:1204-1206`, `lib.rs:1022-1049`):
//
//   - parent `item/started` for the `collabAgentToolCall` (item.type =
//     "collabAgentToolCall", item.tool = "spawnAgent"); fired from the
//     parent's turn dispatch path.
//   - sub-thread `thread/started`, fired by the thread manager after the
//     new agent's thread is created, then delivered to the parent's WS
//     connection via the auto-attach in `app-server/src/lib.rs:1022-1049`
//     (every initialized connection is subscribed to every newly-created
//     thread in this app-server).
//
// How often does the sub-thread `thread/started` arrive on the wire BEFORE
// the parent's `item/started`? The frequency determines whether the daemon
// can rely on simple gating (parent first, always) or must buffer/replay
// (defensive coding).
//
// ## What this spike measures
//
// Per run:
//
//   1. Spawn fresh codex `app-server`; one WS client; `initialize`;
//      `thread/start({cwd: tempdir})` — the *parent* thread.
//   2. `turn/start` with a prompt that asks the model to call `spawn_agent`
//      exactly once with a trivial message.
//   3. Subscribe to every notification on the WS. Tag each by
//      `params.threadId`. Record monotonic timestamps for:
//        - `t_parent_spawn_item_started`: parent `item/started` where
//          `item.type === "collabAgentToolCall" && item.tool === "spawnAgent"`.
//        - `t_subthread_thread_started`: any `thread/started` whose
//          `thread.id !== parentThreadId`.
//        - `t_subthread_turn_started`: first `turn/started` carrying a
//          `threadId !== parentThreadId`.
//        - `t_parent_spawn_item_completed`: parent `item/completed`
//          matching the same item.id from (1).
//   4. Tear down (we do NOT wait for the agent's natural completion — the
//      race we care about is the spawn-time arrival order).
//
// ## Pass criterion
//
// Quantified flip rate — the spike doc explicitly says this is not pass/fail.
// We emit:
//
//   - `subthreadFirstCount`  : t_subthread_thread_started < t_parent_spawn_item_started
//   - `parentFirstCount`     : t_parent_spawn_item_started < t_subthread_thread_started
//   - `tieCount`             : equal to the millisecond (clock granularity)
//   - `subthreadMissingCount`: parent item observed but no sub-thread event in window
//   - `parentMissingCount`   : sub-thread event observed but no parent item
//   - `inconclusiveCount`    : neither observed (model refused / timed out)
//
// The exit code is 0 if (subthreadFirstCount + parentFirstCount + tieCount)
// covers at least 80% of runs — i.e. the measurement is robust enough that
// the architecture decision (gating vs buffer-and-replay) can be made from it.
// Anything below 80% productive means the prompt isn't reliably triggering
// `spawn_agent` and the spike should be re-tuned.
//
// ## Cold vs warm
//
// `--cold-runs N` and `--warm-runs N` (default 25 each). Cold = fresh
// app-server per run. Warm = single app-server, fresh thread per run. The
// spike doc cites both conditions. "Warm" exercises the codex tokio
// runtime's caches and connection state across consecutive spawns.
//
// ## Deviation from spike-doc locked decisions
//
// Same as M6: production daemon uses `approval_policy = OnRequest`; the
// spike opts out (`approval_policy=never`, `sandbox_mode=danger-full-access`)
// to keep the wire clean of approval ServerRequests.
//
// ## CLI
//
//   node scripts/spikes/m11-subthread-vs-parent-itemstarted.mjs
//     [--cold-runs N]        (default 25)
//     [--warm-runs N]        (default 25)
//     [--observe-ms MS]      (default 8000; how long after turn/start to
//                             wait for spawn_agent notifications)
//     [--captures-dir PATH]  (default scripts/spikes/captures)

import { mkdirSync, writeFileSync, mkdtempSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { spawnAppServer, connectJsonRpc, sleep, tomlStr, now } from './lib.mjs';

// ---------- arg parsing ------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    coldRuns: 25,
    warmRuns: 25,
    observeMs: 8_000,
    capturesDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--cold-runs':
        opts.coldRuns = Number(next());
        break;
      case '--warm-runs':
        opts.warmRuns = Number(next());
        break;
      case '--observe-ms':
        opts.observeMs = Number(next());
        break;
      case '--captures-dir':
        opts.capturesDir = next();
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
  if (!Number.isFinite(opts.coldRuns) || opts.coldRuns < 0)
    throw new Error('--cold-runs must be >= 0');
  if (!Number.isFinite(opts.warmRuns) || opts.warmRuns < 0)
    throw new Error('--warm-runs must be >= 0');
  if (opts.coldRuns + opts.warmRuns === 0)
    throw new Error('at least one of --cold-runs or --warm-runs must be > 0');
  if (!Number.isFinite(opts.observeMs) || opts.observeMs <= 0)
    throw new Error('--observe-ms must be > 0');
  return opts;
}

function printUsageAndExit(code) {
  process.stderr.write(`Usage: node scripts/spikes/m11-subthread-vs-parent-itemstarted.mjs [opts]

  --cold-runs N           runs with fresh app-server each (default 25)
  --warm-runs N           runs reusing one app-server (default 25)
  --observe-ms MS         observation window after turn/start (default 8000)
  --captures-dir PATH     output root (default scripts/spikes/captures)
`);
  process.exit(code);
}

// ---------- prompt -----------------------------------------------------------

// Trivial spawn; we only care about wire timing, not the sub-agent's output.
// `fork_context: false` keeps the new thread independent — fewer messages on
// the wire to filter through. The trailing line is anti-stalling: some
// reasoning effort levels make the model hesitate before tool use.
const SPAWN_PROMPT =
  `Use the spawn_agent tool exactly once, RIGHT NOW. ` +
  `Call it with these arguments:\n` +
  `  message: "Print hello world and exit. Nothing else."\n` +
  `  fork_context: false\n` +
  `Do not explain what you are doing. Do not ask for confirmation. ` +
  `Just call the tool.`;

// codex method-name literals — duplicated here so the spike has zero
// dependency on packages/core.
const M = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
};

// ---------- one run ----------------------------------------------------------

async function runOnce({ runIdx, runDir, observeMs, condition, sharedServer, startEpochMs }) {
  const wireLogPath = join(runDir, `run-${String(runIdx).padStart(3, '0')}-${condition}.jsonl`);
  const wireFd = openAppend(wireLogPath);
  const wireWrite = (rec) => writeJsonl(wireFd, rec);

  const cwd = mkdtempSync(join(tmpdir(), `m11-cwd-`));

  let server = sharedServer;
  let ownedServer = false;
  if (server === null) {
    server = await spawnAppServer({
      cliOverrides: [
        ['approval_policy', tomlStr('never')],
        ['sandbox_mode', tomlStr('danger-full-access')],
      ],
      stderrSink: (s) => wireWrite({ kind: 'stderr', t: now(), data: s }),
    });
    ownedServer = true;
  } else {
    // Tee the shared server's stderr into this run's wire log too so the
    // capture is self-contained. The shared server's stderr-sink can't be
    // mutated post-spawn; we just note that warm runs share the upstream
    // server log.
    wireWrite({ kind: 'note', t: now(), data: "warm: shared app-server (stderr not tee'd)" });
  }

  const client = await connectJsonRpc(server.wsUrl, {
    onWire: (dir, msg, t) => wireWrite({ kind: dir, t, msg }),
  });

  let parentThreadId = null;
  let parentTurnId = null;
  let spawnItemId = null;

  let t_turnStartSent = null;
  let t_turnStartReplied = null;
  let t_parent_spawn_item_started = null;
  let t_parent_spawn_item_completed = null;
  let t_subthread_thread_started = null;
  let subThreadId = null;
  let t_subthread_turn_started = null;
  let t_parent_turn_completed = null;

  // Every notification we observe with its threadId tag — for the capture.
  const eventLog = [];

  try {
    await client.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });

    let resolveParentThreadStarted;
    const parentThreadStarted = new Promise((res) => (resolveParentThreadStarted = res));

    client.onNotification(M.threadStarted, (p) => {
      const tNow = now();
      const id = p?.thread?.id ?? null;
      eventLog.push({ t: tNow, method: M.threadStarted, threadId: id });
      if (parentThreadId === null) {
        // First thread/started in the session is the parent — but we set
        // parentThreadId from the thread/start response below, so here we
        // only resolve the readiness latch.
        resolveParentThreadStarted();
        return;
      }
      if (id && id !== parentThreadId && t_subthread_thread_started === null) {
        t_subthread_thread_started = tNow;
        subThreadId = id;
      }
    });

    client.onNotification(M.turnStarted, (p) => {
      const tNow = now();
      const tid = p?.threadId ?? null;
      eventLog.push({ t: tNow, method: M.turnStarted, threadId: tid, turnId: p?.turn?.id ?? null });
      if (tid && tid === parentThreadId && parentTurnId === null) {
        parentTurnId = p?.turn?.id ?? null;
      }
      if (tid && tid !== parentThreadId && t_subthread_turn_started === null) {
        t_subthread_turn_started = tNow;
      }
    });

    client.onNotification(M.turnCompleted, (p) => {
      const tNow = now();
      const tid = p?.threadId ?? null;
      eventLog.push({ t: tNow, method: M.turnCompleted, threadId: tid });
      if (tid && tid === parentThreadId && t_parent_turn_completed === null) {
        t_parent_turn_completed = tNow;
      }
    });

    client.onNotification(M.itemStarted, (p) => {
      const tNow = now();
      const item = p?.item;
      if (item === null || typeof item !== 'object') return;
      const tid = p?.threadId ?? null;
      const isSpawn =
        String(item.type ?? '') === 'collabAgentToolCall' &&
        String(item.tool ?? '') === 'spawnAgent';
      eventLog.push({
        t: tNow,
        method: M.itemStarted,
        threadId: tid,
        itemType: item.type ?? null,
        itemId: item.id ?? null,
        ...(isSpawn ? { spawnItem: true } : {}),
      });
      if (isSpawn && tid === parentThreadId && t_parent_spawn_item_started === null) {
        t_parent_spawn_item_started = tNow;
        spawnItemId = item.id ?? null;
      }
    });

    client.onNotification(M.itemCompleted, (p) => {
      const tNow = now();
      const item = p?.item;
      if (item === null || typeof item !== 'object') return;
      const tid = p?.threadId ?? null;
      eventLog.push({
        t: tNow,
        method: M.itemCompleted,
        threadId: tid,
        itemType: item.type ?? null,
        itemId: item.id ?? null,
      });
      if (
        spawnItemId !== null &&
        item.id === spawnItemId &&
        tid === parentThreadId &&
        t_parent_spawn_item_completed === null
      ) {
        t_parent_spawn_item_completed = tNow;
      }
    });

    const startResp = await client.request(M.threadStart, { cwd });
    parentThreadId = startResp?.thread?.id ?? null;
    if (parentThreadId === null) {
      await Promise.race([parentThreadStarted, sleep(5_000)]);
    }
    if (parentThreadId === null) {
      throw new Error('no parent threadId from thread/start');
    }

    t_turnStartSent = now();
    const turnPromise = client.request(M.turnStart, {
      threadId: parentThreadId,
      input: [{ type: 'text', text: SPAWN_PROMPT }],
    });
    turnPromise.then(
      () => {
        t_turnStartReplied = now();
      },
      () => {
        t_turnStartReplied = now();
      },
    );

    // Observe for `observeMs` after turn/start was sent. We stop EARLY if we
    // already have both signals + parent item/completed (the cheap full-house).
    const deadline = t_turnStartSent + observeMs;
    while (now() < deadline) {
      if (
        t_parent_spawn_item_started !== null &&
        t_subthread_thread_started !== null &&
        t_parent_spawn_item_completed !== null
      ) {
        break;
      }
      await sleep(20);
    }
  } catch (e) {
    eventLog.push({ t: now(), kind: 'error', error: e?.message ?? String(e) });
  } finally {
    try {
      await safeClose(client);
    } catch {
      // Best-effort client cleanup.
    }
    if (ownedServer && server) {
      try {
        await server.close();
      } catch {
        // Best-effort server cleanup.
      }
    }
    try {
      closeFd(wireFd);
    } catch {
      // Best-effort log cleanup.
    }
  }

  return finalize({
    runIdx,
    condition,
    wireLogPath,
    parentThreadId,
    parentTurnId,
    spawnItemId,
    subThreadId,
    times: {
      t_turnStartSent,
      t_turnStartReplied,
      t_parent_spawn_item_started,
      t_parent_spawn_item_completed,
      t_subthread_thread_started,
      t_subthread_turn_started,
      t_parent_turn_completed,
    },
    eventLog,
    startEpochMs,
  });
}

function finalize({
  runIdx,
  condition,
  wireLogPath,
  parentThreadId,
  parentTurnId,
  spawnItemId,
  subThreadId,
  times,
  eventLog,
  startEpochMs,
}) {
  const parentObserved = times.t_parent_spawn_item_started !== null;
  const subObserved = times.t_subthread_thread_started !== null;

  let verdict;
  let deltaMs = null;
  if (!parentObserved && !subObserved) {
    verdict = 'inconclusive';
  } else if (parentObserved && !subObserved) {
    verdict = 'subthread_missing';
  } else if (!parentObserved && subObserved) {
    verdict = 'parent_missing';
  } else {
    deltaMs = times.t_subthread_thread_started - times.t_parent_spawn_item_started;
    if (deltaMs < -0.5) verdict = 'subthread_first';
    else if (deltaMs > 0.5) verdict = 'parent_first';
    else verdict = 'tie';
  }

  return {
    runIdx,
    condition,
    verdict,
    deltaMs, // t_subthread - t_parent. Negative = sub-thread first.
    parentThreadId,
    parentTurnId,
    subThreadId,
    spawnItemId,
    times,
    eventCount: eventLog.length,
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

// ---------- file helpers -----------------------------------------------------

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
  const runDir = join(capturesRoot, `m11-${startEpochMs}`);
  mkdirSync(runDir, { recursive: true });

  process.stderr.write(`[m11] captures → ${runDir}\n`);
  process.stderr.write(
    `[m11] cold_runs=${opts.coldRuns} warm_runs=${opts.warmRuns} observe_ms=${opts.observeMs}\n`,
  );

  const summaries = [];

  // ---- cold pass ----
  for (let i = 0; i < opts.coldRuns; i++) {
    const t0 = Date.now();
    process.stderr.write(`[m11] cold ${i + 1}/${opts.coldRuns} … `);
    const summary = await runOnce({
      runIdx: i,
      runDir,
      observeMs: opts.observeMs,
      condition: 'cold',
      sharedServer: null,
      startEpochMs,
    });
    summaries.push(summary);
    const dt = summary.deltaMs === null ? '?' : `${summary.deltaMs.toFixed(1)}ms`;
    process.stderr.write(`${summary.verdict} delta=${dt} (${Date.now() - t0}ms)\n`);
  }

  // ---- warm pass ----
  if (opts.warmRuns > 0) {
    process.stderr.write(`[m11] warming shared app-server …\n`);
    let sharedServer;
    try {
      sharedServer = await spawnAppServer({
        cliOverrides: [
          ['approval_policy', tomlStr('never')],
          ['sandbox_mode', tomlStr('danger-full-access')],
        ],
        stderrSink: (s) => {
          // Land in a per-server log; otherwise warm runs each tee their
          // own file (which would lose this pre-run window).
          warmServerStderr.push(s);
        },
      });
    } catch (e) {
      process.stderr.write(`[m11] failed to spawn warm shared app-server: ${e.message}\n`);
      process.exit(2);
    }

    for (let i = 0; i < opts.warmRuns; i++) {
      const t0 = Date.now();
      process.stderr.write(`[m11] warm ${i + 1}/${opts.warmRuns} … `);
      const summary = await runOnce({
        runIdx: opts.coldRuns + i,
        runDir,
        observeMs: opts.observeMs,
        condition: 'warm',
        sharedServer,
        startEpochMs,
      });
      summaries.push(summary);
      const dt = summary.deltaMs === null ? '?' : `${summary.deltaMs.toFixed(1)}ms`;
      process.stderr.write(`${summary.verdict} delta=${dt} (${Date.now() - t0}ms)\n`);
    }

    try {
      await sharedServer.close();
    } catch {
      // Best-effort server cleanup.
    }
    writeFileSync(join(runDir, 'warm-shared-server.stderr.log'), warmServerStderr.join(''));
  }

  // ---- aggregate ----
  const tally = (cond) => {
    const set = cond === 'all' ? summaries : summaries.filter((s) => s.condition === cond);
    const out = {
      runs: set.length,
      parent_first: 0,
      subthread_first: 0,
      tie: 0,
      subthread_missing: 0,
      parent_missing: 0,
      inconclusive: 0,
    };
    const deltas = [];
    for (const s of set) {
      out[s.verdict] = (out[s.verdict] ?? 0) + 1;
      if (typeof s.deltaMs === 'number') deltas.push(s.deltaMs);
    }
    if (deltas.length > 0) {
      deltas.sort((a, b) => a - b);
      out.delta_ms_min = deltas[0];
      out.delta_ms_p50 = deltas[Math.floor(deltas.length / 2)];
      out.delta_ms_p95 = deltas[Math.floor(deltas.length * 0.95)];
      out.delta_ms_max = deltas[deltas.length - 1];
      out.delta_ms_mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    }
    return out;
  };

  const aggregateAll = tally('all');
  const aggregateCold = tally('cold');
  const aggregateWarm = tally('warm');

  const summary = {
    spike: 'M11',
    startEpochMs,
    opts,
    aggregate: { all: aggregateAll, cold: aggregateCold, warm: aggregateWarm },
    perRun: summaries,
  };

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const productiveAll = aggregateAll.parent_first + aggregateAll.subthread_first + aggregateAll.tie;
  const productivePct = aggregateAll.runs === 0 ? 0 : (productiveAll / aggregateAll.runs) * 100;

  process.stderr.write(
    `[m11] aggregate all: ${JSON.stringify(aggregateAll)}\n` +
      `[m11] aggregate cold: ${JSON.stringify(aggregateCold)}\n` +
      `[m11] aggregate warm: ${JSON.stringify(aggregateWarm)}\n` +
      `[m11] productive=${productivePct.toFixed(1)}% (threshold 80% for pass)\n`,
  );

  // Exit 0 if measurement is informative (≥80% productive runs).
  process.exit(productivePct >= 80 ? 0 : 1);
}

// Buffer for warm-mode shared app-server stderr; flushed once at end.
const warmServerStderr = [];

main().catch((e) => {
  process.stderr.write(`[m11] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
