# FSM Run Final Overview And Share Card Implementation Recipe

**Parent roadmap:** `docs/plans/2026-06-02-fsm-run-final-overview-share-card-roadmap.md`
**Current slice:** Slice 6 - docs audit and full acceptance
**Current phase:** complete
**Current detailed plan:** `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-6-docs-audit-full-acceptance.md`
**Current fix source:** none
**Last completed:** Slice 6 - docs audit and full acceptance

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

Slice 3 was implemented and accepted. It added web-side completion-summary
types and validators, accepted bootstrap `completionStats`, added authenticated
`fetchSummary(...)`, registered exact SSE listeners for canonical git fact
events, and kept UI store, modal, share-card, and core route behavior reserved
for later slices. A focused code-review pass found two real validation gaps;
both were fixed before acceptance.

- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-3-web-client-completion-contract.md`

Final Slice 3 verification passed:

- `pnpm exec vitest run packages/web-ui/src/api/client.test.ts`
- `pnpm --dir packages/web-ui run typecheck`
- `git diff --check`

Slice 4 was implemented and accepted. It added terminal-only final overview
state, summary fetching on terminal bootstrap/live completion, modal rendering
with loading, loaded, partial, failure, unavailable-work-delta, and low-disclosure
states, terminal header `Summary` reopening, close/Escape/backdrop dismissal,
focused reducer/hook/App/component tests, and public reference documentation for
overview behavior and recorded-git-fact work-delta availability. Share-card
preview and PNG export behavior remain reserved for Slice 5.

- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-4-final-overview-modal.md`

Final Slice 4 verification passed:

- `pnpm exec vitest run packages/web-ui/src/state/store.test.ts packages/web-ui/src/state/store.hook.test.ts packages/web-ui/src/App.test.ts packages/web-ui/src/App.dom.test.ts packages/web-ui/src/components/FinalOverviewModal.test.ts`
- `pnpm --dir packages/web-ui run typecheck`
- `git diff --check`
- `rg -n "Download PNG|Copy PNG|Clipboard|toBlob|share-card|share card|RunCompletionShare" packages/web-ui/src/App.tsx packages/web-ui/src/components/FinalOverviewModal.tsx packages/web-ui/src/state/store.ts docs/reference.md`

Slice 5 detailed plan was updated after plan review. The update fixes the
`.test.tsx` discovery issue by planning `RunCompletionShareCard.test.ts`, adds
an explicit success/failure fixture route for manual Playwright validation,
requires the exported SVG card to be self-contained for SVG-to-canvas PNG
export, and marks the new fixture-store test file as created rather than
modified.

- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-5-share-card-preview-png-export.md`

Slice 5 was implemented and verified. It added low-disclosure share-card props,
a fixed `1320 x 2868` self-contained SVG card, browser-native PNG download and
clipboard copy helpers, final-overview Share preview controls gated to success
and failure outcomes, success/failure validation fixture routes, focused tests,
and public reference/troubleshooting documentation.

Final Slice 5 verification passed:

- `pnpm exec vitest run packages/web-ui/src/components/RunCompletionShareCard.test.ts packages/web-ui/src/components/shareCardExport.test.ts packages/web-ui/src/components/FinalOverviewModal.test.ts packages/web-ui/src/App.test.ts packages/web-ui/src/App.dom.test.ts packages/web-ui/src/state/fixtureStore.test.ts`
- `pnpm --dir packages/web-ui run typecheck`
- `git diff --check`
- Manual `playwright-cli` validation against `/demo.html?fsm=auto&share=success`
  and `/demo.html?fsm=auto&share=failure`; both routes exposed Share, rendered
  nonblank fixed-size SVG previews, and generated browser PNG blobs that decoded
  to `1320 x 2868`.

Slice 6 detailed plan was reviewed and updated after plan review. The update
requires manual share-card acceptance to use the Vite dev server command
`pnpm --dir packages/web-ui run dev --host 127.0.0.1 --port <available-port>`,
confirms both `/demo.html?fsm=auto&share=success` and
`/demo.html?fsm=auto&share=failure` return HTTP 200 before browser assertions,
and removes preview-server ambiguity for the source-root demo fixture.

- `docs/plans/2026-06-02-fsm-run-final-overview-share-card-slice-6-docs-audit-full-acceptance.md`

Slice 6 was executed and is ready for acceptance review. It audited public docs,
added the missing reference contract for authenticated
`GET /api/runs/:runId/summary`, fixed repo-level Vitest discovery so the
Node-only replay spike test is not collected by Vitest, reran focused and broad
verification, and reconfirmed success/failure share-card browser acceptance.

Final Slice 6 verification passed:

- Documentation/source audit searches for summary, completion stats, final
  overview, share-card export, clipboard behavior, canonical git fact events,
  `events.jsonl`, legacy route references, and stale unavailable/raw-field
  wording. Remaining matches were current feature docs/source or explicit
  legacy-route statements that are still accurate.
- `pnpm exec vitest run packages/core/test/runEvents.gitFacts.test.ts packages/core/test/runEvents.completionStats.test.ts packages/core/test/runEvents.queryService.test.ts packages/core/test/ui.runScopedServer.test.ts packages/core/test/ui.sse.test.ts packages/web-ui/src/api/client.test.ts packages/web-ui/src/state/store.test.ts packages/web-ui/src/state/store.hook.test.ts packages/web-ui/src/App.test.ts packages/web-ui/src/App.dom.test.ts packages/web-ui/src/components/FinalOverviewModal.test.ts packages/web-ui/src/components/RunCompletionShareCard.test.ts packages/web-ui/src/components/shareCardExport.test.ts packages/web-ui/src/state/fixtureStore.test.ts`
  passed: 14 files, 203 tests.
- `pnpm run typecheck` passed.
- `pnpm --dir packages/web-ui run typecheck` passed.
- `node --test scripts/spikes/replay-run-prefix-ui.test.mjs` passed with
  escalated localhost-bind permissions after sandboxed execution returned
  `listen EPERM` for `127.0.0.1`.
- `pnpm run verify` passed after the Vitest discovery fix: 159 files passed,
  8 skipped; 1765 tests passed, 37 skipped. The build retained the existing
  Vite chunk-size warning.
- `git diff --check` passed.

Manual browser acceptance passed against
`pnpm --dir packages/web-ui run dev --host 127.0.0.1 --port 5173`:

- `curl` confirmed HTTP 200 for
  `/demo.html?fsm=auto&share=success` and
  `/demo.html?fsm=auto&share=failure`.
- Success route: Share exposed the preview, the share SVG was fixed at
  `1320 x 2868`, generated a nonblank `image/png` blob decoded by the browser
  to exactly `1320 x 2868`, Copy PNG completed in this browser, and the preview
  stayed open with Download PNG still available.
- Failure route: Share exposed the preview, the share SVG was fixed at
  `1320 x 2868`, generated a nonblank `image/png` blob decoded by the browser
  to exactly `1320 x 2868`, Copy PNG completed in this browser, and the preview
  stayed open with Download PNG still available.
- Modal and share-card text checks did not find the inspected raw paths, run
  ids, git object ids, Codex strings, owner input, or command output values in
  the modal/card surfaces. The page header still shows existing run metadata
  outside the modal/share-card contract.

Next step: roadmap complete. This is the terminal roadmap slice; do not advance
to another implementation slice.
