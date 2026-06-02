# FSM Run Final Overview And Share Card Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-02-fsm-run-final-overview-share-card-roadmap.md`
**Current slice:** Slice 3 - web client completion contract
**Current phase:** plan-slice
**Current detailed plan:** not written yet
**Current fix source:** none
**Last completed:** Slice 2 - summary API and bootstrap contract

## Grounding Documents

- `docs/specs/2026-06-02-fsm-run-final-overview-share-card-design.md`
- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-roadmap.md`

## Iteration Workflow

1. Write a bounded detailed plan for the current slice.
2. Review and fix the detailed plan until the plan-review gate passes.
3. Execute only the current slice.
4. Review the completed slice and fix real findings.
5. Run the slice verification commands.
6. Update this recipe to the next slice after verification and commit.

## Orchestrator Rules

- Keep each iteration scoped to one roadmap slice.
- Preserve existing behavior unless the current slice explicitly changes it.
- Update docs in the same slice when behavior, public API, commands, package facts, or user-facing workflows change.
- Do not enable later-slice behavior early.
- Do not silently defer real review findings.
- Advance `Current slice` only after verification and commit.

## Current State

Slice 0 was implemented and accepted. It added internal canonical
`git.snapshot.recorded` and `git.diff.recorded` contracts, a no-shell git fact
helper, synchronous runtime recording after `run.started` and before terminal
`run.completed` / `run.failed`, and focused tests for ordering, degradation,
and low-disclosure payloads.

Final Slice 0 verification passed:

- `pnpm exec vitest run packages/core/test/runEvents.gitFacts.test.ts packages/core/test/cli.runCli.test.ts`
- `pnpm run typecheck`
- `git diff --check`
- `rg -n "publishRunFailedOnce|signalTerminalCompletion" packages/core/src/cli/runCli.ts`

Slice 1 was implemented and accepted. It added internal `RunCompletionStats`
types, a pure query-layer projection, topology-aware state buckets,
query-service access, and focused projection/query tests. Bootstrap, `/summary`,
web UI behavior, and public docs remain reserved for later slices.

- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-1-completion-stats-projection.md`

Final Slice 1 verification passed:

- `pnpm exec vitest run packages/core/test/runEvents.completionStats.test.ts packages/core/test/runEvents.queryService.test.ts packages/core/test/runEvents.index.test.ts`
- `pnpm run typecheck`
- `git diff --check`

Slice 2 was implemented and accepted. It exposed terminal completion stats
through bootstrap and authenticated `GET /api/runs/:runId/summary`, updated the
run-scoped route-service contract and all known implementers, preserved
run-scoped unavailable-log and SSE/event boundaries, documented the architecture
contract, and fixed a completion-projection privacy leak where
`git.diff.recorded.data.to` could be interpreted as a state path.

- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-2-summary-api-bootstrap-contract.md`

Final Slice 2 verification passed:

- `pnpm run build`
- `pnpm exec vitest run packages/core/test/runEvents.completionStats.test.ts packages/core/test/runEvents.queryService.test.ts packages/core/test/ui.runScopedServer.test.ts packages/core/test/ui.sse.test.ts packages/core/test/ui.browserGolden.test.ts packages/core/test/runtime.uiExports.types.test.ts packages/core/test/runEvents.index.test.ts`
- `node --test scripts/spikes/replay-run-prefix-ui.test.mjs`
- `node --check scripts/spikes/replay-run-prefix-ui.mjs`
- `node --check packages/core/scripts/browserGoldenServer.mjs`
- `rg -n "getCompletionStats" packages/core/src/cli/visualizeCli.ts packages/core/test/ui.browserGolden.test.ts packages/core/test/runtime.uiExports.types.test.ts packages/core/test/ui.sse.test.ts scripts/spikes/replay-run-prefix-ui.mjs packages/core/scripts/browserGoldenServer.mjs`
- `pnpm exec vitest run packages/core/test/runEvents.queryService.test.ts packages/core/test/ui.runScopedServer.test.ts packages/core/test/ui.sse.test.ts packages/core/test/ui.browserGolden.test.ts packages/core/test/runtime.uiExports.types.test.ts packages/core/test/runEvents.index.test.ts`
- `pnpm run typecheck`
- `git diff --check`

Next step: write and review a bounded detailed plan for Slice 3 - web client
completion contract. Slice 3 should add web-side completion-stat types,
validators, summary fetching, bootstrap completion validation, and SSE allowlist
entries for git fact events without implementing the final overview modal or
share-card behavior.
