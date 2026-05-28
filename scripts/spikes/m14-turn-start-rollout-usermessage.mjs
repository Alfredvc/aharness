#!/usr/bin/env node
// scripts/spikes/m14-turn-start-rollout-usermessage.mjs
//
// Spike M14 — `turn/start.input` → rollout `ResponseItem::UserMessage`.
// docs/ideas/2026-05-11-headless-spikes.md §M14 ("Cheap insurance").
//
// ## Question
//
// When the daemon issues `turn/start({input: [{type:"text", text:"X"}]})`,
// does codex persist that text as a `ResponseItem::UserMessage` in the
// rollout JSONL at `~/.codex/sessions/...`? AND — separately — does it
// still do so when the `turn/start` is issued AFTER a `thread/resume`?
//
// The fresh-thread case is the load-bearing one (cross-state orientation
// rides `turn/start` per CLAUDE.md). The post-resume case is the M14
// rationale ("Confirms cross-state orientation survives resume").
//
// ## What this run does
//
//   1. Spawn fresh codex `app-server`; one WS client; `initialize`;
//      `thread/start({cwd: tempdir})`.
//   2. `turn/start({input:[{type:"text", text: SENTINEL_A}]})`. Wait for
//      `turn/completed`.
//   3. Drop WS. Settle. Reconnect. `initialize`. `thread/resume({threadId})`.
//   4. `turn/start({input:[{type:"text", text: SENTINEL_B}]})`. Wait for
//      `turn/completed`.
//   5. Locate the rollout JSONL by threadId under `~/.codex/sessions/`.
//      Scan every `response_item / message / role=user` payload and look
//      for both sentinels in `content[].text`.
//
// ## Pass criterion
//
//   (a) SENTINEL_A appears in a rollout user-message item.
//   (b) SENTINEL_B appears in a rollout user-message item.
//   (c) Both turns reach `turn/completed`.
//
// ## CLI
//
//   node scripts/spikes/m14-turn-start-rollout-usermessage.mjs
//     [--runs N]                          (default 1)
//     [--turn-completion-timeout-ms MS]   (default 30000)
//     [--settle-after-drop-ms MS]         (default 500)
//     [--captures-dir PATH]               (default scripts/spikes/captures)

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { spawnAppServer, connectJsonRpc, sleep, tomlStr, now } from './lib.mjs';

