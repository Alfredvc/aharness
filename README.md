<div align="center">

# aharness

**Make coding-agent workflows executable.**

aharness wraps Codex in a finite-state workflow: plans must be submitted,
approvals must happen, tests must produce evidence, repair loops must run, and
final reports only happen after the machine says they can.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](package.json)
[![Codex CLI >=0.130.0](https://img.shields.io/badge/codex%20cli-%3E%3D0.130.0-111827.svg)](packages/core/SUPPORTED_CODEX.md)

</div>

Skills tell an agent what to do. aharness makes sure the process actually
happens.

Use aharness when a coding task needs more structure than a prompt and less
infrastructure than a custom agent platform. Codex still does the language,
tool, and code work; aharness owns the workflow around it: states, transitions,
typed submissions, approvals, hooks, repair loops, and run artifacts.

## Why aharness

Long-horizon coding work fails in boring ways. The model skips a planning gate.
It starts implementing before approval. It says tests passed without producing
the evidence you wanted. It exits early because the prompt asked for a final
summary and the model decided the process was "close enough."

aharness turns those process rules into executable state machines:

- **Gates are real.** If a state does not expose an implementation exit, the
  model cannot move to implementation.
- **Evidence is typed.** The model submits structured payloads that aharness
  validates before reducers, guards, or effects run.
- **Approvals are controlled.** Owner input and permission requests route
  through aharness instead of relying on model convention.
- **Repair loops are explicit.** Failed evidence can transition to repair,
  rerun checks, and only then continue.
- **Runs are inspectable.** Every run writes snapshots, event logs, terminal
  reports, and declared artifacts under `.aharness/runs/<runId>/`.

## The Middle Layer

| Approach | Best for | Where it breaks down |
| --- | --- | --- |
| Skills and prompts | Reusable guidance and local conventions | Advisory only; the model can drift, skip gates, or rationalize missing evidence |
| General agent frameworks | Broad agent graphs and application orchestration | Usually not focused on Codex coding runs, local approvals, and typed coding-task gates |
| Custom coding frameworks | Deeply owned internal platforms | You own the runtime, UI, verifier, approval routing, logs, packaging, and maintenance |
| aharness | Enforced coding workflows around Codex | Overkill for one-shot prompts and tiny edits |

aharness can load skills, but the FSM owns the process. It gives you the
control plane you would otherwise build yourself, scoped specifically to
coding-agent workflows.

## Install

Prerequisites:

- Node.js `>=20`
- Codex CLI `>=0.130.0`

```bash
npm install --save-dev @aharness/core
```

## Quickstart

Scaffold a starter FSM project:

```bash
npx aharness init --dir my-fsm
cd my-fsm
npm start
```

Or run an existing FSM directly:

```bash
npx aharness verify ./workflow.fsm.ts
npx aharness visualize ./workflow.fsm.ts
npx aharness ./workflow.fsm.ts
```

`verify` checks the machine before any model run. `visualize` opens the browser
graph without starting Codex. Running the FSM starts Codex, opens the aharness
UI, shows live turn/tool activity in the browser transcript, and writes run
artifacts under `.aharness/runs/<runId>/`. Internal aharness submit calls stay
out of the default transcript.

New runs write a canonical `events.jsonl` transcript under the run directory.
That file includes full raw runtime payloads by default, including
secret-marked owner input, browser reply bodies, tool arguments/results,
command output, file diffs, approval/permission/elicitation data, and token
usage payloads, plus parent-visible sub-thread notifications. Treat run
directories as sensitive. The current browser UI still uses the flat
`/api/state`, `/api/stream`, and `/api/reply` routes, and `snapshot.json` still
exists for current inspection state.

## Write A Workflow

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
        'then submit it as { "plan": "..." }.',
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

The model can write text, run tools, and edit files while a state is active.
The FSM decides which structured exits are available and what happens when one
is submitted.

## Demo

Start with the coding smoke demo:

- [`examples/coding-smoke.fsm.ts`](examples/coding-smoke.fsm.ts) runs a tiny
  TypeScript fixture through planning, owner approval, implementation, tests,
  repair on failure, and final reporting.
- [`examples/coding-smoke/README.md`](examples/coding-smoke/README.md)
  explains the fixture and run command.

Then use the mechanism demos as references:

- [`examples/README.md`](examples/README.md) gives the recommended examples
  path.
- [`examples/DEMOS.md`](examples/DEMOS.md) catalogs await exits, approval
  hooks, composition, skill loading, branching, fresh model context, and final
  artifacts.

## Fresh Model Context

Use `clearOnEntry` on a non-initial state when the next phase should start with
fresh model context:

```ts
implementation: fsm.state({
  clearOnEntry: true,
  prompt: 'Implement the approved plan and submit test evidence.',
  on: {
    implemented: fsm.submit<{ testsPassed: boolean }>({ to: 'review' }),
  },
});
```

By default, the working directory is the original aharness launch CWD. Object
form accepts any non-empty combination of `cwd`, `model`, and
`reasoningEffort`, so a fresh context can also choose the Codex model and
reasoning effort:

```ts
worktreeReview: fsm.state({
  clearOnEntry: { cwd: '/absolute/path/to/worktree' },
  prompt: 'Review the worktree and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});
```

```ts
modelSpecificReview: fsm.state({
  clearOnEntry: { model: 'gpt-5.1-codex' },
  prompt: 'Review with the requested Codex model.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});

highEffortReview: fsm.state({
  clearOnEntry: { reasoningEffort: 'high' },
  prompt: 'Review with a fresh high-effort context.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});

targetedImplementation: fsm.state({
  clearOnEntry: {
    cwd: '/absolute/path/to/worktree',
    model: 'gpt-5.1-codex',
    reasoningEffort: 'high',
  },
  prompt: 'Implement in this worktree with the requested model and effort.',
  on: {
    implemented: fsm.submit<{ summary: string }>({ to: 'review' }),
  },
});
```

`cwd` may also be a function of machine data, and it must resolve to a non-empty
absolute path for an existing directory. Run directories and artifacts stay
anchored under the original launch directory.

`reasoningEffort` values are exactly `none`, `minimal`, `low`, `medium`,
`high`, and `xhigh`. `reasoningEffort` can be used without `model`; aharness
resolves the target model from Codex `config/read({ cwd })`, then from the
`model/list` default entry or first fallback. Static declarations are checked
by `aharness verify` against Codex `config/read` and
`model/list({ includeHidden: true })`; if `cwd` is data-dependent, effort
support may be checked by runtime preflight after the CWD resolves. Dynamic
`model` and `reasoningEffort` callbacks are not supported.

## CLI

```bash
aharness [--yolo] <file.fsm.ts> [--<flag> <value>]...
aharness visualize <file.fsm.ts> [--<flag> <value>]...
aharness verify <file.fsm.ts>
aharness doctor
aharness init --dir <path> [--force] [--no-git] [--no-install] [--pm <npm|pnpm|yarn|bun>]
aharness install <source>
aharness run [--yolo] <command> [--<flag> <value>]...
aharness list
aharness uninstall <package-name>
aharness verify <package-name>
aharness verify <package-name>/<command-name>
aharness completion install [--shell bash|zsh|fish]
aharness completion uninstall
```

Machine inputs become kebab-case flags, so `fixtureRoot` becomes
`--fixture-root`.

`--yolo` is a dangerous live-runtime flag for direct FSM runs and installed
command runs. It starts Codex with `approval_policy="never"` and
`sandbox_mode="danger-full-access"`, mirroring Codex's dangerous bypass mode.
It is not available for non-live subcommands such as `verify`, `visualize`,
`doctor`, `install`, `list`, `uninstall`, or `completion`. For direct runs it
may appear before or after the FSM path; for installed commands it may appear
before or after the command name.

## How It Works

```mermaid
flowchart LR
    Owner["Owner"]
    Codex["Codex CLI<br/>coding worker"]
    aharness["aharness CLI<br/>FSM actor + verifier"]
    Browser["Loopback browser UI<br/>approvals + graph"]
    Runs[".aharness/runs/&lt;runId&gt;<br/>events + snapshots + artifacts"]

    aharness <--> Codex
    aharness <--> Browser
    Owner <--> Browser
    aharness --> Runs
```

At runtime, aharness verifies the FSM, starts one Codex `app-server` child
process, connects as the sole WebSocket client for that run, and hosts the
XState actor in-process. Codex performs the work; aharness controls the
transition surface.

Owner replies, permission requests, hooks, typed submissions, and final
artifacts all pass through the active FSM state. The browser UI shows the graph
and handles approvals through a per-run loopback token.

## Packages

- [`@aharness/core`](packages/core/README.md) provides the SDK and `aharness`
  CLI binary.
- [`@aharness/test-support`](packages/test-support/README.md) provides
  integration-test fixtures for aharness runs.
- [`@aharness/superpowers`](packages/superpowers/README.md) is an example
  reusable FSM package.

Reusable FSM packages are npm-shaped packages with explicit
`aharness.package.commands` entries. Install them through npm-backed aharness
state, then run their commands through the global CLI:

```bash
aharness install @scope/tools
aharness run @scope/tools/build
```

Command entries point at package-root-relative `.fsm.ts` files and are verified
before aharness writes trusted install records. If validation fails after npm
changes the managed package tree, unverified commands are not indexed; see
[`docs/troubleshooting.md`](docs/troubleshooting.md) for recovery and lock
fingerprint mismatch guidance.

## Documentation

- [`docs/authoring.md`](docs/authoring.md) teaches the coding-workflow mental
  model.
- [`docs/reference.md`](docs/reference.md) documents the public SDK and CLI.
- [`docs/architecture.md`](docs/architecture.md) explains the Codex/aharness
  runtime boundary.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) covers prerequisite and
  runtime failures.
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), and
  [`SECURITY.md`](SECURITY.md) cover project maintenance, release notes, and
  vulnerability reporting.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
