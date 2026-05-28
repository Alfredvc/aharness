/**
 * `runVerifyCli` end-to-end test. Compiles a tiny FSM via `loadFsm` and
 * runs the codex-side verifier through the CLI entry point.
 *
 * The two fixtures under `./fixtures/` exercise the pass/fail paths:
 *   - `single-state.fsm.ts` — one stateful state with a submit exit and
 *     a paired `on` handler reaching a terminal final state. Verify ok.
 *   - `black-hole.fsm.ts` — a passive state with no `always`/`after`/
 *     `invoke.onDone` trigger, so the actor would be stuck on entry.
 *     Trips `no-black-hole-non-terminals` (and `terminal-reachability`).
 *
 * A fresh tmpdir is used as `repoRoot` for each test so `.aharness/cache/`
 * does not bleed across cases (loadFsm writes the bundled `.mjs` there).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runVerifyCli } from '../src/cli/verifyCli.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('runVerifyCli', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('exits 0 on a passing FSM', async () => {
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'single-state.fsm.ts'),
      repoRoot,
      log,
    });
    expect(r.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('verify: ok'));
  });

  it('exits 1 and prints issues on a failing FSM', async () => {
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'black-hole.fsm.ts'),
      repoRoot,
      log,
    });
    expect(r.exitCode).toBe(1);
    // At least one issue line should name a real check id from the verifier.
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('no-black-hole-non-terminals'))).toBe(true);
  });

  it('flags missing skill refs via skill-must-resolve when neither root nor path exists', async () => {
    const log = vi.fn();
    const r = await runVerifyCli({
      fsmPath: join(fixtureDir, 'skills.fsm.ts'),
      repoRoot,
      log,
    });
    expect(r.exitCode).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    // Both refs miss in this fresh repoRoot — the name-form (no
    // `.agents/skills/` tree) and the path-form (sibling file does
    // not exist).
    const skillLines = lines.filter((l) => l.includes('skill-must-resolve'));
    expect(skillLines.length).toBeGreaterThanOrEqual(2);
    expect(skillLines.some((l) => l.includes('not-installed'))).toBe(true);
    expect(skillLines.some((l) => l.includes('local.md'))).toBe(true);
  });

  it('passes skill-must-resolve when the skill file exists alongside the FSM', async () => {
    // Materialise a sibling `skills/local.md` alongside the fixture by
    // copying the FSM into a tmp dir whose `skills/local.md` exists.
    const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-skill-pass-'));
    const tmpFsmPath = join(tmpFsmDir, 'skills.fsm.ts');
    // We need a fixture that only declares a path-form skill (the
    // name-form would still miss). Inline a minimal one.
    const minimal = `import { aharness, state, terminal, exit, skill } from '@aharness/core';
interface P { q: string }
export const machine = aharness.machine({
  id: 'pass',
  initial: 'a',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    a: state({ entryPrompt: 'x', skills: [skill({ path: './skills/local.md' })], exits: { ok: exit<P>({ to: 'done' }) } }),
    done: terminal('success'),
  },
});
export default machine;
`;
    await fs.writeFile(tmpFsmPath, minimal, 'utf8');
    await fs.mkdir(join(tmpFsmDir, 'skills'), { recursive: true });
    await fs.writeFile(join(tmpFsmDir, 'skills', 'local.md'), '# local\nbody.\n');
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath: tmpFsmPath, repoRoot, log });
    expect(r.exitCode).toBe(0);
    await fs.rm(tmpFsmDir, { recursive: true, force: true });
  });

  it('downgrades optional skill misses to warning (does not block run)', async () => {
    const tmpFsmDir = await fs.mkdtemp(join(tmpdir(), 'codex-verify-cli-skill-opt-'));
    const tmpFsmPath = join(tmpFsmDir, 'skills.fsm.ts');
    const minimal = `import { aharness, state, terminal, exit, skill } from '@aharness/core';
interface P { q: string }
export const machine = aharness.machine({
  id: 'opt',
  initial: 'a',
  context: () => ({ __aharness_visitCount: {} as Record<string, number> }),
  states: {
    a: state({ entryPrompt: 'x', skills: [skill('missing-but-optional', { optional: true })], exits: { ok: exit<P>({ to: 'done' }) } }),
    done: terminal('success'),
  },
});
export default machine;
`;
    await fs.writeFile(tmpFsmPath, minimal, 'utf8');
    const log = vi.fn();
    const r = await runVerifyCli({ fsmPath: tmpFsmPath, repoRoot, log });
    expect(r.exitCode).toBe(0);
    await fs.rm(tmpFsmDir, { recursive: true, force: true });
  });
});
