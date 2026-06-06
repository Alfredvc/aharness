# CLAUDE.md — aharness

Operational context for coding-agent sessions in this repo. This file is a
short map and guardrail list, not a framework spec. When behavior details matter,
defer to the source code and the docs below.

## What this repo is

aharness is a TypeScript/XState framework for making Codex coding workflows
executable as finite state machines. Codex performs the language, code, and tool
work; aharness owns the workflow around it: states, typed submissions, approval
routing, hooks, run artifacts, and verification.

The repo is a pnpm + Node `>=20` TypeScript monorepo:

- `packages/core` — `@aharness/core` SDK and `aharness` CLI.
- `packages/web-ui` — private React/Vite browser UI. Its production build is
  generated into ignored `packages/web-ui/dist/` and copied into
  `packages/core/dist/ui/static/` during the core build.
- `packages/test-support` — deterministic fixtures and integration-test helpers.
- `examples` — runnable examples and workflow references.
- `docs` — public guides, reference material, architecture notes, and archival
  plans/specs.

## Canonical docs

Use current docs as the source of truth. Do not rely on stale memory or archived
plans unless the task explicitly asks for historical context.

- `README.md` — project overview, install path, examples, package map.
- `CONTRIBUTING.md` — contribution expectations and documentation maintenance.
- `docs/authoring.md` — how to design and write aharness FSMs.
- `docs/reference.md` — public SDK and CLI reference.
- `docs/architecture.md` — runtime shape, browser UI, run artifacts, package
  boundaries.
- `docs/run-event-visibility.md` — ground truth for browser event/transcript
  visibility policy.
- `docs/troubleshooting.md` — common runtime and install failures.
- `packages/core/SUPPORTED_CODEX.md` — Codex CLI compatibility gate.

## Local skills

- Installed skills cannot rely on this repository's docs being present. Any
  repo-owned skill that teaches aharness behavior must be self-contained through
  its `SKILL.md` and bundled `references/` files.
- When public aharness docs change behavior, public API, commands, package
  facts, runtime semantics, or user-facing workflows, update affected
  repo-owned skills in the same workflow. Do not leave installed-skill guidance
  depending on external repo docs or stale copied facts.

## Hard boundaries

- Mechanisms belong in the framework; workflow opinions belong in user FSMs,
  examples, or docs. If behavior could plausibly vary between teams or workflows,
  do not bake that policy into `@aharness/core`.
- Verification gates execution. Invalid machines must fail before Codex starts.
- Codex produces work and structured data; aharness decides state transitions.
  Transitions must come through the active state's typed exits and framework
  validation, not through model convention.
- A live run owns one Codex `app-server` and one aharness WebSocket client. Do
  not assume mirror sessions or alternate clients are part of the runtime.
- Run logs are sensitive. `.aharness/runs/**/events.jsonl` is canonical runtime
  evidence and can contain raw owner input, browser replies, tool arguments and
  results, command output, file diffs, approval data, token usage, and sub-thread
  activity. `events.jsonl` can also contain public workflow context snapshots
  recorded as `context.initialized` and `context.changed` events. Treat run
  directories as sensitive even when the browser transcript does not display
  those context values by default.
- Recorded-run UI inspection is the public foreground
  `aharness view [run-id]` command. It selects the newest recorded run when no
  run id is provided, accepts a run id only, projects recorded canonical JSONL
  through the same run-scoped browser APIs as live runs, and does not start
  Codex, an app-server, or a live thread. View mode is read-only; crafted
  replies are rejected. Topology recovery imports the recorded FSM source on a
  best-effort basis using recorded `repoRoot`/`fsmFile` metadata when present,
  warns and continues with empty topology on failure, and has the same
  import-time trust boundary as `verify` and `run`.
- `docs/run-event-visibility.md` is the ground truth for event/transcript
  visibility decisions. Any event/transcript visibility policy change must
  update that document in the same workflow, and policy-content changes to that
  document require explicit user acceptance before implementation or commit.

## Files to avoid editing

Avoid hand-editing generated or local runtime artifacts unless the task is
explicitly about those files:

- `.aharness/`
- `dist/`
- `*.tsbuildinfo`
- `node_modules/`
- `.pnpm-store/`
- coverage and `.vitest/`
- vendored checkouts and generated vendored assets

## Files to never commit

Never stage or commit files under these local planning and follow-up areas:

- `docs/plans/`
- `docs/specs/`
- `docs/ideas/`
- `docs/strategies/`
- `docs/followups/`

## Working rules

- Keep changes scoped to the requested behavior.
- Update relevant docs in the same change when behavior, public API, commands,
  package facts, or user-facing workflows change.
- Never add FSM tests. When changing FSM behavior, verify with `aharness verify`
  and direct inspection instead of adding or extending FSM test files.
- When running visual Playwright tests that start `aharness run`, pass
  `--no-open` so aharness serves and prints the UI URL without launching a
  separate system browser window.
- Treat `examples/workflow-references/` as workflow-opinion material that users
  may encode in FSMs, not as framework policy.
- On or after 2026-06-12, revisit the temporary `react-doctor@0.2.14` pin and
  try bumping the repo back to `react-doctor@0.4.0` under the global 7-day pnpm
  release-age policy.
- For runtime architecture questions, inspect `packages/core/src/runtime`,
  `packages/core/src/transport`, `packages/core/src/protocol`,
  `packages/core/src/runEvents`, and `docs/architecture.md` before changing code.
