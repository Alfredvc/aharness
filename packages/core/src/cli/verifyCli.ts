/**
 * `aharness verify <file>.fsm.ts` — codex-side standalone verifier.
 *
 * CI use: loads the FSM via `loadFsm` (re-exported from `@aharness/core`;
 * substrate-agnostic per migration plan §0 author surface reuse rule), runs
 * the pure codex-side verifier (`@aharness/core/src/verify`), then probes
 * Codex config/model catalog only when explicit state-level model declarations
 * declarations require it. The command performs no run directory writes and
 * returns an exit code:
 *   - `0` when the verifier returns `ok: true`. Warning detail lines are
 *     reported via the injected `log` callback and do not block.
 *   - `1` when any error-severity issue is present. Each issue is logged
 *     in the form `[<severity>] <check> (<stateId>): <message>`, prefixed
 *     with `file:line:` when source-location metadata is available.
 *
 * The `log` callback is injected so tests can capture output without
 * stubbing `console.log`. The function never calls `process.exit`; the
 * dispatcher in `cli/main.ts` translates the returned exitCode into a
 * process exit.
 */
import { dirname, resolve } from 'node:path';
import { loadFsm, RetiredOwnerDecisionSurfaceError } from '../loader/index.js';

import { verify } from '../verify/index.js';
import {
  createCodexConfigModelProvider,
  verifyStateModelCatalog,
  type CodexConfigModelProvider,
  type CodexConfigModelProviderFactory,
} from '../verify/clearOnEntryModelCatalog.js';
import { formatVerifyIssue } from './verifyIssueFormat.js';

export interface RunVerifyCliOpts {
  /** Absolute or `repoRoot`-relative path to the user's `<file>.fsm.ts`. */
  readonly fsmPath: string;
  /**
   * Project root — where `.aharness/cache/` (loader's hashed bundle cache)
   * and `node_modules/` live. Defaults to `process.cwd()`. Tests inject a
   * tmpdir so the cache does not pollute the workspace.
   */
  readonly repoRoot?: string;
  /** Sink for status / issue lines. Tests pass `vi.fn()` to capture output. */
  readonly log: (line: string) => void;
  /** Test seam for state-level model catalog verification. */
  readonly modelCatalogProvider?: CodexConfigModelProvider;
  /** Test seam for catalog-provider startup failures. */
  readonly modelCatalogProviderFactory?: CodexConfigModelProviderFactory;
}

export interface RunVerifyCliResult {
  readonly exitCode: 0 | 1;
}

export async function runVerifyCli(opts: RunVerifyCliOpts): Promise<RunVerifyCliResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  let loaded: Awaited<ReturnType<typeof loadFsm>>;
  try {
    loaded = await loadFsm({ filePath: opts.fsmPath, repoRoot });
  } catch (e) {
    if (e instanceof RetiredOwnerDecisionSurfaceError) {
      for (const issue of e.issues) {
        opts.log(
          formatVerifyIssue({
            severity: 'error',
            check: 'per-state-data-schema-resolvable',
            stateId: issue.stateId ?? '',
            message: issue.message,
            ...(issue.sourceFile !== undefined
              ? { location: { sourceFile: issue.sourceFile, line: issue.line } }
              : {}),
          }),
        );
      }
      return { exitCode: 1 };
    }
    throw e;
  }
  const fsmFileDir = dirname(resolve(repoRoot, opts.fsmPath));
  const result = verify(loaded.machine, loaded.sidecar, loaded.issues, {
    skillEnv: { fsmFileDir, repoRoot },
    skillOriginManifest: loaded.skillOriginManifest,
  });
  if (result.ok) {
    for (const issue of result.warnings) {
      opts.log(formatVerifyIssue(issue, { sourceLocations: loaded.sourceLocations }));
    }
    const catalogIssues = await verifyStateModelCatalog({
      machine: loaded.machine,
      defaultCwd: repoRoot,
      providerFactory:
        opts.modelCatalogProviderFactory ??
        (async () => opts.modelCatalogProvider ?? createCodexConfigModelProvider()),
    });
    if (catalogIssues.length > 0) {
      for (const issue of catalogIssues) {
        opts.log(formatVerifyIssue(issue, { sourceLocations: loaded.sourceLocations }));
      }
      return { exitCode: 1 };
    }
    const warningCount = result.warnings.length;
    opts.log(`verify: ok (${String(warningCount)} warnings)`);
    return { exitCode: 0 };
  }
  for (const issue of result.issues) {
    opts.log(formatVerifyIssue(issue, { sourceLocations: loaded.sourceLocations }));
  }
  return { exitCode: 1 };
}
