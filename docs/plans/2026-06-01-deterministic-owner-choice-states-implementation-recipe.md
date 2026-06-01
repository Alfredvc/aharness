# Deterministic Owner Choice States Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-01-deterministic-owner-choice-states-roadmap.md`
**Current slice:** complete
**Current phase:** complete
**Current detailed plan:** `docs/plans/2026-06-02-deterministic-owner-choice-states-slice-4.md`
**Current fix source:** plan review fix cycle 12
**Last completed:** Slice 4 accepted; committing final roadmap completion

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
API retirement and migration. The detailed Slice 4 plan has been created at
`docs/plans/2026-06-02-deterministic-owner-choice-states-slice-4.md` and is
ready for plan review before implementation.

Plan review fix cycle 0 resolved the initial plan blockers by expanding the
Slice 4 plan to include the public `aharness init` scaffold and
`cli.initCli.test.ts`, adding an explicit retired-surface test/fixture/template
cleanup task for full typecheck and full Vitest fallout, adding retired-surface
scan gates, and adding `examples/README.md` plus
`examples/coding-smoke/README.md` to the documentation migration scope.

Plan review fix cycle 1 resolved the remaining scan-driven blockers by adding
`packages/test-support/src/index.ts` plus the retired await/owner-yield
test-support fixtures to the cleanup scope, adding a dedicated source-level
compatibility classification task for scanned `packages/core/src` hits, and
splitting the retired-surface scan into narrower code and docs commands that do
not depend on unrelated `task:` or prose matches.

Plan review fix cycle 2 resolved the latest review blockers by adding `AWAIT__`
and low-level `kind: 'await'` to the retired-surface scan gates, adding
`packages/core/test/state.embed.types.test.ts` to the classified test cleanup
scope, and adding a dedicated browser classification task for retired-surface
hits under `packages/web-ui/src` with web-ui typecheck and targeted component
test verification.

Plan review fix cycle 3 resolved the narrowed web-ui/docs blockers by adding
the remaining scanned browser files (`fixtures/helpers.ts`, `fixtures/script.ts`,
`state/activity.ts`, and `state/legacyFlatEvents.ts`) to the browser
classification task and narrowing the docs retired-surface scan to public docs,
example markdown, and the authoring skill instead of broad `docs/` history.

Plan review fix cycle 4 resolved the exported exit-tool compatibility blocker
by adding `packages/core/src/state.ts` and `packages/core/src/types.ts` to the
source classification task, requiring await-exit helper/type text to be removed
or locally marked as unreachable compatibility, and adding a targeted
`AwaitToolDef`/`await_user_message` source check.

Plan review fix cycle 5 resolved the task-level verification ordering blocker
by removing root `pnpm run typecheck` and `pnpm run build` from pre-cleanup Task
4 and Task 6 gates. Those root-wide gates remain in the final Task 9
post-cleanup verification after test-support fixtures, type tests, and example
FSMs are migrated.

Plan review fix cycle 6 resolved the remaining plan-scope blockers by adding
`fsms/recipe-driven-development.fsm.ts` to the root-typechecked FSM migration
scope and broad retired-surface scan, narrowing Task 4 and Task 6 scan gates to
their owned path subsets, and removing the unsupported `--topic auth-rework`
argument from the composed-pipeline example verification command.

Plan review fix cycle 7 resolved the remaining scan-order blocker by replacing
Task 5's broad code retired-surface scan reference with a web-ui-only scan over
`packages/web-ui/src`, leaving the broad code/docs scans in final Task 9.

Plan review fix cycle 8 resolved the adventure migration test-scope blocker by
adding `packages/core/test/example.adventureArtifact.test.ts` and
`packages/core/test/ui.topology.test.ts` to Task 7 ownership and focused
verification for the migrated adventure choice topology.

Plan review fix cycle 9 resolved loader-diagnostic and scan-gate blockers by
adding loader/verify CLI import-path ownership for actionable retired-surface
diagnostics, adding `packages/core/scripts/browserGoldenServer.mjs` to Task 6
and the retired-surface scans, and defining acceptable `git grep` scan exit
semantics for classified hits and clean empty output.

Plan review fix cycle 10 resolved final verification seam blockers by adding
`packages/core/test/cli.verifyCli.test.ts` to Task 3 ownership and focused
verification, and adding built-CLI verification for
`fsms/recipe-driven-development.fsm.ts` to the migrated FSM verification list.

Plan review fix cycle 11 resolved remaining scope gaps by adding
`packages/core/test/fixtures/embed/parent-with-await.fsm.ts` to Task 6
ownership and adding `CHANGELOG.md` to Task 8 plus the docs retired-surface scan
with historical-release-note classification allowed.

Plan review fix cycle 12 resolved the canonical `ask` diagnostic blocker by
requiring Task 1 runtime construction coverage for `fsm.state({ ask })` and
requiring Task 3 loader/CLI verification diagnostics for both canonical `ask`
and `fsm.await(...)` retired surfaces.

