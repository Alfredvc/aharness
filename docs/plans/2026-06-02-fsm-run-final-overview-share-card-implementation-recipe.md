# FSM Run Final Overview And Share Card Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-02-fsm-run-final-overview-share-card-roadmap.md`
**Current slice:** Slice 2 - summary API and bootstrap contract
**Current phase:** plan-slice
**Current detailed plan:** not written yet
**Current fix source:** none
**Last completed:** Slice 1 - completion stats projection

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

Next step: write and review a bounded detailed plan for Slice 2 - summary API
and bootstrap contract. Slice 2 should expose Slice 1 completion stats through
terminal bootstrap and authenticated `/api/runs/:runId/summary`, preserve
existing run-scoped unavailable-log behavior, and update `docs/architecture.md`.
