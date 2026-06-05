# Troubleshooting

## Node Is Too Old

aharness packages require Node.js `>=20`. If install, build, or runtime commands
fail with syntax or engine errors, check:

```bash
node --version
```

Use Node 20 or newer before rerunning `npm install`, `npx aharness verify`, or
`npx aharness run <file.fsm.ts>`.

## Codex CLI Is Missing Or Too Old

aharness starts Codex as the local coding worker. The public runtime requires
the installed `codex` CLI to report version `0.136.0` or newer. The repository
most recently validated `codex-cli 0.136.0` on 2026-06-02.

Check the environment with:

```bash
codex --version
npx aharness doctor
```

If `aharness doctor` reports that `codex` is not on `PATH`, install or expose
the Codex CLI in the shell that runs aharness. If it reports a version below
`0.136.0`, upgrade Codex before running an FSM.

## Skill Preflight Fails At Startup

Before creating the Codex thread, aharness registers FSM skill roots with
Codex and asks Codex to scan the skill catalog. Failures are reported as:

```text
aharness: skill preflight failed: ...
```

Common causes are:

- a required path-form state skill points at a missing or disabled `SKILL.md`;
- a required name-form state skill is missing from the enabled Codex catalog;
- a name-form state skill matches more than one enabled Codex catalog entry;
- Codex reports invalid skill metadata or parse errors during `skills/list`.

Fix the referenced skill path/name, package-bundled skill file, or Codex skill
configuration, then rerun the FSM.

## Verify Fails Before Runtime

Run:

```bash
npx aharness verify ./path/to/workflow.fsm.ts
```

The verifier catches invalid FSM shape before Codex starts. It prints each
blocking error and non-blocking warning as a diagnostic line, with `file:line:`
when source locations are available. Common causes are:

- `on` keys that are neither `fsm.submit(...)`, `fsm.choice(...)`, built-in
  events, nor events declared with `withEvents(...)`.
- Missing child-final handlers for `fsm.embed(...)`.
- Input flags whose defaults or metadata do not match the declared helper.
- Skill shape errors, such as a state-level `fsm.skill.dir(...)`, a
  name-form ref in top-level `availableSkills`, or a path ref that does not
  point at `SKILL.md`.
- TypeScript import errors in the `.fsm.ts` file.

Fix verification failures first. Runtime does not start an invalid machine.
Name-form state skill availability remains a runtime catalog concern, so verify
checks its shape while startup preflight checks whether Codex can resolve it.

## CLI Input Flags Do Not Work

Machine input fields become kebab-case flags. For example, `fixtureRoot` is
passed as:

```bash
npx aharness run ./workflow.fsm.ts --fixture-root ./examples/coding-smoke/fixture
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

aharness runs foreground-only and opens a loopback browser UI for owner input
and, in manual review mode, approval cards. Keep the CLI process running and
use the URL printed by the command.

Owner-paced free text belongs in an open state, where Codex can converse with
the owner until it submits typed data. Model-originated Codex
`request_user_input` prompts also surface through the browser when the model
needs an ad hoc clarification inside a state. Approval requests come through
aharness approval dispatch only when Codex is using manual user review. Default
live runs use Codex auto-review, so eligible sandbox-boundary prompts may be
resolved without a browser approval card. If you expected to review eligible
approval prompts in the browser, rerun with `--ask`.

If a state should wait for the owner, check whether the FSM uses
`fsm.choice(...)`, an open state, or a built-in `permissionRequest` handler as
intended. Use Codex `request_user_input` from inside state work only when the
owner reply should inform the model's later typed submit rather than act as an
aharness FSM transition.

## A Run Ended But Artifacts Are Needed

Each run writes inspection files under:

```text
.aharness/runs/<runId>/
```

Look for the canonical `events.jsonl` transcript, terminal report, and any
final artifacts declared by `fsm.final({ artifacts })`. Current public CLI
invocations start a new run and Codex thread; run artifacts are evidence, not
continuation state.

For new runs, `events.jsonl` is the canonical event transcript and includes
full raw runtime payloads by default. That can include secret-marked owner
input, browser replies, tool arguments/results, command output, file diffs,
approval/permission/elicitation data, token usage payloads, and parent-visible
sub-thread notifications. `events.jsonl` can also contain public workflow
context snapshots recorded as `context.initialized` and `context.changed`
events. Treat run directories as sensitive even when the browser transcript does
not display those context values by default.

If you inspect the loopback UI API directly, run-scoped endpoints under
`/api/runs/:runId/` provide compact JSONL-backed bootstrap, row, event-page,
SSE, and reply projections for the active run. Those API/SSE responses omit raw
payload expansion, so missing raw request or tool details usually means you need
the sensitive `events.jsonl` file rather than an API response. The React
browser now uses the run-scoped bootstrap, row, stream, and reply endpoints. Its
header and bottom status bar show aggregate running-time, token, and
context-window stats when available; the browser no longer uses a top turn count
or bottom turn ribbon as the primary run chrome. The old flat `/api/state`,
`/api/stream`, and `/api/reply` browser routes are no longer served for new
runs. Production live runs do not write `snapshot.json`; retained snapshot
helper exports are legacy/internal compatibility only.

## Copy PNG Does Not Work

Final overview share cards use the browser Clipboard API for `Copy PNG`.
Copying can fail when the browser does not support image clipboard writes, when
the browser denies the write, or when the browser cannot encode the card as a
PNG. The preview stays open after these failures. Use `Download PNG` as the
fallback; it exports the same low-disclosure share card without requiring image
clipboard support or clipboard permission.
