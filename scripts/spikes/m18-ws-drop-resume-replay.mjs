#!/usr/bin/env node
// scripts/spikes/m18-ws-drop-resume-replay.mjs
//
// Spike M18 — WS drop mid-ServerRequest → `thread/resume` → replay.
// docs/ideas/2026-05-11-headless-spikes.md §M18.
//
// ## Question
//
// When the daemon disconnects with a parked `item/tool/requestUserInput`
// ServerRequest (codex's built-in `request_user_input`), does
// `thread/resume` redeliver it via `replay_requests_to_connection_for_thread`?
// Can the daemon re-register the oneshot waiter and reply successfully?
//
// ## What the source says
//
//   - `app-server/src/outgoing_message.rs:217-220` — `connection_closed`
//     clears `request_contexts` but leaves `request_id_to_callback`
//     intact. So the parked oneshot stays alive after WS drop.
//   - `app-server/src/outgoing_message.rs:336-355` —
//     `replay_requests_to_connection_for_thread` resends every pending
//     server-request to the new connection using the ORIGINAL
//     `RequestId` (`OutgoingMessage::Request(request)`).
//   - `app-server/src/request_processors/thread_lifecycle.rs:658-660` —
//     replay runs as the last step of `thread/resume` (after notifications
//     for token_usage / goal updates).
//
// Static reading covers the path, but the live edges — replay-before-
// resume-response, replay-before-re-registration, and the model's turn
// state when the eventual reply arrives — are why this is a spike.
//
// ## Probe per run
//
//   1. Spawn fresh codex `app-server` with
//      `--enable default_mode_request_user_input` so codex's built-in
//      `request_user_input` tool is exposed.
//   2. Initialize, `thread/start({cwd: tempdir})`.
//   3. `turn/start` with a prompt instructing the model to call
//      `request_user_input` with one question, then use the answer.
//   4. Wait for an inbound ServerRequest with method
//      `item/tool/requestUserInput`. Capture its id, params, and arrival
//      timestamp. Record but DO NOT reply.
//   5. Force-close the WebSocket (no handshake reply to the parked
//      ServerRequest).
//   6. Wait a settle window (~500ms) so the server registers the
//      connection-close.
//   7. Connect a NEW WebSocket. `initialize`. Subscribe handlers for
//      every kind of inbound message (notifications + server-requests).
//   8. Call `thread/resume({threadId})`.
//   9. After resume returns, count inbound `item/tool/requestUserInput`
//      ServerRequests. Pass criterion: exactly one, matching the parked
//      one (same itemId, same questions[].id, same questions[].question).
//      Capture timing: t_resumeRequestSent, t_resumeResponse,
//      t_replayedRequest.
//  10. Reply to the redelivered ServerRequest with the same answer
//      shape codex expects (`{answers: {<qid>: {answers: ["..."]}}}`).
//  11. Wait for `turn/completed` on the parent thread. Pass: arrives
//      within `--turn-completion-timeout-ms`.
//
// ## CLI
//
//   node scripts/spikes/m18-ws-drop-resume-replay.mjs
//     [--runs N]                          (default 25)
//     [--request-timeout-ms MS]           (default 60000; max wait for
//                                          item/tool/requestUserInput
//                                          server-request on the first
//                                          connection)
//     [--settle-after-drop-ms MS]         (default 500)
//     [--replay-timeout-ms MS]            (default 5000; max wait for
//                                          the replayed ServerRequest
//                                          after thread/resume returns)
//     [--turn-completion-timeout-ms MS]   (default 30000)
//     [--captures-dir PATH]               (default scripts/spikes/captures)

