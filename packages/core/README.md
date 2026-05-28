# @aharness/core

SDK and `aharness` CLI binary for aharness FSMs.

```sh
npm install --save-dev @aharness/core
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
- [Architecture](../../docs/architecture.md) for the Codex/aharness runtime
  boundary.
- [Supported Codex versions](SUPPORTED_CODEX.md) for the runtime version gate.

Public prerequisites are Node.js `>=20` and Codex CLI `>=0.130.0`.

Release verification from this repository is:

```sh
pnpm run verify
pnpm run verify:release
```
