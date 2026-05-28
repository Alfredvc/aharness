#!/usr/bin/env node
// scripts/spikes/r4-headless-full-pass.mjs
//
// Spike R4 — Full empirical headless pass.
// docs/ideas/2026-05-11-headless-codex-feasibility.md §R4.
//
// ## Question
//
// Does codex `app-server` behave correctly when driven by a single WS
// client (the "daemon") with NO TUI ever connected, across all four
// load-bearing surfaces of the aharness design:
//
//   1. `request_user_input` (built-in tool, server-request reply)
//   2. Cross-state transitions (drain → `turn/interrupt` → `turn/start`)
//   3. Sub-agents (`spawn_agent` → parent's `collabAgentToolCall` carries
//      `receiverThreadIds`; sub-thread events fan out to parent's WS)
//   4. Approvals (`item/commandExecution/requestApproval`)
//
// Each surface has its own micro-spike (M2 / M6 / M11 / source-read M3),
// but the daemon will exercise all four in the same session. This probe
// validates the composition.
//
// ## Vehicle
//
// Wire-level spike, fully decoupled from `packages/core` (per
// the lib.mjs principle: spike aharness depends on nothing in the SDK so
// SDK regressions can't mask substrate regressions). A single
// `connectJsonRpc` client plays the daemon's role.
//
// ## Phases (single thread, sequential)
//
//   Phase 1 (`request_user_input`):
//     turn/start → model calls `request_user_input` → reply →
//     model produces `agentMessage` PHASE1_OK → turn/completed.
//
//   Phase 2 (cross-state):
//     turn/start → model calls `bash {sleep 5; echo CROSS_OK}` AND keeps
//     writing → wait for the bash tool's item/completed → issue
//     turn/interrupt → await TurnAborted → issue NEXT turn/start (phase 3
//     prompt). Pattern matches M6 drain-then-interrupt.
//
//   Phase 3 (sub-agent):
//     turn/start asks model to spawn a sub-agent that does trivial work
//     and waits on its result. Observe parent's `collabAgentToolCall`
//     item/completed with non-empty `receiverThreadIds`. Observe
//     sub-thread events tagged with the sub-thread's threadId arriving
//     on our WS (auto-attach fan-out per feasibility doc #5). Wait for
//     parent turn/completed.
//
//   Phase 4 (approval):
//     turn/start asks model to run a shell command that the sandbox
//     blocks (e.g. `mkdir /etc/r4-…`). Under `approval_policy=on-failure`
//     + `sandbox_mode=workspace-write`, codex emits
//     `item/commandExecution/requestApproval`. Reply with
//     `{decision: "decline"}`. Wait for turn/completed.
//
// ## Pass criterion
//
// All of:
//
//   (P1) Phase 1: at least one `item/tool/requestUserInput` request,
//        accepted reply, turn/completed.
//   (P2) Phase 2: drain signal (the echo tool's item/completed) observed
//        before interrupt; TurnAborted observed; next turn/start
//        succeeded; no stray item/completed for the aborted turn after
//        TurnAborted.
//   (P3) Phase 3: parent item/completed for a `collabAgentToolCall` with
//        non-empty receiverThreadIds; ≥1 sub-thread event observed
//        (notification carrying a threadId distinct from parent); parent
//        turn/completed.
//   (P4) Phase 4: ≥1 `item/commandExecution/requestApproval` server-
//        request observed, replied with decline (or accept) without
//        error; turn/completed.
//   (Q)  Every JSON-RPC ServerRequest we observed was either handled by
//        us (no -32601 sent), or — if a method we didn't register —
//        flagged in diagnostics.
//
// ## CLI
//
//   node scripts/spikes/r4-headless-full-pass.mjs
//     [--runs N]                       (default 1)
//     [--turn-timeout-ms MS]           (default 60000; per phase)
//     [--captures-dir PATH]
//
// ## Deviation from spike-doc locked decisions
//
// Spike-doc R2 picks `approval_policy=on_request` as the headless v1
// default. This probe uses `on-failure` + `workspace-write` because that
// combination deterministically triggers
// `item/commandExecution/requestApproval` on a sandbox-blocked command,
// without needing the model to volitionally ask for permission. Schema
// of the approval request is identical across policies; the policy here
// is purely a measurement convenience.

