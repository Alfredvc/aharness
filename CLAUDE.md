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
- `packages/web-ui` — private React/Vite browser UI.
- `packages/test-support` — deterministic fixtures and integration-test helpers.
- `packages/superpowers` — installable FSM package.
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
- `docs/troubleshooting.md` — common runtime and install failures.
- `packages/core/SUPPORTED_CODEX.md` — Codex CLI compatibility gate.

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
  activity.
- Dev-only UI replay for visualization work lives in
  `scripts/spikes/replay-run-prefix-ui.mjs`. It accepts a run directory or
  `events.jsonl` plus an event count, starts a local UI server, replays the first
  N events immediately through run-scoped SSE, and does not launch Codex. See
  `CONTRIBUTING.md` before using or changing it.

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
- `packages/core/src/ui/static/index.html` unless intentionally updating the
  embedded UI artifact through the web UI build flow

## Working rules

- Keep changes scoped to the requested behavior.
- Update relevant docs in the same change when behavior, public API, commands,
  package facts, or user-facing workflows change.
- Never add FSM tests. When changing FSM behavior, verify with `aharness verify`
  and direct inspection instead of adding or extending FSM test files.
- Treat `examples/workflow-references/` as workflow-opinion material that users
  may encode in FSMs, not as framework policy.
- For runtime architecture questions, inspect `packages/core/src/runtime`,
  `packages/core/src/transport`, `packages/core/src/protocol`,
  `packages/core/src/runEvents`, and `docs/architecture.md` before changing code.
