# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.1.3](https://github.com/Alfredvc/aharness/compare/v0.1.2...v0.1.3) (2026-06-08)

### Features

- add codex sidecar manager core ([354f1c7](https://github.com/Alfredvc/aharness/commit/354f1c71b7ea51e13ee2734017fde90d649c80e8))
- add programmatic run API ([f388784](https://github.com/Alfredvc/aharness/commit/f388784c580fbd55751449561fb9ed8dd799903f))
- add sidecar author API types ([aee0bbd](https://github.com/Alfredvc/aharness/commit/aee0bbd063cb46261d92e651ab85f199f7c97491))
- add thread skills machine surface ([70aa4c0](https://github.com/Alfredvc/aharness/commit/70aa4c01c288d406b0b8ee8fa1930be1250846d9))
- record sidecar run events ([a415342](https://github.com/Alfredvc/aharness/commit/a4153423a5c58dea6ae1b9753d439a7b03974efc))
- wire live codex sidecar requests ([15b4795](https://github.com/Alfredvc/aharness/commit/15b479542c12b30c931c6663b7a5a72ad5384500))

### Bug Fixes

- handle delayed sidecar turn start close ([4b53916](https://github.com/Alfredvc/aharness/commit/4b539168bf3266f0c1cf357cc838e43ef2f7500b))
- handle interrupted sidecar turns ([c7ec642](https://github.com/Alfredvc/aharness/commit/c7ec642fd95bfad85b5aad651c60c4564db26680))
- keep sidecar events out of subthread projections ([1b44267](https://github.com/Alfredvc/aharness/commit/1b44267fdd0330b50a0353711ca3ffef71de56ce))
- use raw github urls for package readme images ([e2e0c12](https://github.com/Alfredvc/aharness/commit/e2e0c1269663e2323423476b9d3d71f6c8fb11f3))

## [0.1.2](https://github.com/Alfredvc/aharness/compare/v0.1.1...v0.1.2) (2026-06-07)

### Bug Fixes

- support CommonJS requires in FSM bundles ([99223ce](https://github.com/Alfredvc/aharness/commit/99223ce1e7eba2fdbea85e6bc886086b47de10df))

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