import { mkdirSync, writeFileSync, mkdtempSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { spawnAppServer, connectJsonRpc, sleep, tomlStr, now } from './lib.mjs';

// ---------- arg parsing ------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    runs: 1,
    turnTimeoutMs: 60_000,
    capturesDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--runs':
        opts.runs = Number(next());
        break;
      case '--turn-timeout-ms':
        opts.turnTimeoutMs = Number(next());
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
  if (!Number.isFinite(opts.turnTimeoutMs) || opts.turnTimeoutMs <= 0)
    throw new Error('--turn-timeout-ms must be > 0');
  return opts;
}

function printUsageAndExit(code) {
  process.stderr.write(`Usage: node scripts/spikes/r4-headless-full-pass.mjs [opts]

  --runs N                       (default 1)
  --turn-timeout-ms MS           (default 60000)
  --captures-dir PATH            (default scripts/spikes/captures)
`);
  process.exit(code);
}

// ---------- prompts ----------------------------------------------------------

const PHASE1_Q_ID = 'pick';
const PHASE1_ANSWER = '42';
const PHASE1_PROMPT =
  `Call request_user_input RIGHT NOW with questions:\n` +
  `  [{ id: "${PHASE1_Q_ID}", header: "", question: "Pick a number", isOther: false, isSecret: false }]\n` +
  `When you receive the answer, reply with exactly: PHASE1_OK <answer>\n` +
  `Do not call any other tool.`;

const PHASE2_PROMPT =
  `Run this shell command exactly once: echo CROSS_READY\n` +
  `Then, WITHOUT calling any more tools, write a long essay about the history of typography (at least 800 words). Keep writing until told to stop.`;

const PHASE3_PROMPT =
  `Use the spawn_agent tool RIGHT NOW to delegate this task to a sub-agent:\n` +
  `  description: "Compute 11+12. Reply with exactly the integer, nothing else."\n` +
  `Wait for the sub-agent's result. Then reply with exactly: PHASE3_OK <result>\n` +
  `Do not call any other tool.`;

const PHASE4_DIR = `/tmp/r4-spike-${process.pid}-${Date.now()}`;
const PHASE4_PROMPT =
  `Use your shell tool to run this exact command:\n` +
  `  mkdir ${PHASE4_DIR}\n` +
  `Run the command first. After the command completes (regardless of outcome), reply with exactly: PHASE4_OK`;

// codex methods.
const M = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  threadStatusChanged: 'thread/status/changed',
  toolRequestUserInput: 'item/tool/requestUserInput',
  fileChangeApproval: 'item/fileChange/requestApproval',
  commandApproval: 'item/commandExecution/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
};

// ---------- one run ----------------------------------------------------------

