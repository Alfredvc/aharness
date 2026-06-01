# Deterministic Owner Choice States Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-01-deterministic-owner-choice-states-roadmap.md`
**Current slice:** Slice 1 - runtime choice parking and reply dispatch
**Current phase:** needs detailed plan
**Current detailed plan:** `docs/plans/2026-06-01-deterministic-owner-choice-states-slice-1.md`
**Current fix source:** none
**Last completed:** Slice 0 accepted and committed

## Durable Grounding

- `docs/ideas/2026-06-01-deterministic-owner-choice-states.md`
- `docs/specs/2026-06-01-deterministic-owner-choice-states-design.md`
- `docs/plans/2026-06-01-deterministic-owner-choice-states-roadmap.md`

## Iteration Workflow

1. Write the detailed plan for Slice 0 only.
2. Review the detailed plan and resolve any blockers before implementation.
3. Execute only Slice 0.
4. Review the completed Slice 0 diff.
5. Run Slice 0 verification and record results before advancing.
6. Update this recipe to the next slice after verification and commit.

## Orchestrator Rules

- Keep each iteration scoped to one roadmap slice.
- Preserve existing ask and await behavior until the migration slice.
- Do not enable runtime, browser, topology, docs, examples, or legacy-removal behavior before the owning slice.
- Update roadmap/spec corrections in the same workflow if implementation proves an upstream artifact wrong.
- Do not silently defer real review findings.
- Advance `Current slice` only after verification passes and the slice is committed.

## Current State

Slice 0 implementation was accepted and committed. The next slice is Slice 1:
runtime choice parking and reply dispatch. A detailed Slice 1 plan should be
created before implementation:
`docs/plans/2026-06-01-deterministic-owner-choice-states-slice-1.md`.

Implemented scope includes `ChoiceMeta`, `createFsm().choice(...)`, choice
metadata validation, `OWNER_CHOICE__<stateId>` synthesis, generated-prefix
reservation, verifier-safe metadata diagnostics, choice target and authored
behavior checks, direct-`createMachine` loader detection for `choice(...)`, and
focused runtime/type tests. Runtime parking, browser replies, run events,
topology, public docs/example migration, and legacy ask/await removal remain
out of scope for Slice 0 and are owned by later slices.

Verification completed on 2026-06-02:

- `pnpm exec vitest run packages/core/test/authorPrimitives.test.ts packages/core/test/state.validateAharnessMeta.test.ts packages/core/test/state.machine.snapshot.test.ts packages/core/test/verify.test.ts packages/core/test/loader.sidecar.errors.test.ts packages/core/test/state.choice.types.test.ts` passed: 6 files, 113 tests.
- `pnpm run typecheck` passed.
- `pnpm run verify` passed, including format check, lint, stale contract checks,
  root typecheck, web-ui typecheck, codex bump check, build, and full Vitest:
  151 files passed, 7 skipped; 1669 tests passed, 19 skipped.

Acceptance fix cycle 0 resolved the two Slice 0 review blockers:

- `fsm.withEvents({ OWNER_CHOICE__... })` is now rejected under normal inferred
  usage, covered by `packages/core/test/state.choice.types.test.ts`.
- Low-level choice option metadata now rejects keys other than exact `label` and
  `to`, covered by `packages/core/test/state.validateAharnessMeta.test.ts`.

Post-fix verification completed on 2026-06-02:

- `pnpm run typecheck` passed.
- `pnpm exec vitest run packages/core/test/state.choice.types.test.ts packages/core/test/state.validateAharnessMeta.test.ts packages/core/test/authorPrimitives.test.ts packages/core/test/verify.test.ts packages/core/test/loader.sidecar.errors.test.ts packages/core/test/state.machine.snapshot.test.ts` passed: 6 files, 113 tests.
- `pnpm run verify` passed, including format check, lint, stale contract checks,
  root typecheck, web-ui typecheck, codex bump check, build, and full Vitest:
  151 files passed, 7 skipped; 1669 tests passed, 19 skipped.
