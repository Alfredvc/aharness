# Changelog

All notable user-facing changes for Harness are recorded here.

Harness does not use changesets or generated release notes yet. Until release
automation exists, this file is the source of truth for v0.1 release notes.

## 0.1.0 - Initial OSS release

- Introduces `@aharness/core`, the SDK plus local `aharness` CLI for authoring,
  verifying, and running finite-state-machine workflows around Codex coding
  tasks.
- Adds the public FSM authoring surface, including typed states, submit exits,
  await exits, guards, inputs, embedded machines, final states, and verification
  before runtime.
- Ships the loopback browser UI used for owner approvals, owner input, run
  inspection, and per-run evidence.
- Provides `@aharness/test-support` as a regular dependency consumer of
  `@aharness/core` for app-server lifecycle, replay, and race-condition test
  fixtures.
- Documents the initial OSS install path, examples, package authoring flow, and
  release verification commands.
