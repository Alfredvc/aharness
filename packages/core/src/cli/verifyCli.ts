/**
 * `aharness verify <file>.fsm.ts` — codex-side standalone verifier.
 *
 * CI use, no daemon, no codex binary, no run directory writes. Loads the
 * FSM via `loadFsm` (re-exported from `@aharness/core`; substrate-agnostic
 * per migration plan §0 author surface reuse rule), runs the codex-side
 * verifier (`@aharness/core/src/verify`), and returns an exit code:
 *   - `0` when the verifier returns `ok: true`. Warnings are reported via
 *     the injected `log` callback and do not block.
 *   - `1` when any error-severity issue is present. Each issue is logged
 *     in the form `[<severity>] <check> (<stateId>): <message>`.
 *
 * The `log` callback is injected so tests can capture output without
 * stubbing `console.log`. The function never calls `process.exit`; the
 * dispatcher in `cli/main.ts` translates the returned exitCode into a
 * process exit.
 */
import { dirname, resolve } from 'node:path';
import { loadFsm } from '../loader/index.js';

import { verify } from '../verify/index.js';

export interface RunVerifyCliOpts {
  /** Absolute or `repoRoot`-relative path to the user's `<file>.fsm.ts`. */
  readonly fsmPath: string;
  /**
   * Project root — where `.harness/cache/` (loader's hashed bundle cache)
   * and `node_modules/` live. Defaults to `process.cwd()`. Tests inject a
   * tmpdir so the cache does not pollute the workspace.
   */
  readonly repoRoot?: string;
  /** Sink for status / issue lines. Tests pass `vi.fn()` to capture output. */
  readonly log: (line: string) => void;
}

export interface RunVerifyCliResult {
  readonly exitCode: 0 | 1;
}

export async function runVerifyCli(opts: RunVerifyCliOpts): Promise<RunVerifyCliResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const loaded = await loadFsm({ filePath: opts.fsmPath, repoRoot });
  const fsmFileDir = dirname(resolve(repoRoot, opts.fsmPath));
  const result = verify(loaded.machine, loaded.sidecar, loaded.issues, {
    skillEnv: { fsmFileDir, repoRoot },
  });
  if (result.ok) {
    const warningCount = result.warnings.length;
    opts.log(`verify: ok (${String(warningCount)} warnings)`);
    return { exitCode: 0 };
  }
  for (const issue of result.issues) {
    opts.log(`[${issue.severity}] ${issue.check} (${issue.stateId}): ${issue.message}`);
  }
  return { exitCode: 1 };
}
