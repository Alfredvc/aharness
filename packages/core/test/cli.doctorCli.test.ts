/**
 * `runDoctorCli` test. Exercises the dispatcher with fully injected
 * `checkVersion` / `listRuns` so the codex binary and the filesystem are
 * not touched:
 *   1. ok-current (semver match, no runs) → exit 0, "OK" line.
 *   2. below-minimum (`ok: false`)        → exit 1, message line.
 *   3. git-pin (`ok: true` + `message`)   → exit 0, warning line surfaced.
 *   4. multiple runs                       → one line per run with age.
 *   5. cache-metrics last-line             → reports values from the last
 *      `cache.metrics` line; non-metric trailing lines are ignored.
 *   6. terminal classification             → reports terminal kind/state.
 *   7. stale daemon w/o RUN_REPORT        → emits warning.
 *   8. stale daemon w/ RUN_REPORT         → no warning (legitimate exit).
 *   9. fresh daemon                        → no warning.
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  runDoctorCli,
  type DoctorCacheMetrics,
  type DoctorTerminal,
} from '../src/cli/doctorCli.js';

describe('runDoctorCli', () => {
  it('reports OK when codex is current and no runs exist', async () => {
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date('2026-05-02T00:00:00Z'),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('codex 0.42.0'))).toBe(true);
    expect(lines.some((l) => l.includes('no active runs'))).toBe(true);
  });

  it('exits 1 and warns when codex is below minimum', async () => {
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({
        ok: false,
        found: '0.40.0',
        required: '0.42.0',
        message: 'codex 0.40.0 < required 0.42.0',
      }),
      listRuns: async () => [],
    });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('< required'))).toBe(true);
  });

  it('surfaces git-pin warning but exits 0 (gate decided ok)', async () => {
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({
        ok: true,
        found: '0.0.0',
        required: 'git-127434cd8b96',
        message: 'min is a git-pin (git-127434cd8b96); cannot semver-compare against codex 0.0.0',
      }),
      listRuns: async () => [],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('OK'))).toBe(true);
    expect(lines.some((l) => l.includes('git-pin'))).toBe(true);
  });

  it('lists each active run with its daemon.alive age', async () => {
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [
        { runId: 'abcdef-123456', daemonAliveAgeMs: 1500 },
        { runId: 'fedcba-654321', daemonAliveAgeMs: null },
      ],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('run abcdef-123456') && l.includes('1500ms'))).toBe(true);
    expect(lines.some((l) => l.includes('run fedcba-654321') && l.includes('unknown'))).toBe(true);
  });

  it('reports cache-metrics from the last cache.metrics line', async () => {
    const cacheMetrics: DoctorCacheMetrics = {
      turn: 12,
      totalInput: 8000,
      totalCached: 6000,
      ratioPctSinceTurn5: 75.0,
      healthy: true,
    };
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [{ runId: 'r1', daemonAliveAgeMs: 1000, cacheMetrics }],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some(
        (l) =>
          l.includes('cache:') &&
          l.includes('turn=12') &&
          l.includes('input=8000') &&
          l.includes('cached=6000') &&
          l.includes('75.0%') &&
          l.includes('healthy=yes'),
      ),
    ).toBe(true);
  });

  it('reports terminal classification from RUN_REPORT.json', async () => {
    const terminal: DoctorTerminal = { terminal: 'success', stateAtTerminal: 'done' };
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [{ runId: 'r1', daemonAliveAgeMs: 60_000, terminal }],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some(
        (l) => l.includes('terminal:') && l.includes('success') && l.includes('state=done'),
      ),
    ).toBe(true);
  });

  it('warns when daemon.alive is older than 15 s and run has not terminated', async () => {
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [{ runId: 'r1', daemonAliveAgeMs: 20_000, terminal: null }],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some(
        (l) => l.includes('warning:') && l.includes('daemon.alive') && l.includes('20000ms'),
      ),
    ).toBe(true);
  });

  it('does NOT warn when daemon.alive is stale but RUN_REPORT.json present', async () => {
    const terminal: DoctorTerminal = { terminal: 'success', stateAtTerminal: 'done' };
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [{ runId: 'r1', daemonAliveAgeMs: 20_000, terminal }],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('warning:') && l.includes('daemon.alive'))).toBe(false);
  });

  it('does NOT warn when daemon.alive is fresh (<15 s)', async () => {
    const log = vi.fn();
    const r = await runDoctorCli({
      log,
      now: () => new Date(),
      checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      listRuns: async () => [{ runId: 'r1', daemonAliveAgeMs: 5_000 }],
    });
    expect(r.exitCode).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('warning:') && l.includes('daemon.alive'))).toBe(false);
  });
});

/**
 * Filesystem-backed integration test for `defaultListRuns`. Validates the
 * end-to-end JSONL/JSON parsing in a real run-dir layout — the unit tests
 * above bypass `defaultListRuns` via the `listRuns` seam, so this guards
 * the production wiring.
 */
