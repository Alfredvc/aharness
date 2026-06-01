# Deterministic Owner Choice States Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-01-deterministic-owner-choice-states-roadmap.md`
**Current slice:** Slice 4 - legacy owner-decision API retirement and migration
**Current phase:** needs detailed plan
**Current detailed plan:** none
**Current fix source:** none
**Last completed:** Slice 3 accepted and committed in this commit

## Durable Grounding

- `docs/ideas/2026-06-01-deterministic-owner-choice-states.md`
- `docs/specs/2026-06-01-deterministic-owner-choice-states-design.md`
- `docs/plans/2026-06-01-deterministic-owner-choice-states-roadmap.md`

## Iteration Workflow

1. Write the detailed plan for the current slice only.
2. Review the detailed plan and resolve any blockers before implementation.
3. Execute only the current slice.
4. Review the completed current-slice diff.
5. Run current-slice verification and record results before advancing.
6. Update this recipe to the next slice after verification and commit.

## Orchestrator Rules

- Keep each iteration scoped to one roadmap slice.
- Preserve existing ask and await behavior until the migration slice.
- Do not enable runtime, browser, topology, docs, examples, or legacy-removal behavior before the owning slice.
- Update roadmap/spec corrections in the same workflow if implementation proves an upstream artifact wrong.
- Do not silently defer real review findings.
- Advance `Current slice` only after verification passes and the slice is committed.

## Current State

Slice 1 implementation was accepted and is being committed. The current slice
is now Slice 2: durable owner-choice run events and browser interaction. The
detailed Slice 2 plan has been created at
`docs/plans/2026-06-02-deterministic-owner-choice-states-slice-2.md` and is
ready for plan review before implementation. Plan review fix cycle 0 updated
the plan to require deterministic owner-choice request-id propagation, a
central choice-pending publisher across all choice-entry paths, run-scoped
server route coverage, and default transcript visibility for failed
owner-choice replies. Plan review fix cycle 1 aligned the owner-choice pending
card contract with the approved spec's `options: [{ label }]` shape and made
`packages/web-ui/src/components/ActivePanel.tsx` an explicit browser
integration point for rendering `pending.ownerChoice`.

Implemented scope includes `ChoiceMeta`, `createFsm().choice(...)`, choice
metadata validation, `OWNER_CHOICE__<stateId>` synthesis, generated-prefix
reservation, verifier-safe metadata diagnostics, choice target and authored
behavior checks, direct-`createMachine` loader detection for `choice(...)`,
runtime active-choice data resolution, generated owner-choice dry-run and
commit helpers, browser `owner-choice` reply parsing and lifecycle data, choice
parking during kickoff and drive-forward, serialized owner-choice reply
dispatch, `StateChange.cause: 'choice'`, submit-to-choice parking, passive
settlement into choice/stateful/terminal leaves, runtime transition
state-change publishing for hook/permission paths, and web-ui contract widening
for `currentState.kind: 'choice'`. Durable owner-choice run events, browser
interaction rendering, topology, public docs/example migration, and legacy
ask/await removal remain out of scope for Slices 0-1 and are owned by later
slices.

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

Slice 1 implementation is ready for acceptance review. Implemented scope now
includes runtime active-choice data resolution, generated owner-choice dry-run
and commit helpers, browser `owner-choice` reply parsing and lifecycle data,
choice parking during kickoff and drive-forward, serialized owner-choice reply
dispatch, `StateChange.cause: 'choice'`, submit-to-choice parking, passive
settlement into choice, runtime transition state-change publishing for
hook/permission paths, and web-ui contract widening for `currentState.kind:
'choice'`.

Slice 1 verification completed on 2026-06-02:

- `pnpm exec vitest run packages/core/test/ui.reply.test.ts packages/core/test/runtime.driveForward.test.ts packages/core/test/runtime.dispatchSubmit.test.ts packages/core/test/cli.runCli.test.ts packages/core/test/runtime.actorHost.test.ts packages/core/test/runtime.dispatchChoice.test.ts packages/core/test/runtime.dispatchEvent.test.ts packages/core/test/runtime.hookDispatchers.test.ts packages/core/test/runtime.permissionRequest.test.ts packages/core/test/runtime.awaitResolver.test.ts` passed: 10 files, 189 tests.
- `pnpm exec vitest run packages/web-ui/src/api/client.test.ts packages/web-ui/src/state/store.test.ts` passed: 2 files, 80 tests.
- `pnpm run typecheck` passed.
- `pnpm --dir packages/web-ui run typecheck` passed.
- `pnpm run verify` passed, including format check, lint, stale contract
  checks, root typecheck, web-ui typecheck, codex bump check, build, and full
  Vitest: 152 files passed, 7 skipped; 1680 tests passed, 19 skipped.

Slice 1 fix cycle 0 resolved the acceptance blockers:

- Owner-choice reply dispatch now waits through passive settlement before
  publishing and classifying the `choice` state change.