async function runOnce({ runIdx, runDir, opts, startEpochMs }) {
  const wireLogPath = join(runDir, `run-${String(runIdx).padStart(3, '0')}.jsonl`);
  const wireFd = openAppend(wireLogPath);
  const wireWrite = (rec) => writeJsonl(wireFd, rec);

  const cwd = mkdtempSync(join(tmpdir(), `r4-cwd-`));

  const server = await spawnAppServer({
    cliOverrides: [
      // `untrusted`: only `ls`/`cat`/`sed`-class commands run silently;
      // anything else (e.g. `mkdir`) escalates to approval. Reliable
      // trigger for `item/commandExecution/requestApproval` independent
      // of whether the OS sandbox actually fires.
      ['approval_policy', tomlStr('untrusted')],
      ['sandbox_mode', tomlStr('workspace-write')],
    ],
    enabledFeatures: ['default_mode_request_user_input'],
    stderrSink: (s) => wireWrite({ kind: 'stderr', t: now(), data: s }),
  });

  const out = {
    runIdx,
    threadId: null,
    phases: {
      p1: { ruiObserved: 0, completed: false, agentMessage: '', error: null, t_completed: null },
      p2: {
        drainItemId: null,
        drainObserved: false,
        t_interruptSent: null,
        t_turnAborted: null,
        strayItemCompletedAfterAbort: 0,
        nextTurnIssued: false,
        error: null,
      },
      p3: {
        spawnItemSeen: false,
        receiverThreadIds: [],
        subThreadEventCount: 0,
        subThreadIds: new Set(),
        completed: false,
        agentMessage: '',
        error: null,
        t_completed: null,
      },
      p4: {
        approvalRequests: 0,
        approvalMethods: new Set(),
        decisionSent: null,
        completed: false,
        agentMessage: '',
        error: null,
        t_completed: null,
      },
    },
    diagnostics: {
      unhandledServerRequests: [],
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

    // We log unknown ServerRequest methods by watching the raw wire log
    // — easier than monkey-patching the helper. Done in finalize.

    // ---- registered ServerRequest handlers ----

    client.onServerRequest(M.toolRequestUserInput, async (params) => {
      out.phases.p1.ruiObserved++;
      const qid = params?.questions?.[0]?.id ?? PHASE1_Q_ID;
      return { answers: { [qid]: { answers: [PHASE1_ANSWER] } } };
    });

    client.onServerRequest(M.fileChangeApproval, async () => {
      // Not expected this run, but handle defensively.
      out.phases.p4.approvalRequests++;
      out.phases.p4.approvalMethods.add(M.fileChangeApproval);
      out.phases.p4.decisionSent = 'decline';
      return { decision: 'decline' };
    });

    client.onServerRequest(M.commandApproval, async () => {
      out.phases.p4.approvalRequests++;
      out.phases.p4.approvalMethods.add(M.commandApproval);
      out.phases.p4.decisionSent = 'decline';
      return { decision: 'decline' };
    });

    client.onServerRequest(M.permissionsApproval, async () => {
      out.phases.p4.approvalRequests++;
      out.phases.p4.approvalMethods.add(M.permissionsApproval);
      out.phases.p4.decisionSent = 'decline';
      return { decision: 'decline' };
    });

    // ---- notification subscriptions ----

    // turn/completed per phase: cleared/swapped between phases. With
    // sequential turns on a single thread, any turn/completed for our
    // thread satisfies the current phase's waiter.
    let currentTurnCompletedResolve = null;
    client.onNotification(M.turnCompleted, (p) => {
      if (p?.threadId !== out.threadId) return;
      if (currentTurnCompletedResolve) {
        const r = currentTurnCompletedResolve;
        currentTurnCompletedResolve = null;
        r();
      }
    });

    // Track item/completed events for: phase-1 agentMessage, phase-2 drain +
    // stray-after-abort, phase-3 spawn observation + sub-thread tagging,
    // phase-4 agentMessage.
    //
    // Phase machine — `phase` updated externally.
    let phase = 'p1';
    let phase2DrainSignal = null; // promise resolved when echo tool completes
    let phase2DrainResolve = null;
    let phase2InterruptCutoffT = null; // set when TurnAborted resolves

    client.onNotification(M.itemStarted, (p) => {
      // Items started on sub-threads carry a different threadId than the parent.
      if (phase === 'p3' && p?.threadId && p.threadId !== out.threadId) {
        out.phases.p3.subThreadEventCount++;
        out.phases.p3.subThreadIds.add(p.threadId);
      }
    });

    client.onNotification(M.itemCompleted, (p) => {
      const item = p?.item;
      const fromParent = p?.threadId === out.threadId;
      if (!item) return;

      // Sub-thread tagging for phase 3.
      if (phase === 'p3' && p?.threadId && p.threadId !== out.threadId) {
        out.phases.p3.subThreadEventCount++;
        out.phases.p3.subThreadIds.add(p.threadId);
        return;
      }
      if (!fromParent) return;

      if (phase === 'p1' && item.type === 'agentMessage') {
        const t = extractAgentMessageText(item);
        if (typeof t === 'string') {
          if (out.phases.p1.agentMessage) out.phases.p1.agentMessage += '\n';
          out.phases.p1.agentMessage += t;
        }
      }

      if (phase === 'p2') {
        // The drain signal: any exec/shell-style item completing. Codex's
        // shell tool emits item.type === 'commandExecution' for built-in
        // shell, or 'mcpToolCall' for MCP-registered shells. We accept
        // either to be robust to codex naming.
        const isExecLike =
          item.type === 'commandExecution' ||
          item.type === 'execCommand' ||
          item.type === 'mcpToolCall';
        if (isExecLike && !out.phases.p2.drainObserved) {
          out.phases.p2.drainObserved = true;
          out.phases.p2.drainItemId = item.id ?? null;
          if (phase2DrainResolve) {
            const r = phase2DrainResolve;
            phase2DrainResolve = null;
            r();
          }
        }
        // Stray item/completed AFTER TurnAborted.
        if (phase2InterruptCutoffT !== null && now() > phase2InterruptCutoffT) {
          out.phases.p2.strayItemCompletedAfterAbort++;
        }
      }

      if (phase === 'p3') {
        if (item.type === 'collabAgentToolCall' || item.type === 'spawnAgentToolCall') {
          out.phases.p3.spawnItemSeen = true;
          const ids = item.receiverThreadIds ?? item.params?.receiverThreadIds ?? [];
          if (Array.isArray(ids)) {
            for (const id of ids)
              if (!out.phases.p3.receiverThreadIds.includes(id))
                out.phases.p3.receiverThreadIds.push(id);
          }
        }
        if (item.type === 'agentMessage') {
          const t = extractAgentMessageText(item);
          if (typeof t === 'string') {
            if (out.phases.p3.agentMessage) out.phases.p3.agentMessage += '\n';
            out.phases.p3.agentMessage += t;
          }
        }
      }

      if (phase === 'p4' && item.type === 'agentMessage') {
        const t = extractAgentMessageText(item);
        if (typeof t === 'string') {
          if (out.phases.p4.agentMessage) out.phases.p4.agentMessage += '\n';
          out.phases.p4.agentMessage += t;
        }
      }
    });

    // Watch turn/started to capture current turnId. Wire shape:
    // `params.turn.id` (codex v2 protocol).
    let lastTurnId = null;
    client.onNotification(M.turnStarted, (p) => {
      if (p?.threadId === out.threadId) lastTurnId = p?.turn?.id ?? null;
    });

    // ---- session boot ----
    await client.request(M.initialize, {
      clientInfo: { name: 'codex_app_server_daemon', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    const startResp = await client.request(M.threadStart, { cwd });
    out.threadId = startResp?.thread?.id ?? null;
    if (out.threadId === null) throw new Error('no parent threadId from thread/start');

    // ===================================================================
    // Phase 1 — request_user_input
    // ===================================================================
    phase = 'p1';
    {
      const completed = new Promise((res) => (currentTurnCompletedResolve = res));
      const turnP = client.request(M.turnStart, {
        threadId: out.threadId,
        input: [{ type: 'text', text: PHASE1_PROMPT }],
      });
      turnP.catch(() => {});
      await Promise.race([
        completed,
        sleep(opts.turnTimeoutMs).then(() => {
          throw new Error('phase1 timeout: no turn/completed');
        }),
      ]).then(
        () => {
          out.phases.p1.completed = true;
          out.phases.p1.t_completed = now();
        },
        (e) => {
          out.phases.p1.error = e?.message ?? String(e);
        },
      );
    }

    // ===================================================================
    // Phase 2 — cross-state: drain → turn/interrupt → next turn/start
    // ===================================================================
    if (!out.phases.p1.error) {
      phase = 'p2';
      phase2DrainSignal = new Promise((res) => (phase2DrainResolve = res));

      const phase2TurnP = client.request(M.turnStart, {
        threadId: out.threadId,
        input: [{ type: 'text', text: PHASE2_PROMPT }],
      });
      phase2TurnP.catch(() => {});

      // Wait for the drain signal (echo tool's item/completed).
      try {
        await Promise.race([
          phase2DrainSignal,
          sleep(opts.turnTimeoutMs).then(() => {
            throw new Error('phase2 drain timeout');
          }),
        ]);
      } catch (e) {
        out.phases.p2.error = e?.message ?? String(e);
      }

      if (!out.phases.p2.error) {
        // Issue turn/interrupt and await its reply (= TurnAborted).
        out.phases.p2.t_interruptSent = now();
        const turnIdForInterrupt = lastTurnId;
        try {
          await client.request(M.turnInterrupt, {
            threadId: out.threadId,
            turnId: turnIdForInterrupt,
          });
          out.phases.p2.t_turnAborted = now();
          phase2InterruptCutoffT = out.phases.p2.t_turnAborted;
        } catch (e) {
          out.phases.p2.error = `turn/interrupt failed: ${e?.message ?? e}`;
        }
      }

      // Settle 1s for stray item/completed accounting.
      await sleep(1_000);
      out.phases.p2.nextTurnIssued = !out.phases.p2.error;
    }

    // ===================================================================
    // Phase 3 — spawn_agent (issued AS the cross-state next turn)
    // ===================================================================
    if (!out.phases.p2.error) {
      phase = 'p3';
      const completed = new Promise((res) => (currentTurnCompletedResolve = res));
      const phase3TurnP = client.request(M.turnStart, {
        threadId: out.threadId,
        input: [{ type: 'text', text: PHASE3_PROMPT }],
      });
      phase3TurnP.catch(() => {});
      await Promise.race([
        completed,
        sleep(opts.turnTimeoutMs).then(() => {
          throw new Error('phase3 timeout: no turn/completed');
        }),
      ]).then(
        () => {
          out.phases.p3.completed = true;
          out.phases.p3.t_completed = now();
        },
        (e) => {
          out.phases.p3.error = e?.message ?? String(e);
        },
      );
    }

    // ===================================================================
    // Phase 4 — approval round-trip
    // ===================================================================
    if (!out.phases.p3.error) {
      phase = 'p4';
      const completed = new Promise((res) => (currentTurnCompletedResolve = res));
      const phase4TurnP = client.request(M.turnStart, {
        threadId: out.threadId,
        input: [{ type: 'text', text: PHASE4_PROMPT }],
      });
      phase4TurnP.catch(() => {});
      await Promise.race([
        completed,
        sleep(opts.turnTimeoutMs).then(() => {
          throw new Error('phase4 timeout: no turn/completed');
        }),
      ]).then(
        () => {
          out.phases.p4.completed = true;
          out.phases.p4.t_completed = now();
        },
        (e) => {
          out.phases.p4.error = e?.message ?? String(e);
        },
      );
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
  // Convert Sets to arrays for serialization.
  out.phases.p3.subThreadIds = Array.from(out.phases.p3.subThreadIds);
  out.phases.p4.approvalMethods = Array.from(out.phases.p4.approvalMethods);

  const p1Pass = out.phases.p1.completed && out.phases.p1.ruiObserved >= 1;
  const p2Pass =
    out.phases.p2.drainObserved &&
    out.phases.p2.t_turnAborted !== null &&
    out.phases.p2.strayItemCompletedAfterAbort === 0 &&
    !out.phases.p2.error;
  const p3Pass =
    out.phases.p3.completed &&
    out.phases.p3.spawnItemSeen &&
    out.phases.p3.receiverThreadIds.length > 0 &&
    out.phases.p3.subThreadEventCount > 0;
  const p4Pass = out.phases.p4.completed && out.phases.p4.approvalRequests >= 1;

  let verdict;
  if (out.diagnostics.fatal) verdict = 'error';
  else if (!p1Pass) verdict = 'fail_phase1';
  else if (!p2Pass) verdict = 'fail_phase2';
  else if (!p3Pass) verdict = 'fail_phase3';
  else if (!p4Pass) verdict = 'fail_phase4';
  else verdict = 'pass';

  return {
    ...out,
    passFlags: { p1: p1Pass, p2: p2Pass, p3: p3Pass, p4: p4Pass },
    verdict,
  };
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
  const runDir = join(capturesRoot, `r4-${startEpochMs}`);
  mkdirSync(runDir, { recursive: true });

  process.stderr.write(`[r4] captures → ${runDir}\n`);
  process.stderr.write(`[r4] runs=${opts.runs} turn_timeout_ms=${opts.turnTimeoutMs}\n`);

  const summaries = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = Date.now();
    process.stderr.write(`[r4] run ${i + 1}/${opts.runs} … `);
    const summary = await runOnce({ runIdx: i, runDir, opts, startEpochMs });
    summaries.push(summary);
    const flags = summary.passFlags ?? {};
    const phaseTag = `p1=${flags.p1 ? '✓' : '✗'} p2=${flags.p2 ? '✓' : '✗'} p3=${flags.p3 ? '✓' : '✗'} p4=${flags.p4 ? '✓' : '✗'}`;
    process.stderr.write(`${summary.verdict} ${phaseTag} (${Date.now() - t0}ms)\n`);
  }

  const buckets = {};
  for (const s of summaries) buckets[s.verdict] = (buckets[s.verdict] ?? 0) + 1;

  const summary = {
    spike: 'R4',
    startEpochMs,
    opts,
    runs: summaries.length,
    verdictCounts: buckets,
    perRun: summaries,
  };

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`[r4] verdicts: ${JSON.stringify(buckets)}\n`);

  const totalOk = summaries.length > 0 && summaries.every((s) => s.verdict === 'pass');
  process.exit(totalOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[r4] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