describe('runDoctorCli (filesystem-backed)', () => {
  it('reads cache.metrics from events.jsonl, parses RUN_REPORT.json, and warns on stale daemon.alive', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'doctor-fs-'));
    const cwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const runsRoot = join(repoRoot, '.aharness', 'runs');

      // Run A: events.jsonl with two cache.metrics + a non-metric trailing
      // line; doctor should report values from the last cache.metrics line.
      // We append the non-metric line LAST to confirm the reader walks back
      // to the most recent metric line — wait, the spec says "last
      // non-empty line, parse, skip if not cache.metrics". So we put the
      // non-metric line in the MIDDLE and the most recent cache.metrics
      // line at the end.
      const runA = join(runsRoot, 'aaa');
      mkdirSync(runA, { recursive: true });
      const eventsA = [
        JSON.stringify({
          ts: '2026-05-02T00:00:01Z',
          kind: 'cache.metrics',
          turn: 6,
          totalInput: 100,
          totalCached: 50,
          ratioPctSinceTurn5: 40,
          healthy: false,
        }),
        JSON.stringify({ ts: '2026-05-02T00:00:02Z', kind: 'state.entered', state: 'foo' }),
        JSON.stringify({
          ts: '2026-05-02T00:00:03Z',
          kind: 'cache.metrics',
          turn: 7,
          totalInput: 200,
          totalCached: 150,
          ratioPctSinceTurn5: 75,
          healthy: true,
        }),
      ].join('\n');
      writeFileSync(join(runA, 'events.jsonl'), eventsA + '\n');
      writeFileSync(join(runA, 'daemon.alive'), '');
      // Make daemon.alive fresh.
      const fresh = Date.now() / 1000;
      utimesSync(join(runA, 'daemon.alive'), fresh, fresh);

      // Run B: stale daemon.alive (60 s old) and no RUN_REPORT → must
      // produce the staleness warning.
      const runB = join(runsRoot, 'bbb');
      mkdirSync(runB, { recursive: true });
      writeFileSync(join(runB, 'daemon.alive'), '');
      const stale = (Date.now() - 60_000) / 1000;
      utimesSync(join(runB, 'daemon.alive'), stale, stale);

      // Run C: RUN_REPORT.json present → terminal line emitted, no
      // staleness warning even if daemon.alive is also stale.
      const runC = join(runsRoot, 'ccc');
      mkdirSync(runC, { recursive: true });
      writeFileSync(join(runC, 'daemon.alive'), '');
      utimesSync(join(runC, 'daemon.alive'), stale, stale);
      writeFileSync(
        join(runC, 'RUN_REPORT.json'),
        JSON.stringify({ runId: 'ccc', terminal: 'success', stateAtTerminal: 'done' }),
      );

      const log = vi.fn();
      const r = await runDoctorCli({
        log,
        now: () => new Date(),
        checkVersion: async () => ({ ok: true, found: '0.42.0', required: '0.42.0' }),
      });
      expect(r.exitCode).toBe(0);
      const lines = log.mock.calls.map((c) => String(c[0]));
      // Run A: cache metric from the last metric line.
      expect(
        lines.some(
          (l) =>
            l.includes('cache:') &&
            l.includes('turn=7') &&
            l.includes('input=200') &&
            l.includes('cached=150') &&
            l.includes('75.0%'),
        ),
      ).toBe(true);
      // Run B: stale-daemon warning emitted.
      expect(lines.some((l) => l.includes('warning:') && l.includes('daemon.alive'))).toBe(true);
      // Run C: terminal line emitted; staleness warning suppressed.
      const cIdx = lines.findIndex((l) => l.startsWith('run ccc'));
      expect(cIdx).toBeGreaterThanOrEqual(0);
      // Find the next "run " header (or end) to bound run C's section.
      const nextRunIdx = lines.findIndex((l, i) => i > cIdx && l.startsWith('run '));
      const cSection = lines.slice(cIdx, nextRunIdx === -1 ? undefined : nextRunIdx);
      expect(cSection.some((l) => l.includes('terminal:') && l.includes('success'))).toBe(true);
      expect(cSection.some((l) => l.includes('warning:') && l.includes('daemon.alive'))).toBe(
        false,
      );
    } finally {
      process.chdir(cwd);
    }
  });
});
