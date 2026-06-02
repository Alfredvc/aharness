# Native Codex Skills for Self-Contained FSM Packages Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-02-native-codex-skills-for-fsm-packages-roadmap.md`
**Current slice:** Slice 3 - native structured state skill injection
**Current phase:** plan
**Current detailed plan:** none yet
**Current fix source:** none
**Last completed:** Slice 2 - Codex protocol and startup skill catalog

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

Next action: write the detailed Slice 3 plan for native structured state skill
injection before changing runtime turn payload code.
