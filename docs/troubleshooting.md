# Troubleshooting

## Node Is Too Old

aharness packages require Node.js `>=20`. If install, build, or runtime commands
fail with syntax or engine errors, check:

```bash
node --version
```

Use Node 20 or newer before rerunning `npm install`, `npx aharness verify`, or
`npx aharness <file.fsm.ts>`.

## Codex CLI Is Missing Or Too Old

aharness starts Codex as the local coding worker. The public runtime requires
the installed `codex` CLI to report version `0.130.0` or newer. The repository
most recently validated `codex-cli 0.133.0` on 2026-05-24.

Check the environment with:

```bash
codex --version
npx aharness doctor
```

If `aharness doctor` reports that `codex` is not on `PATH`, install or expose
the Codex CLI in the shell that runs aharness. If it reports a version below
`0.130.0`, upgrade Codex before running an FSM.

## Verify Fails Before Runtime

Run:

```bash
npx aharness verify ./path/to/workflow.fsm.ts
```

The verifier catches invalid FSM shape before Codex starts. Common causes are:

- `on` keys that are neither `fsm.submit(...)`, `fsm.await(...)`, built-in
  events, nor events declared with `withEvents(...)`.
- Missing child-final handlers for `fsm.embed(...)`.
- Input flags whose defaults or metadata do not match the declared helper.
- TypeScript import errors in the `.fsm.ts` file.

Fix verification failures first. Runtime does not start an invalid machine.

## CLI Input Flags Do Not Work

Machine input fields become kebab-case flags. For example, `fixtureRoot` is
passed as:

```bash
npx aharness ./workflow.fsm.ts --fixture-root ./examples/coding-smoke/fixture
```

Every flag value must be a separate token and values may not start with `--`.
If an input field shadows a framework flag, aharness warns that the field is
unreachable from the CLI; set that value with another input path or rename the
field.

## Installed Package Commands Do Not Run

Installed FSM packages are trusted only after `aharness install <source>`
validates package metadata, package-relative assets, loader behavior, and the
verifier result for every declared command. npm may still change files in the
managed package project before aharness rejects a package. In that case
aharness leaves npm-managed files in place, but it does not update
`installs.json` or `commands.json`, so unverified commands remain unrunnable.

If `aharness run` or installed `aharness verify` reports
`installed-lock-fingerprint-mismatch`, the managed npm tree no longer matches
the verified install record. Re-run `aharness install <same-source>` to refresh
the package, or run `aharness uninstall <package-name>` before installing a
different source for the same package name.

If `commands.json` is missing, stale, or malformed, aharness regenerates it from
a valid `installs.json` after checking recorded lock fingerprints. If
`installs.json` is malformed, aharness reports `trusted-installs-unrecoverable`;
remove or restore that file before installed commands can be trusted again.

Bare command names work only when exactly one installed package provides that
command. If aharness reports an ambiguous command, run the fully qualified
identity shown in the diagnostic, such as:

```bash
aharness run @scope/tools/build
```

## Approval Or Owner Input Is Stuck

aharness runs foreground-only and opens a loopback browser UI for owner
approvals. Keep the CLI process running and use the URL printed by the command.

Free-text owner input comes from Codex `request_user_input`; approval requests
come through aharness approval dispatch. If a state should wait for the owner,
check whether the FSM uses `fsm.await(...)`, `ask`, or a built-in
`permissionRequest` handler as intended.

## A Run Ended But Artifacts Are Needed

Each run writes inspection files under:

```text
.aharness/runs/<runId>/
```

Look for the event log, snapshots, terminal report, and any final artifacts
declared by `fsm.final({ artifacts })`. Current public CLI invocations start a
new run and Codex thread; run artifacts are evidence, not continuation state.

For new runs, `events.jsonl` is the canonical event transcript and includes
full raw runtime payloads by default. That can include secret-marked owner
input, browser replies, tool arguments/results, command output, file diffs,
approval/permission/elicitation data, token usage payloads, and parent-visible
sub-thread notifications. Treat the run directory as sensitive when sharing
debugging evidence.

If you inspect the loopback UI API directly, run-scoped endpoints under
`/api/runs/:runId/` provide compact JSONL-backed bootstrap, row, event-page,
SSE, and reply projections for the active run. Those API/SSE responses omit raw
payload expansion, so missing raw request or tool details usually means you need
the sensitive `events.jsonl` file rather than an API response. The current React
browser still uses flat `/api/state`, `/api/stream`, and `/api/reply`
compatibility routes until Slice 4, and `snapshot.json` still exists for
current inspection state.