import { mkdirSync, writeFileSync, mkdtempSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { spawnAppServer, connectJsonRpc, sleep, tomlStr, now } from './lib.mjs';

// ---------- arg parsing ------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    runs: 25,
    requestTimeoutMs: 60_000,
    settleAfterDropMs: 500,
    replayTimeoutMs: 5_000,
    turnCompletionTimeoutMs: 30_000,
    capturesDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--runs':
        opts.runs = Number(next());
        break;
      case '--request-timeout-ms':
        opts.requestTimeoutMs = Number(next());
        break;
      case '--settle-after-drop-ms':
        opts.settleAfterDropMs = Number(next());
        break;
      case '--replay-timeout-ms':
        opts.replayTimeoutMs = Number(next());
        break;
      case '--turn-completion-timeout-ms':
        opts.turnCompletionTimeoutMs = Number(next());
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
  for (const k of [
    'requestTimeoutMs',
    'settleAfterDropMs',
    'replayTimeoutMs',
    'turnCompletionTimeoutMs',
  ]) {
    if (!Number.isFinite(opts[k]) || opts[k] < 0)
      throw new Error(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be >= 0`);
  }
  return opts;
}

function printUsageAndExit(code) {
  process.stderr.write(`Usage: node scripts/spikes/m18-ws-drop-resume-replay.mjs [opts]

  --runs N                          (default 25)
  --request-timeout-ms MS           (default 60000)
  --settle-after-drop-ms MS         (default 500)
  --replay-timeout-ms MS            (default 5000)
  --turn-completion-timeout-ms MS   (default 30000)
  --captures-dir PATH               (default scripts/spikes/captures)
`);
  process.exit(code);
}

// ---------- prompt -----------------------------------------------------------

// One question, free-text. The prompt tells the model exactly what to ask
// so we can assert the redelivered ServerRequest matches by content.
const QUESTION_TEXT = 'What is your favourite color?';
const QUESTION_ID = 'color';
const ANSWER_TEXT = 'blue';

const SPAWN_PROMPT =
  `Use the request_user_input tool RIGHT NOW with these arguments:\n` +
  `  questions: [{ id: "${QUESTION_ID}", header: "", question: "${QUESTION_TEXT}", isOther: false, isSecret: false }]\n` +
  `When you receive the answer, reply with exactly one word: DONE.\n` +
  `Do not explain. Do not echo. Do not call any other tool first.`;

// codex method literals.
const M = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  toolRequestUserInput: 'item/tool/requestUserInput',
};

// ---------- one run ----------------------------------------------------------

async function runOnce({ runIdx, runDir, opts, startEpochMs }) {
  const wireLogPath = join(runDir, `run-${String(runIdx).padStart(3, '0')}.jsonl`);
  const wireFd = openAppend(wireLogPath);
  const wireWrite = (rec) => writeJsonl(wireFd, rec);

  const cwd = mkdtempSync(join(tmpdir(), `m18-cwd-`));

  const server = await spawnAppServer({
    cliOverrides: [
      ['approval_policy', tomlStr('never')],
      ['sandbox_mode', tomlStr('danger-full-access')],
    ],
    enabledFeatures: ['default_mode_request_user_input'],
    stderrSink: (s) => wireWrite({ kind: 'stderr', t: now(), data: s }),
  });

  // Outcome bag — finalize() reads this.
  const out = {
    runIdx,
    threadId: null,
    parkedRequest: null, // {id, method, params, t_arrived}
    replayedRequest: null, // {id, method, params, t_arrived}
    times: {
      t_turnStartSent: null,
      t_parkedArrived: null,
      t_dropped: null,
      t_reconnected: null,
      t_resumeSent: null,
      t_resumeResponse: null,
      t_replayArrived: null,
      t_replyToReplaySent: null,
      t_turnCompleted: null,
    },
    diagnostics: {
      requestUserInputArrivalsAfterResume: 0,
      requestUserInputArrivalsBeforeResume: 0,
      resumeError: null,
      replyToReplayError: null,
      turnCompletionTimeout: false,
      noRequestObserved: false,
      threadIdMismatch: false,
      paramsMismatch: false,
    },
    wireLogPath,
    startEpochMs,
  };

  let client1 = null;
  let client2 = null;

  try {
    // ---- phase 1: open WS, drive turn, wait for parked ServerRequest ----
    client1 = await connectJsonRpc(server.wsUrl, {
      onWire: (dir, msg, t) => wireWrite({ kind: dir, conn: 1, t, msg }),
    });

    // Latch resolved when the parked server-request arrives. We register the
    // handler BEFORE we issue turn/start to avoid a race.
    let resolveParked;
    const parkedReady = new Promise((res) => (resolveParked = res));
    client1.onServerRequest(M.toolRequestUserInput, async (params) => {
      // First arrival wins. We capture details and never reply. Keeping the
      // promise unresolved on the server side is the whole point.
      if (out.parkedRequest === null) {
        out.parkedRequest = {
          method: M.toolRequestUserInput,
          params,
          t_arrived: now(),
        };
        out.times.t_parkedArrived = out.parkedRequest.t_arrived;
        resolveParked();
      }
      // Sit forever. We're about to drop the WS, so this future never lands.
      return new Promise(() => {});
    });

    await client1.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    const startResp = await client1.request(M.threadStart, { cwd });
    out.threadId = startResp?.thread?.id ?? null;
    if (out.threadId === null) {
      throw new Error('no parent threadId from thread/start');
    }

    out.times.t_turnStartSent = now();
    // Fire-and-track: don't await — the turn won't complete until we reply
    // (or until we kill the WS, abort, and re-attach via thread/resume).
    const turnP = client1.request(M.turnStart, {
      threadId: out.threadId,
      input: [{ type: 'text', text: SPAWN_PROMPT }],
    });
    // Catch rejection to silence unhandled-promise warnings — the WS will
    // close shortly and this promise will reject; we don't care.
    turnP.catch(() => {});

    // Wait for parked ServerRequest, capped at request-timeout.
    await Promise.race([
      parkedReady,
      sleep(opts.requestTimeoutMs).then(() => {
        throw new Error('timeout: no item/tool/requestUserInput on conn1');
      }),
    ]);

    // ---- phase 2: force-close WS without replying ----
    // Drop in a fire-and-forget manner. The server's connection_closed
    // path retains the pending server-request callback (see file header).
    out.times.t_dropped = now();
    try {
      await client1.close();
    } catch {
      // Best-effort connection drop.
    }

    await sleep(opts.settleAfterDropMs);

    // ---- phase 3: new WS, initialize, thread/resume, observe replay ----
    client2 = await connectJsonRpc(server.wsUrl, {
      onWire: (dir, msg, t) => wireWrite({ kind: dir, conn: 2, t, msg }),
    });
    out.times.t_reconnected = now();

    let replayResolveFn = null;
    const replayReady = new Promise((res) => (replayResolveFn = res));

    client2.onServerRequest(M.toolRequestUserInput, async (params) => {
      // `connectJsonRpc`'s onServerRequest passes (params) — the helper
      // wraps reply via the return value. We need the id to reply, but the
      // helper doesn't surface it. Instead: bookkeeping by params is good
      // enough (single request in flight per run).
      const arrivedAt = now();
      // First arrival on conn2 after resume → the replay.
      if (out.times.t_resumeResponse !== null) {
        out.diagnostics.requestUserInputArrivalsAfterResume++;
        if (out.replayedRequest === null) {
          out.replayedRequest = { method: M.toolRequestUserInput, params, t_arrived: arrivedAt };
          out.times.t_replayArrived = arrivedAt;
          replayResolveFn();
        }
      } else {
        // Edge case: replay arrived BEFORE the resume request's own
        // response landed (replay-before-resume-response). Tag it so the
        // analyser can see if the race ever happens.
        out.diagnostics.requestUserInputArrivalsBeforeResume++;
        if (out.replayedRequest === null) {
          out.replayedRequest = { method: M.toolRequestUserInput, params, t_arrived: arrivedAt };
          out.times.t_replayArrived = arrivedAt;
          replayResolveFn();
        }
      }
      // Reply with the expected answer. The helper handles the JSON-RPC
      // response wiring; we return the body codex expects.
      return {
        answers: {
          [QUESTION_ID]: { answers: [ANSWER_TEXT] },
        },
      };
    });

    // Track turn/completed on conn2 to validate end-to-end.
    client2.onNotification(M.turnCompleted, (p) => {
      if (p?.threadId === out.threadId && out.times.t_turnCompleted === null) {
        out.times.t_turnCompleted = now();
      }
    });

    await client2.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });

    out.times.t_resumeSent = now();
    try {
      await client2.request(M.threadResume, { threadId: out.threadId });
      out.times.t_resumeResponse = now();
    } catch (e) {
      out.diagnostics.resumeError = e?.message ?? String(e);
    }

    if (out.diagnostics.resumeError === null) {
      // Wait for replayed ServerRequest (handler already replies on
      // arrival). If conn2's pre-resume handler already saw it, the
      // promise is already resolved.
      try {
        await Promise.race([
          replayReady,
          sleep(opts.replayTimeoutMs).then(() => {
            throw new Error('timeout: no redelivered request');
          }),
        ]);
        out.times.t_replyToReplaySent = now();
      } catch {
        out.diagnostics.noRequestObserved = true;
      }
    }

    // Validate params parity between parked + replayed.
    if (out.parkedRequest !== null && out.replayedRequest !== null) {
      const parkedThreadId = out.parkedRequest.params?.threadId;
      const replayedThreadId = out.replayedRequest.params?.threadId;
      if (parkedThreadId !== replayedThreadId) {
        out.diagnostics.threadIdMismatch = true;
      }
      const parkedQ = JSON.stringify(out.parkedRequest.params?.questions ?? null);
      const replayedQ = JSON.stringify(out.replayedRequest.params?.questions ?? null);
      if (parkedQ !== replayedQ) {
        out.diagnostics.paramsMismatch = true;
      }
    }

    // Wait for turn/completed.
    if (out.diagnostics.noRequestObserved === false && out.diagnostics.resumeError === null) {
      const deadline = now() + opts.turnCompletionTimeoutMs;
      while (out.times.t_turnCompleted === null && now() < deadline) {
        await sleep(50);
      }
      if (out.times.t_turnCompleted === null) {
        out.diagnostics.turnCompletionTimeout = true;
      }
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

  return finalize(out);
}

function finalize(out) {
  let verdict;
  if (out.diagnostics.fatal) {
    verdict = 'error';
  } else if (out.parkedRequest === null) {
    verdict = 'fail_no_parked_request';
  } else if (out.diagnostics.resumeError) {
    verdict = 'fail_resume_error';
  } else if (out.diagnostics.noRequestObserved) {
    verdict = 'fail_no_replay';
  } else if (
    out.diagnostics.requestUserInputArrivalsAfterResume +
      out.diagnostics.requestUserInputArrivalsBeforeResume >
    1
  ) {
    verdict = 'fail_duplicate_replay';
  } else if (out.diagnostics.threadIdMismatch || out.diagnostics.paramsMismatch) {
    verdict = 'fail_replay_shape_mismatch';
  } else if (out.diagnostics.turnCompletionTimeout) {
    verdict = 'fail_turn_did_not_complete';
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
  const runDir = join(capturesRoot, `m18-${startEpochMs}`);
  mkdirSync(runDir, { recursive: true });

  process.stderr.write(`[m18] captures → ${runDir}\n`);
  process.stderr.write(
    `[m18] runs=${opts.runs} request_timeout_ms=${opts.requestTimeoutMs}` +
      ` settle_after_drop_ms=${opts.settleAfterDropMs}` +
      ` replay_timeout_ms=${opts.replayTimeoutMs}` +
      ` turn_completion_timeout_ms=${opts.turnCompletionTimeoutMs}\n`,
  );

  const summaries = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = Date.now();
    process.stderr.write(`[m18] run ${i + 1}/${opts.runs} … `);
    const summary = await runOnce({ runIdx: i, runDir, opts, startEpochMs });
    summaries.push(summary);
    const dur =
      summary.times.t_turnCompleted !== null && summary.times.t_replayArrived !== null
        ? `replay→complete=${(summary.times.t_turnCompleted - summary.times.t_replayArrived).toFixed(0)}ms`
        : '';
    process.stderr.write(`${summary.verdict} ${dur} (${Date.now() - t0}ms)\n`);
  }

  const buckets = {};
  for (const s of summaries) buckets[s.verdict] = (buckets[s.verdict] ?? 0) + 1;

  const summary = {
    spike: 'M18',
    startEpochMs,
    opts,
    runs: summaries.length,
    verdictCounts: buckets,
    perRun: summaries,
  };

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`[m18] verdicts: ${JSON.stringify(buckets)}\n`);

  const totalOk = summaries.length > 0 && summaries.every((s) => s.verdict === 'pass');
  process.exit(totalOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[m18] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
