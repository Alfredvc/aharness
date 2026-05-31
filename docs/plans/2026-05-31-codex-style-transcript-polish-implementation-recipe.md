# Codex-Style Transcript Polish Implementation Recipe

**Parent roadmap:** `docs/plans/2026-05-31-codex-style-transcript-polish-roadmap.md`
**Current slice:** complete
**Current phase:** complete
**Current detailed plan:** `docs/plans/2026-05-31-codex-style-transcript-polish-slice-3-activepanel-rendering-polish-and-markdown.md`
**Current fix source:** none
**Last completed:** Slice 3 - ActivePanel rendering polish and markdown (this commit)

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

All roadmap slices are complete. Slice 3 rendered the normalized transcript
display policy in `ActivePanel`: chronological state transitions, lifecycle and
transition-failure rows, fresh-clear boundaries, subdued reasoning, grouped
exploration, concise tool/MCP/subagent rows, markdown assistant messages without
raw HTML activation, and scoped CSS. The slice also added the markdown and DOM
test dependencies, refreshed the embedded browser UI bundle, and updated public
reference docs for the richer transcript surface.

Final verification passed for the focused ActivePanel/App render suites,
store suite, web-ui typecheck, web-ui build, root typecheck, targeted oxlint,
and `git diff --check`. No next slice remains.
