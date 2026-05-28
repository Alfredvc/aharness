# Contributing

Thanks for contributing to Harness. This repository is a TypeScript monorepo for
`@aharness/core`, `@aharness/test-support`, examples, and user-facing docs.

## Setup

Prerequisites:

- Node.js `>=20`
- pnpm `9.15.4`, matching the root `packageManager`
- Codex CLI `>=0.130.0` for runtime work and Codex compatibility checks

Install dependencies:

```bash
pnpm install
```

Build the workspace:

```bash
pnpm run build
```

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

## Publishing

The normal npm release path is `.github/workflows/release.yml`. It runs on
`v*` tags, verifies the tag matches the root/package versions, runs
`pnpm run verify:release`, packs `@aharness/core` and
`@aharness/test-support`, publishes those tarballs to npm with provenance, and
creates a GitHub release from `CHANGELOG.md`.

`@aharness/superpowers` is intentionally not part of the tag-triggered release.
Publish it only through `.github/workflows/release-superpowers.yml`, which is a
manual `workflow_dispatch` action. That workflow verifies the requested
Superpowers version, confirms the matching `@aharness/core` version is already
published, builds and verifies the package, then publishes the Superpowers
tarball with provenance.

Both workflows expect the npm secret `NPM_TOKEN` to be available to GitHub
Actions. The release jobs also request `id-token: write` so npm provenance can
be attached to published packages.

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

Harness should provide executable workflow mechanisms for coding agents without
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
