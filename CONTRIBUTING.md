# Contributing

Thanks for contributing to aharness. This repository is a TypeScript monorepo for
`@aharness/core`, `@aharness/test-support`, examples, and user-facing docs.

## Setup

Prerequisites:

- Node.js `>=20`
- pnpm `9.15.4`, matching the root `packageManager`
- Codex CLI `>=0.136.0` for runtime work and Codex compatibility checks

Install dependencies:

```bash
pnpm install
```

Build the workspace:

```bash
pnpm run build
```

The browser UI is built by `packages/web-ui` into ignored
`packages/web-ui/dist/`. The core build copies that output into
`packages/core/dist/ui/static/` for packaging and local serving. Do not commit
generated browser UI bundles; change `packages/web-ui/src` and rebuild instead.

## Verification

Use the smallest relevant check while developing, then run the broader checks
before handing work off.

```bash
pnpm run typecheck
pnpm --dir packages/core run verify:codex-bump
pnpm run verify
pnpm run verify:release
```

Notes:

- `pnpm run verify` runs format checking, linting, repository-specific stale-doc
  checks, type checks, the Codex compatibility gate, build, and tests.
- `pnpm run verify:release` validates release manifest fields. Run it when
  preparing release-ready package metadata.
- Package-local changes may need package-local scripts in addition to the root
  checks.

## Pre-commit Hook

The Husky pre-commit hook runs `lint-staged` and the repository-specific
workflow-term check. `lint-staged` formats staged files and runs oxlint against
staged JavaScript and TypeScript files. The oxlint command uses
`--no-error-on-unmatched-pattern` so staged files intentionally ignored by the
root oxlint config do not fail the commit with a no-files-found error.

## Codex Edit Hooks

The repo-local Codex config includes check-only `PostToolUse` hooks for file
edits. After Codex applies a patch through the edit/write tool path, the hooks
run `pnpm exec oxlint --max-warnings 0` against touched JavaScript and
TypeScript files, and `react-doctor --verbose --diff --blocking warning
--no-score` against the current diff. Both hooks report failures back to Codex
without modifying files.

Codex requires changed repo-local command hooks to be reviewed before they run.
When Codex reports that hooks need review, open `/hooks` in the CLI and trust the
current hook definition for this repository.

## Recorded Run UI Inspection

For UI visualization work against an existing run log, use the public recorded
run viewer:

```bash
aharness view <run-id>
```

Omit the run id to open the newest `.aharness/runs/<runId>/events.jsonl` by run
directory mtime, with directory name as the lexical tie-break. The optional
argument is a run id only, not a path. Open the printed URL in a browser to
inspect the recorded transcript, history, stats, graph, and final overview when
the log contains that data.

`aharness view` serves until you stop it. It projects recorded canonical JSONL
through the same run-scoped browser APIs used by live runs, but it is read-only:
it does not launch Codex, start an app-server or live thread, or accept replies.
Topology recovery is best-effort and imports the FSM source recorded in
`run.started` metadata when available; import failures warn and continue with an
empty topology. Treat that import with the same trust boundary as `verify` and
`run`.

Run directories remain sensitive. `.aharness/runs/<runId>/events.jsonl` can
contain raw owner input, browser replies, tool arguments and results, command
output, file diffs, approval data, token usage, sub-thread activity, and public
workflow context snapshots.

## Publishing

The normal npm release path is `.github/workflows/release.yml`. It runs on
`v*` tags, verifies the tag matches the root/package versions, runs
`pnpm run verify:release`, packs `@aharness/core` and
`@aharness/test-support`, publishes those tarballs to npm with provenance, and
creates a GitHub release from `CHANGELOG.md`.

The workflow expects the npm secret `NPM_TOKEN` to be available to GitHub
Actions. The release jobs request `id-token: write` so npm provenance can be
attached to published packages.

## Documentation Maintenance

Documentation is part of the change, not a follow-up task. When behavior,
commands, package facts, or public positioning changes, update the relevant docs
in the same contribution.

Keep public docs small and navigable:

- root overview and launch path live in `README.md`;
- user-facing guides live under lowercase `docs/` files;
- package-specific details live in each package README;
- internal specs and plans remain archival context unless a task explicitly
  asks to update them.

Do not leave placeholders in public docs. If a release detail, support policy,
or command is unknown, resolve it before finalizing the change.

## Mechanisms vs. Opinions

aharness should provide executable workflow mechanisms for coding agents without
hard-coding one team's process opinions into the core runtime.

Prefer core changes that make process control explicit and reusable:

- typed state transitions and validated submissions;
- verifier checks that prevent invalid runs;
- owner approval and owner input boundaries;
- clear run artifacts and inspection paths;
- package authoring conventions that keep reusable FSMs discoverable.

Avoid baking a specific planning style, review ritual, prompt wording, or team
policy into the core unless it belongs in an example, FSM package, or
documentation layer. Examples may be opinionated; the core should expose the
mechanism.

## Pull Request Expectations

- Keep changes scoped to the requested behavior or documentation.
- Add or update tests when behavior changes.
- Update docs when public commands, APIs, examples, or package facts change.
- Run the relevant verification commands and include the results in the handoff.
- Do not add release automation, changesets, or publishing workflow changes
  unless the task explicitly asks for them.
