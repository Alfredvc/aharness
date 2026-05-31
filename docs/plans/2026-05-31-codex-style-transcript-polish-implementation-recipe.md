# Codex-Style Transcript Polish Implementation Recipe

**Parent roadmap:** `docs/plans/2026-05-31-codex-style-transcript-polish-roadmap.md`
**Current slice:** Slice 2 - transcript display-policy transforms
**Current phase:** write-plan
**Current detailed plan:** `docs/plans/2026-05-31-codex-style-transcript-polish-slice-2-transcript-display-policy-transforms.md`
**Current fix source:** none
**Last completed:** Slice 1 - durable core/API compact row enrichment (this commit)

## Durable Grounding

- `docs/ideas/2026-05-31-codex-style-transcript-polish.md`
- `docs/specs/2026-05-31-codex-style-transcript-polish-design.md`
- `docs/plans/2026-05-31-codex-style-transcript-polish-roadmap.md`

## Iteration Workflow

1. Write or confirm the detailed plan for the current slice.
2. Review the detailed plan before implementation.
3. Execute only the current slice.
4. Review the completed slice.
5. Run final verification.
6. Update this recipe to the next slice and commit.

## Orchestrator Rules

- Keep each iteration scoped to one roadmap slice.
- Preserve existing behavior unless the current slice explicitly changes it.
- Update docs in the same slice as behavior changes.
- Do not enable later-slice behavior early.
- Do not silently defer real review findings.
- Advance `Current slice` only after verification and commit.

## Current Handoff

Slice 1 is accepted and committed in the same commit as this recipe update.
Continue with Slice 2 from the parent roadmap: transcript display-policy
transforms. No detailed Slice 2 plan exists yet. Write and review
`docs/plans/2026-05-31-codex-style-transcript-polish-slice-2-transcript-display-policy-transforms.md`
before implementation.

Slice 1 added durable core/API compact-row enrichment: run lifecycle rows,
safe failed-submit transition-failure rows, state display metadata including
target model/effort, and conservative tool/subagent display hints from
normalized sources. The final verification for Slice 1 passed the focused
core adapter/index/query/server suites, runtime/CLI suites, web-ui
store/ActivePanel guard suites, root typecheck, and web-ui typecheck.
Worktree mode is disabled; use the current checkout.
