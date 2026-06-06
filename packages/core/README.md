# @aharness/core

SDK and `aharness` CLI binary for aharness FSMs.

Install the CLI globally:

```sh
npm install -g @aharness/core
```

aharness is the middle layer between advisory skills/prompts and a custom coding
aharness: Codex performs the language and coding work, while aharness enforces
the executable FSM process around that work.

Start here:

- [Root README](../../README.md) for positioning, install, and quickstart.
- [Authoring guide](../../docs/authoring.md) for the coding-workflow mental
  model.
- [Reference](../../docs/reference.md) for `createFsm`, CLI commands, and
  package authoring.
- [Troubleshooting](../../docs/troubleshooting.md) for Codex prerequisites,
  installed-package recovery, and lock fingerprint failures.
- [Architecture](../../docs/architecture.md) for the Codex/aharness runtime
  boundary.
- [Supported Codex versions](SUPPORTED_CODEX.md) for the runtime version gate.

Public prerequisites are Node.js `>=20` and Codex CLI `>=0.136.0`. See
[`SUPPORTED_CODEX.md`](SUPPORTED_CODEX.md) for the compatibility gate.

Release verification from this repository is:

```sh
pnpm run verify
pnpm run verify:release
```
