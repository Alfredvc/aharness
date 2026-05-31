# Codex-Style Transcript Polish Implementation Recipe

**Parent roadmap:** `docs/plans/2026-05-31-codex-style-transcript-polish-roadmap.md`
**Current slice:** Slice 3 - ActivePanel rendering polish and markdown
**Current phase:** write-plan
**Current detailed plan:** `docs/plans/2026-05-31-codex-style-transcript-polish-slice-3-activepanel-rendering-polish-and-markdown.md`
**Current fix source:** none
**Last completed:** Slice 2 - transcript display-policy transforms (this commit)

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

Slice 2 is accepted and committed in the same commit as this recipe update.
Continue with Slice 3 from the parent roadmap: ActivePanel rendering polish
and markdown. No detailed Slice 3 plan exists yet. Write and review
`docs/plans/2026-05-31-codex-style-transcript-polish-slice-3-activepanel-rendering-polish-and-markdown.md`
before implementation.

Slice 2 added browser transcript display-policy transforms over typed
`TranscriptItem`s: default/dev visibility, display-only output truncation,
same-turn exploration grouping, event-id preservation for same-id and folded
tool rows, and parent-level subagent summary policy. ActivePanel now consumes
`TranscriptDisplayItem` without completing final Slice 3 rendering polish.
The final verification for Slice 2 passed the focused web-ui store and
ActivePanel suites, web-ui typecheck, root typecheck, targeted oxlint, and
`git diff --check`. Slice 3 should inspect the accepted non-blocking review
note about the stale `FrameworkNoteRow` orientation comment while planning
the final renderer changes.
Worktree mode is disabled; use the current checkout.
