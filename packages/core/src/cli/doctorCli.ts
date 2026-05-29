/**
 * `aharness doctor` — codex-side standalone health check.
 *
 * Reports to the operator:
 *   1. Codex binary status — runs `codex --version` via the version-gate
 *      (Task 9's `checkCodexVersion`) and surfaces the result. When the
 *      pinned minimum is a git-pin (codex-rs has no published semver tags
 *      today), the gate returns `ok: true` plus a warning `message`; the
 *      doctor surfaces that warning but still exits 0 — the gate already
 *      decided that a git-pin is non-blocking.
 *   2. Active runs — enumerates `<repoRoot>/.aharness/runs/<runId>` and per
 *      run reports:
 *        - `daemon.alive` age (mtime delta). Missing → `unknown`. If the
 *          age exceeds `STALE_DAEMON_THRESHOLD_MS` (15 s) AND no
 *          `RUN_REPORT.json` is present, a staleness warning is emitted;
 *          when `RUN_REPORT.json` exists the daemon legitimately exited
 *          and the warning is suppressed.
 *        - Cache-ratio summary — legacy last `cache.metrics` JSONL line
 *          from `events.jsonl`, when present. Missing/unparseable →
 *          silently skipped (new canonical run events do not add token
 *          usage capture in Slice 1).
 *        - Terminal classification — `terminal` and `stateAtTerminal`
 *          from `RUN_REPORT.json` (Task 35c) when present. Absent →
 *          run is still active, no line emitted.
 *
 * Both `checkVersion` and `listRuns` are injected so tests can run without
 * the codex binary on PATH and without writing to a real run directory.
 * Defaults are wired here for production use.
 *
 * Exit code policy: `v.ok ? 0 : 1`. The gate's `ok` field is the single
 * source of truth — git-pin warnings and stale-daemon warnings ride
 * along on `ok: true` and do not flip the exit code.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { checkCodexVersion, type VersionGateResult } from '../appServer/version.js';

const exec = promisify(execFile);

/**
 * Threshold above which `daemon.alive` is considered stale. The daemon
 * touches the file every 5 s (`startLiveness` default `intervalMs`), so
 * 15 s = three missed ticks.
 */
const STALE_DAEMON_THRESHOLD_MS = 15_000;

/** Legacy last `cache.metrics` JSONL line, if an older run recorded one. */
export interface DoctorCacheMetrics {
  readonly turn: number;
  readonly totalInput: number;
  readonly totalCached: number;
  readonly ratioPctSinceTurn5: number | null;
  readonly healthy: boolean;
}

/** Subset of `RunReport` consumed by the doctor. */
export interface DoctorTerminal {
  readonly terminal: string;
  readonly stateAtTerminal: string;
}

export interface DoctorRun {
  readonly runId: string;
  readonly daemonAliveAgeMs: number | null;
  readonly cacheMetrics?: DoctorCacheMetrics | null;
  readonly terminal?: DoctorTerminal | null;
}

export interface RunDoctorOpts {
  readonly log: (s: string) => void;
  readonly now: () => Date;
  readonly checkVersion?: () => Promise<VersionGateResult>;
  readonly listRuns?: () => Promise<ReadonlyArray<DoctorRun>>;
}

export interface RunDoctorResult {
  readonly exitCode: 0 | 1;
}