// ---------- arg parsing ------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    runs: 1,
    turnCompletionTimeoutMs: 30_000,
    settleAfterDropMs: 500,
    capturesDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--runs':
        opts.runs = Number(next());
        break;
      case '--turn-completion-timeout-ms':
        opts.turnCompletionTimeoutMs = Number(next());
        break;
      case '--settle-after-drop-ms':
        opts.settleAfterDropMs = Number(next());
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
  if (!Number.isFinite(opts.runs) || opts.runs <= 0) throw new Error('--runs must be > 0');
  for (const k of ['turnCompletionTimeoutMs', 'settleAfterDropMs']) {
    if (!Number.isFinite(opts[k]) || opts[k] < 0)
      throw new Error(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be >= 0`);
  }
  return opts;
}

function printUsageAndExit(code) {
  process.stderr.write(`Usage: node scripts/spikes/m14-turn-start-rollout-usermessage.mjs [opts]

  --runs N                          (default 1)
  --turn-completion-timeout-ms MS   (default 30000)
  --settle-after-drop-ms MS         (default 500)
  --captures-dir PATH               (default scripts/spikes/captures)
`);
  process.exit(code);
}

// ---------- sentinels --------------------------------------------------------

// Random per-run so we can't accidentally match a stale rollout.
function randomSentinel(label) {
  const r = Math.random().toString(36).slice(2, 10);
  return `M14_${label}_${r}`;
}

const M = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnCompleted: 'turn/completed',
};

// ---------- one run ----------------------------------------------------------

async function runOnce({ runIdx, runDir, opts, startEpochMs }) {
  const wireLogPath = join(runDir, `run-${String(runIdx).padStart(3, '0')}.jsonl`);
  const wireFd = openAppend(wireLogPath);
  const wireWrite = (rec) => writeJsonl(wireFd, rec);

  const cwd = mkdtempSync(join(tmpdir(), `m14-cwd-`));

  const SENTINEL_A = randomSentinel('A');
  const SENTINEL_B = randomSentinel('B');
  const PROMPT_A = `${SENTINEL_A} Respond with the single word OK.`;
  const PROMPT_B = `${SENTINEL_B} Respond with the single word DONE.`;

  const server = await spawnAppServer({
    cliOverrides: [
      ['approval_policy', tomlStr('never')],
      ['sandbox_mode', tomlStr('danger-full-access')],
    ],
    stderrSink: (s) => wireWrite({ kind: 'stderr', t: now(), data: s }),
  });

  const out = {
    runIdx,
    threadId: null,
    sentinels: { A: SENTINEL_A, B: SENTINEL_B },
    times: {
      t_turn1Sent: null,
      t_turn1Completed: null,
      t_dropped: null,
      t_reconnected: null,
      t_resumeResponse: null,
      t_turn2Sent: null,
      t_turn2Completed: null,
    },
    rollout: { path: null, found: { A: false, B: false } },
    diagnostics: {
      turn1Timeout: false,
      turn2Timeout: false,
      resumeError: null,
      rolloutNotFound: false,
      fatal: null,
    },
    wireLogPath,
    startEpochMs,
  };

  let client1 = null;
  let client2 = null;

  try {
    // ---- phase 1: fresh thread, first turn ----
    client1 = await connectJsonRpc(server.wsUrl, {
      onWire: (dir, msg, t) => wireWrite({ kind: dir, conn: 1, t, msg }),
    });

    let turn1Completed = null;
    const turn1Done = new Promise((res) => (turn1Completed = res));
    client1.onNotification(M.turnCompleted, (p) => {
      if (p?.threadId === out.threadId && out.times.t_turn1Completed === null) {
        out.times.t_turn1Completed = now();
        turn1Completed();
      }
    });

    await client1.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    const startResp = await client1.request(M.threadStart, { cwd });
    out.threadId = startResp?.thread?.id ?? null;
    if (out.threadId === null) throw new Error('no parent threadId from thread/start');

    out.times.t_turn1Sent = now();
    const turn1P = client1.request(M.turnStart, {
      threadId: out.threadId,
      input: [{ type: 'text', text: PROMPT_A }],
    });
    turn1P.catch(() => {});

    await Promise.race([
      turn1Done,
      sleep(opts.turnCompletionTimeoutMs).then(() => {
        throw new Error('timeout: turn1 did not complete');
      }),
    ]).catch(() => {
      out.diagnostics.turn1Timeout = true;
    });

    // ---- phase 2: drop, reconnect, resume ----
    out.times.t_dropped = now();
    try {
      await client1.close();
    } catch {
      // Best-effort connection drop.
    }
    await sleep(opts.settleAfterDropMs);

    client2 = await connectJsonRpc(server.wsUrl, {
      onWire: (dir, msg, t) => wireWrite({ kind: dir, conn: 2, t, msg }),
    });
    out.times.t_reconnected = now();

    let turn2Completed = null;
    const turn2Done = new Promise((res) => (turn2Completed = res));
    client2.onNotification(M.turnCompleted, (p) => {
      if (p?.threadId === out.threadId && out.times.t_turn2Completed === null) {
        out.times.t_turn2Completed = now();
        turn2Completed();
      }
    });

    await client2.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });

    try {
      await client2.request(M.threadResume, { threadId: out.threadId });
      out.times.t_resumeResponse = now();
    } catch (e) {
      out.diagnostics.resumeError = e?.message ?? String(e);
    }

    if (out.diagnostics.resumeError === null) {
      out.times.t_turn2Sent = now();
      const turn2P = client2.request(M.turnStart, {
        threadId: out.threadId,
        input: [{ type: 'text', text: PROMPT_B }],
      });
      turn2P.catch(() => {});

      await Promise.race([
        turn2Done,
        sleep(opts.turnCompletionTimeoutMs).then(() => {
          throw new Error('timeout: turn2 did not complete');
        }),
      ]).catch(() => {
        out.diagnostics.turn2Timeout = true;
      });
    }
  } catch (e) {
    wireWrite({ kind: 'fatal', t: now(), error: e?.stack ?? e?.message ?? String(e) });
    out.diagnostics.fatal = e?.message ?? String(e);
  } finally {
    try {
      if (client1 && !client1.isClosed()) await client1.close();
    } catch {
      // Best-effort client cleanup.
    }
    try {
      if (client2 && !client2.isClosed()) await client2.close();
    } catch {
      // Best-effort client cleanup.
    }
    try {
      await server.close();
    } catch {
      // Best-effort server cleanup.
    }
    try {
      closeFd(wireFd);
    } catch {
      // Best-effort log cleanup.
    }
  }

  // ---- phase 3: inspect rollout ----
  if (out.threadId !== null) {
    const rolloutPath = findRolloutForThread(out.threadId);
    out.rollout.path = rolloutPath;
    if (rolloutPath === null) {
      out.diagnostics.rolloutNotFound = true;
    } else {
      const texts = collectUserMessageTexts(rolloutPath);
      out.rollout.found.A = texts.some((t) => t.includes(SENTINEL_A));
      out.rollout.found.B = texts.some((t) => t.includes(SENTINEL_B));
      out.rollout.userMessageCount = texts.length;
    }
  }

  return finalize(out);
}

function findRolloutForThread(threadId) {
  const root = join(homedir(), '.codex', 'sessions');
  let safety;
  try {
    safety = statSync(root);
  } catch {
    return null;
  }
  if (!safety.isDirectory()) return null;

  // Walk recursively. `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-...-<threadId>.jsonl`.
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith(`-${threadId}.jsonl`)) {
        return p;
      }
    }
  }
  return null;
}

function collectUserMessageTexts(rolloutPath) {
  const lines = readFileSync(rolloutPath, 'utf8').trim().split('\n');
  const texts = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'response_item') continue;
    const payload = rec.payload;
    if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;
    if (!Array.isArray(payload.content)) continue;
    for (const c of payload.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string') {
        texts.push(c.text);
      }
    }
  }
  return texts;
}

function finalize(out) {
  let verdict;
  if (out.diagnostics.fatal) {
    verdict = 'error';
  } else if (out.diagnostics.turn1Timeout) {
    verdict = 'fail_turn1_timeout';
  } else if (out.diagnostics.resumeError) {
    verdict = 'fail_resume_error';
  } else if (out.diagnostics.turn2Timeout) {
    verdict = 'fail_turn2_timeout';
  } else if (out.diagnostics.rolloutNotFound) {
    verdict = 'fail_rollout_not_found';
  } else if (!out.rollout.found.A) {
    verdict = 'fail_sentinel_A_missing';
  } else if (!out.rollout.found.B) {
    verdict = 'fail_sentinel_B_missing_post_resume';
  } else {
    verdict = 'pass';
  }
  return { ...out, verdict };
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
  const runDir = join(capturesRoot, `m14-${startEpochMs}`);
  mkdirSync(runDir, { recursive: true });

  process.stderr.write(`[m14] captures → ${runDir}\n`);
  process.stderr.write(
    `[m14] runs=${opts.runs} turn_completion_timeout_ms=${opts.turnCompletionTimeoutMs}` +
      ` settle_after_drop_ms=${opts.settleAfterDropMs}\n`,
  );

  const summaries = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = Date.now();
    process.stderr.write(`[m14] run ${i + 1}/${opts.runs} … `);
    const summary = await runOnce({ runIdx: i, runDir, opts, startEpochMs });
    summaries.push(summary);
    process.stderr.write(`${summary.verdict} (${Date.now() - t0}ms)\n`);
  }

  const buckets = {};
  for (const s of summaries) buckets[s.verdict] = (buckets[s.verdict] ?? 0) + 1;

  const summary = {
    spike: 'M14',
    startEpochMs,
    opts,
    runs: summaries.length,
    verdictCounts: buckets,
    perRun: summaries,
  };

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`[m14] verdicts: ${JSON.stringify(buckets)}\n`);

  const totalOk = summaries.length > 0 && summaries.every((s) => s.verdict === 'pass');
  process.exit(totalOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[m14] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
