# Native Codex Skills for Self-Contained FSM Packages Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-02-native-codex-skills-for-fsm-packages-roadmap.md`
**Current slice:** complete
**Current phase:** complete
**Current detailed plan:** `docs/plans/2026-06-02-native-codex-skills-for-fsm-packages-slice-4-docs-codeflow-prep.md`
**Current fix source:** none
**Last completed:** Slice 4 - docs and codeflow package preparation

## Durable Grounding

- `docs/specs/2026-06-02-native-codex-skills-for-fsm-packages-design.md`
- `docs/plans/2026-06-02-native-codex-skills-for-fsm-packages-roadmap.md`

## Iteration Workflow

1. Write the detailed plan for the current slice.
2. Review and fix the detailed plan before implementation.
3. Execute only the current slice.
4. Review the completed slice and fix verified findings.
5. Run final verification.
6. Update this recipe to the next slice and record the completed commit.

## Orchestrator Rules

- Keep each iteration scoped to one roadmap slice.
- Preserve existing behavior unless the current slice explicitly changes it.
- Update docs in the same slice as behavior changes.
- Do not enable later-slice behavior early.
- Do not silently defer real review findings.
- Advance `Current slice` only after verification and commit.
- Do not store implementation source files, tests, generated files, or broad
  file lists as durable context.

## Current Handoff Notes

Slice 0 was accepted after one fix cycle. It added the authoring/static
validation foundation for native Codex skill refs without changing runtime
manual skill injection:

- `SkillRefDir`, `AvailableSkillRef`, `fsm.skill.dir(path)`, and top-level
  `machine.availableSkills` are available to authors.
- Construction and static verification reject invalid `availableSkills` shape,
  name-form availability refs, dir refs in state-level `skills`, and path refs
  that do not point at `SKILL.md`.
- Static verification resolves available path/dir refs while keeping optional
  state-level missing-skill behavior as warnings.
- Runtime body injection remains unchanged in Slice 0, including the regression
  case for existing non-`SKILL.md` path refs.
- Focused examples, fixtures, and minimal docs were aligned with the new
  `SKILL.md` path-form rule.

Final verification for Slice 0:

- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts packages/core/test/state.machine.snapshot.test.ts`
- `pnpm exec vitest run packages/core/test/loader.inputSchema.test.ts packages/core/test/cli.verifyCli.test.ts packages/core/test/example.publicLoadVerify.test.ts`
- `pnpm run typecheck`

Slice 1 was accepted after no fix cycles. It added loader-side
`SkillOriginManifest` serialization with root source dir, embedded child source
prefixes, and transitive `availableSkills`; preserved the manifest through
direct and installed warm-cache paths; and bumped direct/installed cache
serialization versions. A review finding around non-literal `optional` values
in extracted `availableSkills` was fixed before acceptance so unevaluable refs
are omitted.

Final verification for Slice 1:

- `pnpm exec vitest run packages/core/test/loader.embed-sidecar.test.ts packages/core/test/loader.cache.test.ts packages/core/test/loader.installed.test.ts`
- `pnpm run typecheck`

Acceptance verification re-run during finish:

- `pnpm exec vitest run packages/core/test/loader.embed-sidecar.test.ts packages/core/test/loader.cache.test.ts packages/core/test/loader.installed.test.ts` passed with 3 files / 18 tests.
- `pnpm run typecheck` passed.

Slice 2 was implemented in this working tree and is ready for acceptance
review. It added narrow Codex skill protocol types and methods, bumped the
runtime Codex floor to `0.136.0` with offline drift checks at
`rust-v0.136.0`, added state-origin-aware skill catalog preflight, delegated
state name-form refs from static verify to Codex catalog startup validation,
and wired `skills/extraRoots/set` plus `skills/list` before startup
`thread/start`.

Final verification for Slice 2:

- `pnpm exec vitest run packages/core/test/protocol.methodNames.test.ts packages/core/test/protocol.types.test.ts packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts packages/core/test/cli.verifyCli.test.ts packages/core/test/verifyInstalledCli.test.ts`
- `pnpm exec vitest run packages/core/test/cli.runCli.test.ts packages/core/test/cli.runCli.phase1.test.ts`
- `pnpm run typecheck`
- `pnpm --dir packages/core run verify:codex-bump`

Slice 3 was accepted after no fix cycles. It replaced runtime `SKILL.md` body
reading and nudge `<skill>` block composition with Codex-native structured
`UserInputSkill` items selected from the Slice 2 startup catalog. All
framework-owned orientation `turn/start` paths now build text-first input
arrays, commit skill dedupe only after successful `turn/start`, and reset
dedupe before fresh-clear replacement thread orientation. Browser free-text
owner replies remain text-only.

Final verification for Slice 3:

- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/runtime.nudge.test.ts`
- `pnpm run typecheck`
- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/runtime.nudge.test.ts packages/core/test/runtime.onStateEntry.test.ts packages/core/test/runtime.driveForward.test.ts packages/core/test/runtime.crossStateDance.test.ts packages/core/test/runtime.dispatchSubmit.test.ts packages/core/test/runtime.freshClear.test.ts`
- `pnpm exec vitest run packages/core/test/cli.runCli.test.ts packages/core/test/cli.runCli.phase1.test.ts`
- `pnpm exec vitest run packages/core/test/integration.m14TurnStartInput.test.ts packages/core/test/integration.clearWalk.test.ts packages/core/test/integration.crossStateWalk.test.ts` (skipped by current test gating)

Acceptance verification re-run during finish:

- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/runtime.nudge.test.ts packages/core/test/runtime.driveForward.test.ts packages/core/test/runtime.crossStateDance.test.ts packages/core/test/runtime.freshClear.test.ts` passed with 5 files / 79 tests.
- `pnpm exec vitest run packages/core/test/cli.runCli.test.ts packages/core/test/cli.runCli.phase1.test.ts` passed with 2 files / 55 passed / 1 skipped.
- `pnpm run typecheck` passed.

