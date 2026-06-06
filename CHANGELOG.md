# Changelog

All notable user-facing changes for aharness are recorded here.
`commit-and-tag-version` updates this file from Conventional Commits during
release prep. The GitHub release workflow extracts the matching version section
as the release body.

## 0.1.0 - Initial OSS release

- Introduces `@aharness/core`, the SDK plus local `aharness` CLI for authoring,
  verifying, and running finite-state-machine workflows around Codex coding
  tasks.
- Adds the public FSM authoring surface, including typed states, submit exits,
  owner-reply transitions, guards, inputs, embedded machines, final states, and
  verification before runtime.
- Ships the loopback browser UI used for owner approvals, owner input, run
  inspection, and per-run evidence.
- Provides `@aharness/test-support` as a regular dependency consumer of
  `@aharness/core` for app-server lifecycle, replay, and race-condition test
  fixtures.
- Documents the initial OSS install path, examples, package authoring flow, and
  release verification commands.