export async function runDoctorCli(o: RunDoctorOpts): Promise<RunDoctorResult> {
  const v = await (o.checkVersion ?? defaultCheckVersion)();
  if (v.ok) {
    o.log(`codex ${v.found ?? '<unknown>'} OK (>= ${v.required})`);
    // Git-pin (and any future ok-with-warning) path: surface the warning
    // even though we exit 0. The gate decided ok; we just relay.
    if (v.message) o.log(`warning: ${v.message}`);
  } else {
    o.log(`codex: ${v.message ?? 'not OK'}`);
  }
  const runs = await (o.listRuns ?? defaultListRuns)();
  if (runs.length === 0) {
    o.log('no active runs');
    return { exitCode: v.ok ? 0 : 1 };
  }
  for (const r of runs) {
    const age = r.daemonAliveAgeMs === null ? 'unknown' : `${String(r.daemonAliveAgeMs)}ms`;
    o.log(`run ${r.runId} alive-age=${age}`);
    // Staleness warning: only when we have a numeric age over threshold
    // AND the run has not already terminated. A terminated run's daemon
    // is supposed to be gone — warning would be a false positive.
    if (
      r.daemonAliveAgeMs !== null &&
      r.daemonAliveAgeMs > STALE_DAEMON_THRESHOLD_MS &&
      !r.terminal
    ) {
      o.log(
        `  warning: daemon.alive is ${String(r.daemonAliveAgeMs)}ms old (> ${String(STALE_DAEMON_THRESHOLD_MS)}ms threshold)`,
      );
    }
    if (r.cacheMetrics) {
      const m = r.cacheMetrics;
      const ratio = m.ratioPctSinceTurn5 === null ? 'n/a' : `${m.ratioPctSinceTurn5.toFixed(1)}%`;
      o.log(
        `  cache: turn=${String(m.turn)} input=${String(m.totalInput)} cached=${String(m.totalCached)} ratio=${ratio} healthy=${m.healthy ? 'yes' : 'no'}`,
      );
    }
    if (r.terminal) {
      o.log(`  terminal: ${r.terminal.terminal} (state=${r.terminal.stateAtTerminal})`);
    }
  }
  return { exitCode: v.ok ? 0 : 1 };
}

async function defaultCheckVersion(): Promise<VersionGateResult> {
  try {
    return await checkCodexVersion(async (cmd, args) => {
      const r = await exec(cmd, args.slice());
      return { stdout: r.stdout, status: 0 };
    });
  } catch {
    return { ok: false, found: null, required: 'unknown', message: '`codex` not on PATH' };
  }
}

function defaultListRuns(): Promise<ReadonlyArray<DoctorRun>> {
  const root = join(process.cwd(), '.aharness', 'runs');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return Promise.resolve([]);
  }
  const out: DoctorRun[] = [];
  for (const runId of entries) {
    const runDir = join(root, runId);
    out.push({
      runId,
      daemonAliveAgeMs: readDaemonAliveAge(join(runDir, 'daemon.alive')),
      cacheMetrics: readLastCacheMetrics(join(runDir, 'events.jsonl')),
      terminal: readTerminal(join(runDir, 'RUN_REPORT.json')),
    });
  }
  return Promise.resolve(out);
}

function readDaemonAliveAge(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read the last non-empty line of `events.jsonl`, parse it, and return it
 * iff it is a legacy `cache.metrics` line. Anything else (file missing,
 * parse fail, canonical envelope, or different `kind`) is treated as
 * "no metrics available".
 */
function readLastCacheMetrics(path: string): DoctorCacheMetrics | null {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = body.split('\n').filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return null;
  }
  if (!isCacheMetricsLine(parsed)) return null;
  return {
    turn: parsed.turn,
    totalInput: parsed.totalInput,
    totalCached: parsed.totalCached,
    ratioPctSinceTurn5: parsed.ratioPctSinceTurn5,
    healthy: parsed.healthy,
  };
}

function isCacheMetricsLine(v: unknown): v is {
  kind: 'cache.metrics';
  turn: number;
  totalInput: number;
  totalCached: number;
  ratioPctSinceTurn5: number | null;
  healthy: boolean;
} {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o['kind'] !== 'cache.metrics') return false;
  if (typeof o['turn'] !== 'number') return false;
  if (typeof o['totalInput'] !== 'number') return false;
  if (typeof o['totalCached'] !== 'number') return false;
  const ratio = o['ratioPctSinceTurn5'];
  if (ratio !== null && typeof ratio !== 'number') return false;
  if (typeof o['healthy'] !== 'boolean') return false;
  return true;
}

function readTerminal(path: string): DoctorTerminal | null {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const terminalRaw = o['terminal'];
  const stateRaw = o['stateAtTerminal'];
  const terminal = typeof terminalRaw === 'string' ? terminalRaw : null;
  const stateAtTerminal = typeof stateRaw === 'string' ? stateRaw : '';
  if (terminal === null) return null;
  return { terminal, stateAtTerminal };
}