Slice 4 was implemented in this working tree and is ready for acceptance
review. It updated public authoring/reference/architecture/troubleshooting and
README prerequisite docs for native Codex skill availability and structured
state skill selection, aligned source comments with catalog-based skill
selection, added repository-owned `writing-plans-v2` and `reviewing-code`
support skills under `skills/`, and made
`fsms/recipe-driven-development.fsm.ts` declare `../skills` through
`availableSkills`.

Final verification for Slice 4:

- `pnpm exec prettier --check README.md docs/authoring.md docs/reference.md docs/architecture.md docs/troubleshooting.md fsms/README.md fsms/recipe-driven-development.fsm.ts`
- `pnpm exec prettier --check packages/core/README.md CONTRIBUTING.md SECURITY.md packages/core/src/state/skills.ts packages/core/src/state/exits.ts packages/core/src/state/skillResolver.ts`
- `pnpm exec prettier --check skills/writing-plans-v2/SKILL.md skills/reviewing-code/SKILL.md packages/core/src/verify/verify.ts`
- `pnpm exec aharness verify fsms/recipe-driven-development.fsm.ts` passed with 0 warnings after rerun outside the sandbox; the sandboxed attempt failed because Codex app-server could not start with `Operation not permitted`.
- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts packages/core/test/cli.runCli.test.ts packages/core/test/cli.runCli.phase1.test.ts`
- `pnpm run typecheck`
- `rg -n "0\\.130\\.0|0\\.133\\.0" README.md docs packages/core/README.md CONTRIBUTING.md SECURITY.md`
- `rg -n "skill bod|<skill>|manual skill|filesystem search|runtime inject|reads skill" packages/core/src`
- Direct prompt-to-root mapping check: `agentfiles:writing-plans-v2` maps to
  `skills/writing-plans-v2/SKILL.md`, and `agentfiles:reviewing-code` maps to
  `skills/reviewing-code/SKILL.md`, both under the recipe FSM's declared
  `../skills` root.

Acceptance verification re-run during finish:

- `pnpm exec aharness verify fsms/recipe-driven-development.fsm.ts` passed with
  0 warnings after rerun outside the sandbox; the sandboxed attempt failed
  because Codex app-server could not start with `Operation not permitted`.
- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts packages/core/test/cli.runCli.test.ts packages/core/test/cli.runCli.phase1.test.ts`
  passed with 4 files / 145 passed / 1 skipped.
- `pnpm run typecheck` passed.
- Targeted Prettier checks for touched docs, FSM, source comments, and support
  skill files passed.
- Stale Codex floor and stale manual skill-body searches returned no hits.
- `git diff --check` passed.

Roadmap complete after Slice 4.