Slice 4 implementation is ready for acceptance review. Implemented scope now
includes canonical `ask`/`fsm.await(...)` API retirement, low-level
`awaitsOwnerText` and `kind: 'await'` rejection at construction and metadata
validation boundaries, loader and `aharness verify` retirement diagnostics,
active submit-tool cleanup, migrated public examples and `aharness init`
template, migrated recipe FSM, migrated public docs and authoring skill
guidance, web-ui compatibility classification for archived owner prompt
metadata, and stale full-suite await fixtures converted or explicitly skipped
as retired coverage.

Slice 4 verification completed on 2026-06-02:

- `pnpm exec vitest run packages/core/test/authorPrimitives.test.ts packages/core/test/state.choice.types.test.ts packages/core/test/state.validateAharnessMeta.test.ts packages/core/test/state.machine.snapshot.test.ts packages/core/test/loader.sidecar.errors.test.ts packages/core/test/cli.verifyCli.test.ts packages/core/test/verify.test.ts packages/core/test/example.publicLoadVerify.test.ts packages/core/test/example.adventureArtifact.test.ts packages/core/test/ui.topology.test.ts` passed: 10 files, 162 tests.
- `pnpm exec vitest run packages/web-ui/src/components/Graph.test.ts packages/web-ui/src/components/ActivePanel.test.ts packages/web-ui/src/state/store.test.ts` passed: 3 files, 143 tests.
- `pnpm exec vitest run packages/core/test/cli.initCli.test.ts packages/core/test/cli.runCli.phase1.test.ts packages/core/test/cli.runCli.test.ts packages/core/test/runtime.dispatchSubmit.test.ts packages/core/test/runtime.awaitResolver.test.ts packages/core/test/runtime.awaitResolverWiring.test.ts packages/core/test/runtime.nudge.test.ts packages/core/test/runtime.onStateEntry.test.ts packages/core/test/runEvents.adapter.test.ts packages/core/test/runEvents.queryService.test.ts packages/core/test/ui.topology.test.ts packages/core/test/ui.browserGolden.test.ts` passed: 12 files, 217 passed, 18 skipped.
- `pnpm exec vitest run packages/core/test/example.publicLoadVerify.test.ts packages/core/test/example.adventureArtifact.test.ts packages/core/test/ui.topology.test.ts` passed: 3 files, 25 tests.
- `pnpm exec vitest run packages/core/test/loader.inputSchema.test.ts packages/core/test/example.requirementSpec.test.ts packages/core/test/state.embed.runToCompletion.test.ts packages/core/test/integration.awaitExitWalk.test.ts packages/test-support/test/smoke.test.ts packages/test-support/test/startApp.test.ts packages/test-support/test/startHeadlessApp.test.ts packages/test-support/test/mockModel.test.ts packages/test-support/test/pty.test.ts packages/test-support/test/encodeFunctionCallTurn.test.ts packages/test-support/test/fixtures/requirementSpecWalk.test.ts` passed: 9 files passed, 2 skipped; 42 tests passed, 2 skipped.
- `pnpm run typecheck` passed.
- `pnpm --dir packages/web-ui run typecheck` passed.
- `pnpm run format:check` passed.
- `pnpm run build` passed. Vite reported the existing large chunk warning but exited successfully.
- Docs retired-surface scan passed with empty output: `git grep -n -E "fsm\\.await|await exits|awaitsOwnerText|kind:[[:space:]]*['\"]await['\"]|(^|[^[:alnum:]_])ask[[:space:]]*:" -- README.md CHANGELOG.md docs/authoring.md docs/reference.md docs/architecture.md docs/troubleshooting.md examples/*.md examples/*/README.md skills/aharness-fsm-authoring`.
- Code retired-surface scan produced classified compatibility/rejection output only: retained `AWAIT__` generated-prefix detection and archived runtime/UI reconstruction support; retained negative retirement tests and skipped retired await/owner-yield integration tests; retained historical browser golden/replay fixtures for archived await metadata.
- `pnpm run verify` passed, including format check, lint, workflow-term and stale-contract checks, root typecheck, web-ui typecheck, codex bump check, build, and full Vitest: 151 files passed, 8 skipped; 1685 tests passed, 37 skipped.

Planned built-CLI example verification commands using
`node packages/core/dist/cli/main.js verify <example>` and
`pnpm exec aharness verify <example>` did not run to FSM verification in this
workspace checkout because loader bundling resolves `@aharness/core` examples
to `packages/core/src/index.ts`, whose `.js` relative imports are not available
under direct Node execution of source. The migrated examples were instead
verified through `packages/core/test/example.publicLoadVerify.test.ts`,
`packages/core/test/example.adventureArtifact.test.ts`,
`packages/core/test/ui.topology.test.ts`, `pnpm run build`, and the final
`pnpm run verify` gate.

Slice 4 was accepted. The deterministic owner choice states roadmap is complete:
all planned slices, from core authoring through runtime, browser events,
topology, and legacy owner-decision API retirement, have been implemented,
verified, accepted, and are being committed in the current checkout.
