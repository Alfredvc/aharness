<div align="center">

# aharness

**Make coding-agent workflows executable.**

The workflow harness for Codex: typed gates, validated evidence, controlled
transitions, repair paths, and inspectable run logs for any workflow.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](package.json)
[![Codex CLI >=0.130.0](https://img.shields.io/badge/codex%20cli-%3E%3D0.130.0-111827.svg)](packages/core/SUPPORTED_CODEX.md)

</div>

Prompts and skills tell an agent what to do. aharness makes sure the process
actually happens.

Use it when a Codex run needs enforceable workflow boundaries, structured
submissions, human checkpoints, policy hooks, or recovery paths. Codex still
writes code, runs tools, and reasons through the task; aharness owns the
workflow around it.

## Why Now

Coding agents are now useful enough to attempt long, multi-step changes. The
failure mode is no longer only "can the model code?" It is process drift: the
model skips a planning gate, starts implementation before approval, says tests
passed without evidence, or exits early because the prompt sounded satisfied.

Skills and instructions help, but they are advisory. aharness gives those rules
a runtime: only the active state's exits are available, submitted evidence is
validated, owner input and approval requests route through the machine, and
runs leave inspectable artifacts.

## What You Get

- **Real gates.** If a state does not expose an implementation exit, the model
  cannot move to implementation.
- **Typed evidence.** Codex submits structured payloads that aharness validates
  before reducers, guards, or effects run.
- **Owner and policy control.** Owner input, permission requests, pre-tool
  hooks, post-tool hooks, and prompt-submission events can become workflow
  transitions.
- **Repair loops.** Failed evidence can route to repair, rerun checks, and only
  then continue.
- **Composable, publishable workflows.** FSMs can embed child FSMs and ship as
  installable package commands, so large workflows can be built from small,
  typed, reusable pieces.
- **Inspectable runs.** Every run writes a canonical transcript and declared
  artifacts under `.aharness/runs/<runId>/`.
- **A browser view.** Live runs and `visualize` show the workflow graph,
  current state, transcript, approvals, and run stats.

## Install

Prerequisites:

- Node.js `>=20`
- Codex CLI `>=0.130.0` on `PATH`

```bash
npm install --save-dev @aharness/core
```

If setup fails, run:

```bash
npx aharness doctor
```

`doctor` checks the Codex CLI version gate and reports active run health.

## Quickstart

Scaffold a starter FSM project:

```bash
npx aharness init --dir my-fsm
cd my-fsm
npm start
```

`aharness init` creates a small TypeScript FSM project, installs dependencies,
and initializes git by default when the target is not already inside a
repository. Use `--no-install`, `--no-git`, or `--pm <npm|pnpm|yarn|bun>` when
you need to control those steps.

Run an existing FSM directly:

```bash
npx aharness verify ./workflow.fsm.ts
npx aharness visualize ./workflow.fsm.ts
npx aharness run ./workflow.fsm.ts
```

- `verify` checks the machine before Codex starts.
- `visualize` opens the graph/details UI without starting Codex.
- `aharness run ./workflow.fsm.ts` starts a foreground Codex run and opens the
  browser UI for owner input and any approval prompts routed to the user.

`aharness ./workflow.fsm.ts` remains supported as a compatibility form.
Machine inputs become kebab-case flags, so `fixtureRoot` is passed as
`--fixture-root`.

## First Workflow

aharness workflows are TypeScript files built with `createFsm`:

```ts
import { createFsm } from '@aharness/core';

interface Data {
  plan: string | null;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'tiny-coding-task',
  initial: 'plan',
  data: () => ({ plan: null }),
  states: {
    plan: fsm.state({
      prompt:
        'Inspect the requested coding task, write a short implementation plan, ' +
        'then submit it as { "plan": "..." }. Do not edit files yet.',
      on: {
        submitPlan: fsm.submit<{ plan: string }>({
          to: 'ownerApproval',
          reduce: (draft, payload) => {
            draft.plan = payload.plan;
          },
        }),
      },
    }),
    ownerApproval: fsm.state({
      prompt: (data) =>
        `Ask the owner to approve this plan before implementation:\n\n${data.plan}`,
      on: {
        approved: fsm.await({
          ask: 'Approve this plan? Reply with approval or requested changes.',
          to: 'done',
        }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

`fsm.state(...)` gives Codex instructions for the current phase.
`fsm.submit<T>(...)` declares typed evidence the model may submit.
`fsm.await(...)` waits for owner input. `fsm.final(...)` ends the run and can
write final artifacts.

For a fuller coding workflow, start with the smoke demo. It includes planning,
owner approval, implementation, test evidence, repair on failure, and final
reporting.

## Try The Demo

From a source checkout:

```bash
pnpm run build
node packages/core/dist/cli/main.js verify examples/coding-smoke.fsm.ts
node packages/core/dist/cli/main.js examples/coding-smoke.fsm.ts
```

The demo files are:

- [`examples/coding-smoke.fsm.ts`](examples/coding-smoke.fsm.ts) - the FSM.
- [`examples/coding-smoke/fixture`](examples/coding-smoke/fixture) - the tiny
  broken TypeScript fixture the agent repairs.
- [`examples/coding-smoke/README.md`](examples/coding-smoke/README.md) - what
  to watch during the run.

After that, use [`examples/DEMOS.md`](examples/DEMOS.md) as a catalog of focused
mechanism demos for awaits, approvals, hooks, composition, skills, branching,
and final artifacts.

## How It Works

```mermaid
flowchart LR
    Owner["Owner"]
    Codex["Codex CLI<br/>coding worker"]
    Aharness["aharness CLI<br/>FSM actor + verifier"]
    Browser["Loopback browser UI<br/>input + approvals + graph"]
    Runs[".aharness/runs/&lt;runId&gt;<br/>events.jsonl + reports + artifacts"]

    Aharness <--> Codex
    Aharness <--> Browser
    Owner <--> Browser
    Aharness --> Runs
```

At runtime, aharness verifies the FSM, starts one Codex `app-server` child
process, connects as the sole WebSocket client for that run, and hosts the
XState actor in-process. Codex performs the work; aharness controls which
state transitions are legal.

Runs are foreground-only. Keep the CLI process running and use the printed
browser URL for owner input and any approval prompts routed to the user.

Run directories are sensitive. `.aharness/runs/<runId>/events.jsonl` can include
raw owner input, browser replies, tool arguments and results, command output,
file diffs, approval data, and token usage payloads. `events.jsonl` can also
contain public workflow context snapshots recorded as `context.initialized` and
`context.changed` events. Treat run directories as sensitive even when the
browser transcript does not display those context values by default.

## When To Use It

aharness is the middle layer for coding workflows that need more enforcement
than a prompt and less infrastructure than a custom agent platform.

| Use | Better fit |
| --- | --- |
| Ordered phases: plan, approve, implement, verify, repair, report | One-shot prompts and tiny edits |
| Typed submissions and test evidence | Manual sessions where the owner steers every turn |
| Owner approvals and repository policy hooks | General non-coding agent orchestration |
| Reusable coding workflows packaged as commands | Teams ready to build and own a full custom runtime |

The core package provides mechanisms, not one team's process. Workflow opinions
belong in your FSMs, examples, or installable FSM packages.

## Common Commands

```bash
aharness init --dir <path>
aharness verify <file.fsm.ts>
aharness visualize <file.fsm.ts>
aharness [--ask|--yolo] <file.fsm.ts> [--<input-flag> <value>]...
aharness doctor
aharness install <source>
aharness run [--ask|--yolo] <file.fsm.ts|command> [--<input-flag> <value>]...
```

See [`docs/reference.md`](docs/reference.md) for the full CLI, state options,
hooks, installable package commands, completions, default Codex auto-review
behavior, `--ask`, and `--yolo`.

## Packages

- [`@aharness/core`](packages/core/README.md) provides the SDK and `aharness`
  CLI binary.
- [`@aharness/test-support`](packages/test-support/README.md) provides
  integration-test fixtures for aharness runs.
- `packages/web-ui` is the private React/Vite browser UI bundled into the core
  CLI build.

## Documentation

- [`docs/authoring.md`](docs/authoring.md) teaches the coding-workflow mental
  model.
- [`docs/reference.md`](docs/reference.md) documents the public SDK and CLI.
- [`docs/architecture.md`](docs/architecture.md) explains the Codex/aharness
  runtime boundary.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) covers prerequisite and
  runtime failures.
- [`packages/core/SUPPORTED_CODEX.md`](packages/core/SUPPORTED_CODEX.md)
  documents the Codex CLI compatibility gate.
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), and
  [`SECURITY.md`](SECURITY.md) cover project maintenance, release notes, and
  vulnerability reporting.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