- Submit passive settlement now accepts stateful leaves, runs state entry, and
  schedules the normal cross-state continuation instead of returning an
  internal error after mutation.
- Submit transitions that land on choice now resolve active choice data so
  dynamic question failures fail the run instead of silently parking.

Fix verification completed on 2026-06-02:

- `pnpm exec vitest run packages/core/test/runtime.dispatchSubmit.test.ts packages/core/test/runtime.dispatchChoice.test.ts packages/core/test/cli.runCli.test.ts` passed: 3 files, 81 tests.
- `pnpm exec vitest run packages/core/test/ui.reply.test.ts packages/core/test/runtime.driveForward.test.ts packages/core/test/runtime.dispatchSubmit.test.ts packages/core/test/cli.runCli.test.ts packages/core/test/runtime.actorHost.test.ts packages/core/test/runtime.dispatchChoice.test.ts packages/core/test/runtime.dispatchEvent.test.ts packages/core/test/runtime.hookDispatchers.test.ts packages/core/test/runtime.permissionRequest.test.ts packages/core/test/runtime.awaitResolver.test.ts` passed: 10 files, 190 tests.
- `pnpm run typecheck` passed.
- `pnpm --dir packages/web-ui run typecheck` passed.
- `pnpm run verify` passed, including format check, lint, stale contract
  checks, root typecheck, web-ui typecheck, codex bump check, build, and full
  Vitest: 152 files passed, 7 skipped; 1681 tests passed, 19 skipped.

Slice 2 implementation is ready for acceptance review. Implemented scope now
includes deterministic owner-choice request ids, canonical owner-choice pending
cards and reply lifecycle rows, JSONL/bootstrap/reconnect reconstruction,
browser `pending.ownerChoice` store state, owner-choice reply payload posting,
default visibility for failed owner-choice reply rows, and a distinct React
interaction slot for framework-owned choices while preserving Codex
owner-input choices and `isOther` custom text.

Slice 2 verification completed on 2026-06-02:

- `pnpm exec vitest run packages/core/test/runEvents.adapter.test.ts packages/core/test/runEvents.index.test.ts packages/core/test/runEvents.queryService.test.ts packages/core/test/ui.runScopedServer.test.ts packages/core/test/ui.reply.test.ts` passed: 5 files, 111 tests.
- `pnpm exec vitest run packages/web-ui/src/api/client.test.ts packages/web-ui/src/state/store.test.ts packages/web-ui/src/components/InteractionSlot.test.tsx packages/web-ui/src/components/ActivePanel.test.ts` passed: 3 files, 111 tests.
- `pnpm run typecheck` passed.
- `pnpm --dir packages/web-ui run typecheck` passed.
- `pnpm exec vitest run packages/core/test/cli.runCli.test.ts packages/core/test/runtime.actorHost.test.ts packages/core/test/runtime.dispatchChoice.test.ts packages/core/test/runtime.dispatchSubmit.test.ts packages/core/test/runtime.dispatchEvent.test.ts packages/core/test/runtime.hookDispatchers.test.ts packages/core/test/runtime.permissionRequest.test.ts packages/core/test/runtime.awaitResolver.test.ts` passed: 8 files, 155 tests.
- `pnpm run verify` passed, including format check, lint, workflow-term and
  stale-contract checks, root typecheck, web-ui typecheck, codex bump check,
  build, and full Vitest: 152 files passed, 7 skipped; 1687 tests passed, 19
  skipped.

Slice 2 was accepted. The current slice is now Slice 3: choice topology
visualization. The detailed Slice 3 plan has been created at
`docs/plans/2026-06-02-deterministic-owner-choice-states-slice-3.md` and is
ready for plan review before implementation.

Slice 3 implementation is ready for acceptance review. Implemented scope now
includes semantic topology `choice` node and edge kinds, choice node details
with authored questions and option labels, browser topology type mirrors,
choice-aware graph fixture/layout handling, distinct choice node and edge graph
styling, visible option labels for single primary choice edges, choice self-loop
classification that retains both self-loop and choice styling, choice question
and option rows in ActivePanel inspect mode, and a narrow architecture note
update for choice topology semantics.

Slice 3 verification completed on 2026-06-02:

- `pnpm exec vitest run packages/core/test/ui.topology.test.ts` passed: 1 file,
  5 tests.
- `pnpm exec vitest run packages/web-ui/src/components/graphLayoutModel.test.ts packages/web-ui/src/components/Graph.test.ts packages/web-ui/src/components/ActivePanel.test.ts` passed:
  3 files, 114 tests.
- `pnpm run typecheck` passed.
- `pnpm --dir packages/web-ui run typecheck` passed.
- `pnpm run verify` passed, including format check, lint, workflow-term and
  stale-contract checks, root typecheck, web-ui typecheck, codex bump check,
  build, and full Vitest: 152 files passed, 7 skipped; 1694 tests passed, 19
  skipped.

Slice 3 was accepted. The current slice is now Slice 4: legacy owner-decision
API retirement and migration. A detailed Slice 4 plan should be created before
implementation.
