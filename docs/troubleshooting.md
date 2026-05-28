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
