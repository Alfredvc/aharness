# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.1.1](https://github.com/Alfredvc/aharness/compare/v0.1.0...v0.1.1) (2026-06-06)

### Features

- **release:** add changelog generation tooling ([cb78493](https://github.com/Alfredvc/aharness/commit/cb7849375431e83e5382685929379c4fb31aefef))
- **release:** document changelog visibility rules ([0791e11](https://github.com/Alfredvc/aharness/commit/0791e119dd61ae1386bf2f57b9ed666df2affc12))

### Bug Fixes

- route installed runs through production cli ([83d9cd3](https://github.com/Alfredvc/aharness/commit/83d9cd3e6f92e1cbf80a829279b837c347e99a1f))

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
