#!/usr/bin/env node
// scripts/spikes/m2-request-user-input-two-question.mjs
//
// Spike M2 — `request_user_input` two-question reply round-trip.
// docs/ideas/2026-05-11-headless-spikes.md §M2 ("Cheap insurance").
//
// ## Question
//
// Schema for replying to `item/tool/requestUserInput` is
// `{answers: {<qid>: {answers: [<text>, ...]}}}` per
// `codex-rs/app-server-protocol/src/protocol/v2/item.rs:1441-1447`.
// Single-question variant validated incidentally by M18 (25/25). The
// two-question variant — same outer shape, two keys in the inner map —
// is the remaining unrun probe before the headless spec commit.
//
// ## What this run does
//
// Per run:
//
//   1. Spawn fresh codex `app-server` with
//      `--enable default_mode_request_user_input` so codex exposes the
//      built-in `request_user_input` tool.
//   2. `initialize` → `thread/start({cwd: tempdir})`.
//   3. `turn/start` with a prompt instructing the model to call
//      `request_user_input` with TWO questions in a single call (`color`
//      and `animal`), then reply with exactly
//      `color=<color> animal=<animal>`.
//   4. Reply to the inbound `item/tool/requestUserInput` ServerRequest
//      with `{answers: {color: {answers: ["blue"]}, animal: {answers: ["wolf"]}}}`.
//   5. Wait for `turn/completed`. Accumulate every `agentMessage`
//      `item/completed`'s text.
//
// ## Pass criterion
//
//   (a) Exactly one inbound `item/tool/requestUserInput` ServerRequest;
//       its `params.questions` carries both `color` and `animal` ids.
//   (b) Codex accepts the reply (no error, no second request).
//   (c) `turn/completed` fires within `--turn-completion-timeout-ms`.
//   (d) Accumulated agentMessage text contains both answer values
//       (`blue` and `wolf`) — proves the model received both answers.
//
// ## CLI
//
//   node scripts/spikes/m2-request-user-input-two-question.mjs
//     [--runs N]                          (default 3)
//     [--request-timeout-ms MS]           (default 60000)
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
    runs: 3,
    requestTimeoutMs: 60_000,
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
  for (const k of ['requestTimeoutMs', 'turnCompletionTimeoutMs']) {
    if (!Number.isFinite(opts[k]) || opts[k] < 0)
      throw new Error(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be >= 0`);
  }
  return opts;
}

function printUsageAndExit(code) {
  process.stderr.write(`Usage: node scripts/spikes/m2-request-user-input-two-question.mjs [opts]

  --runs N                          (default 3)
  --request-timeout-ms MS           (default 60000)
  --turn-completion-timeout-ms MS   (default 30000)
  --captures-dir PATH               (default scripts/spikes/captures)
`);
  process.exit(code);
}

// ---------- prompt -----------------------------------------------------------

const Q1_ID = 'color';
const Q1_TEXT = 'What is your favourite color?';
const Q1_ANSWER = 'blue';

const Q2_ID = 'animal';
const Q2_TEXT = 'What is your favourite animal?';
const Q2_ANSWER = 'wolf';

const SPAWN_PROMPT =
  `Use the request_user_input tool RIGHT NOW with these arguments:\n` +
  `  questions: [\n` +
  `    { id: "${Q1_ID}", header: "", question: "${Q1_TEXT}", isOther: false, isSecret: false },\n` +
  `    { id: "${Q2_ID}", header: "", question: "${Q2_TEXT}", isOther: false, isSecret: false }\n` +
  `  ]\n` +
  `When you receive the answers, reply with EXACTLY:\n` +
  `  ${Q1_ID}=<value of ${Q1_ID}> ${Q2_ID}=<value of ${Q2_ID}>\n` +
  `Do not explain. Do not echo the question. Do not call any other tool first.`;

// codex method literals.
const M = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnCompleted: 'turn/completed',
  itemCompleted: 'item/completed',
  toolRequestUserInput: 'item/tool/requestUserInput',
};

// ---------- one run ----------------------------------------------------------

async function runOnce({ runIdx, runDir, opts, startEpochMs }) {
  const wireLogPath = join(runDir, `run-${String(runIdx).padStart(3, '0')}.jsonl`);
  const wireFd = openAppend(wireLogPath);
  const wireWrite = (rec) => writeJsonl(wireFd, rec);

  const cwd = mkdtempSync(join(tmpdir(), `m2-cwd-`));

  const server = await spawnAppServer({
    cliOverrides: [
      ['approval_policy', tomlStr('never')],
      ['sandbox_mode', tomlStr('danger-full-access')],
    ],
    enabledFeatures: ['default_mode_request_user_input'],
    stderrSink: (s) => wireWrite({ kind: 'stderr', t: now(), data: s }),
  });

  const out = {
    runIdx,
    threadId: null,
    request: null, // {method, params, t_arrived}
    duplicateRequestCount: 0,
    agentMessageText: '',
    times: {
      t_turnStartSent: null,
      t_requestArrived: null,
      t_replySent: null,
      t_turnCompleted: null,
    },
    diagnostics: {
      noRequestObserved: false,
      questionsMismatch: false,
      turnCompletionTimeout: false,
      fatal: null,
    },
    wireLogPath,
    startEpochMs,
  };

  let client = null;

  try {
    client = await connectJsonRpc(server.wsUrl, {
      onWire: (dir, msg, t) => wireWrite({ kind: dir, t, msg }),
    });

    let resolveRequest;
    const requestArrived = new Promise((res) => (resolveRequest = res));
    client.onServerRequest(M.toolRequestUserInput, async (params) => {
      const t = now();
      if (out.request === null) {
        out.request = { method: M.toolRequestUserInput, params, t_arrived: t };
        out.times.t_requestArrived = t;
        resolveRequest();
      } else {
        out.duplicateRequestCount++;
      }
      out.times.t_replySent = now();
      return {
        answers: {
          [Q1_ID]: { answers: [Q1_ANSWER] },
          [Q2_ID]: { answers: [Q2_ANSWER] },
        },
      };
    });

    client.onNotification(M.itemCompleted, (p) => {
      const item = p?.item;
      if (!item) return;
      if (String(item.type ?? '') === 'agentMessage') {
        const text = extractAgentMessageText(item);
        if (typeof text === 'string') {
          if (out.agentMessageText.length > 0) out.agentMessageText += '\n';
          out.agentMessageText += text;
        }
      }
    });

    client.onNotification(M.turnCompleted, (p) => {
      if (p?.threadId === out.threadId && out.times.t_turnCompleted === null) {
        out.times.t_turnCompleted = now();
      }
    });

    await client.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    const startResp = await client.request(M.threadStart, { cwd });
    out.threadId = startResp?.thread?.id ?? null;
    if (out.threadId === null) {
      throw new Error('no parent threadId from thread/start');
    }

    out.times.t_turnStartSent = now();
    const turnP = client.request(M.turnStart, {
      threadId: out.threadId,
      input: [{ type: 'text', text: SPAWN_PROMPT }],
    });
    turnP.catch(() => {});

    await Promise.race([
      requestArrived,
      sleep(opts.requestTimeoutMs).then(() => {
        throw new Error('timeout: no item/tool/requestUserInput');
      }),
    ]).catch((e) => {
      out.diagnostics.noRequestObserved = true;
      out.diagnostics.fatal = e?.message ?? String(e);
    });

    if (out.request !== null) {
      const questions = out.request.params?.questions;
      if (!Array.isArray(questions) || questions.length !== 2) {
        out.diagnostics.questionsMismatch = true;
      } else {
        const ids = questions.map((q) => q?.id).sort();
        const expect = [Q1_ID, Q2_ID].sort();
        if (ids[0] !== expect[0] || ids[1] !== expect[1]) {
          out.diagnostics.questionsMismatch = true;
        }
      }
    }

    if (out.request !== null) {
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
      if (client && !client.isClosed()) await client.close();
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
  const hasBothAnswers =
    out.agentMessageText.toLowerCase().includes(Q1_ANSWER.toLowerCase()) &&
    out.agentMessageText.toLowerCase().includes(Q2_ANSWER.toLowerCase());

  let verdict;
  if (out.diagnostics.noRequestObserved) {
    verdict = 'fail_no_request';
  } else if (out.duplicateRequestCount > 0) {
    verdict = 'fail_duplicate_request';
  } else if (out.diagnostics.questionsMismatch) {
    verdict = 'fail_questions_mismatch';
  } else if (out.diagnostics.turnCompletionTimeout) {
    verdict = 'fail_turn_did_not_complete';
  } else if (!hasBothAnswers) {
    verdict = 'fail_answers_not_echoed';
  } else if (out.diagnostics.fatal) {
    verdict = 'error';
  } else {
    verdict = 'pass';
  }

  return { ...out, verdict, hasBothAnswers };
}

function extractAgentMessageText(item) {
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) {
    const parts = [];
    for (const c of item.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string') parts.push(c.text);
    }
    if (parts.length) return parts.join('');
  }
  if (item.message && Array.isArray(item.message.content)) {
    const parts = [];
    for (const c of item.message.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string') parts.push(c.text);
    }
    if (parts.length) return parts.join('');
  }
  return null;
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
  const runDir = join(capturesRoot, `m2-${startEpochMs}`);
  mkdirSync(runDir, { recursive: true });

  process.stderr.write(`[m2] captures → ${runDir}\n`);
  process.stderr.write(
    `[m2] runs=${opts.runs} request_timeout_ms=${opts.requestTimeoutMs}` +
      ` turn_completion_timeout_ms=${opts.turnCompletionTimeoutMs}\n`,
  );

  const summaries = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = Date.now();
    process.stderr.write(`[m2] run ${i + 1}/${opts.runs} … `);
    const summary = await runOnce({ runIdx: i, runDir, opts, startEpochMs });
    summaries.push(summary);
    const replyToComplete =
      summary.times.t_turnCompleted !== null && summary.times.t_replySent !== null
        ? `reply→complete=${(summary.times.t_turnCompleted - summary.times.t_replySent).toFixed(0)}ms`
        : '';
    process.stderr.write(`${summary.verdict} ${replyToComplete} (${Date.now() - t0}ms)\n`);
  }

  const buckets = {};
  for (const s of summaries) buckets[s.verdict] = (buckets[s.verdict] ?? 0) + 1;

  const summary = {
    spike: 'M2',
    startEpochMs,
    opts,
    runs: summaries.length,
    verdictCounts: buckets,
    perRun: summaries,
  };

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`[m2] verdicts: ${JSON.stringify(buckets)}\n`);

  const totalOk = summaries.length > 0 && summaries.every((s) => s.verdict === 'pass');
  process.exit(totalOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[m2] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
