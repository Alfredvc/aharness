# Authoring

aharness FSMs are best understood as executable coding workflows. Start by
deciding which parts of the coding process must happen in order, which evidence
must be submitted before moving on, and where the owner or repository policy
gets a vote.

The coding smoke demo follows the recommended shape:

1. Plan the change.
2. Ask the owner to approve the plan.
3. Implement only after approval.
4. Run tests and submit structured evidence.
5. Repair on failed evidence.
6. Write a final report only after passing evidence.

That is the mental model to use before cataloging primitives. A state is not a
prompt section; it is a gate in the process.

## When aharness Is Not The Right Tool

Do not start by writing an FSM for every coding request. aharness earns its keep
when the process has durable structure: ordered phases, typed submissions,
approval gates, repair loops, policy hooks, or evidence that must be inspected
after the run.

For one-shot prompts and tiny edits, a direct Codex or Claude Code session is
usually the cleaner control surface. If the owner wants to steer every turn
manually, the manual conversation is the workflow; adding an FSM creates
ceremony without adding much enforcement.

If the work is arbitrary multi-agent orchestration rather than a coding-agent
workflow, a general framework may be the better foundation. aharness is narrower:
it focuses on executable process control around coding agents, not every shape
of agent graph.

A custom aharness can also be the right answer for teams with deep platform
requirements and the engineering bandwidth to own the runtime, UI, approval
model, logging, verifier, and integrations. aharness targets the middle layer:
more enforceable than a skill, smaller than building that stack yourself.

## A Small FSM

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
        'Inspect the coding task, write a short implementation plan, ' +
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
      prompt: (data) => `Ask the owner to approve this plan:\n\n${data.plan}`,
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

Run it with:

```bash
npx aharness verify ./tiny-coding-task.fsm.ts
npx aharness visualize ./tiny-coding-task.fsm.ts
npx aharness ./tiny-coding-task.fsm.ts
```

## Authoring Guidelines

Use states for enforceable workflow boundaries: planning, approval,
implementation, test evidence, repair, review, and final reporting.

Use `fsm.submit<T>()` when the model must provide structured evidence. Put the
schema in the TypeScript payload type and put process checks in `effect`,
`reduce`, routes, and guards.

Use `fsm.await(...)` when the owner must provide free-text input before the run
continues. Use a submit exit after an await only when the model needs to
interpret that reply into structured data.

Use built-in events when repository policy should intercept Codex activity:
`permissionRequest`, `preToolUse`, `postToolUse`, and `userPromptSubmit`.

Use `clearOnEntry` when entering a state should discard prior model context.
Boolean form starts the state with fresh model context in the original aharness
launch working directory:

```ts
implementation: fsm.state({
  clearOnEntry: true,
  prompt: 'Implement the approved plan and submit test evidence.',
  on: {
    implemented: fsm.submit<{ testsPassed: boolean }>({ to: 'review' }),
  },
});
```

Object form also chooses the working directory, model, reasoning effort, or any
non-empty combination of those options for the fresh model context:

```ts
packageWork: fsm.state({
  clearOnEntry: {
    cwd: '/absolute/path/to/package',
    model: 'gpt-5.1-codex',
    reasoningEffort: 'high',
  },
  prompt: 'Make the package change and submit a summary.',
  on: {
    changed: fsm.submit<{ summary: string }>({ to: 'done' }),
  },
});
```

```ts
modelReview: fsm.state({
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

`cwd` must be a non-empty absolute path for an existing directory. It can be a
function of machine data for worktree or multi-project workflows:

```ts
worktreeReview: fsm.state({
  clearOnEntry: { cwd: (data) => data.worktreePath },
  prompt: 'Review the worktree and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});
```

Model-only and effort-only declarations are valid when the working directory
should remain the aharness launch CWD:

```ts
clearOnEntry: { model: 'gpt-5.1-codex' }
clearOnEntry: { reasoningEffort: 'high' }
clearOnEntry: { model: 'gpt-5.1-codex', reasoningEffort: 'high' }
```

`model` and `reasoningEffort` are static strings. Dynamic callbacks are not
supported for those fields. Allowed reasoning efforts are `none`, `minimal`,
`low`, `medium`, `high`, and `xhigh`.

`reasoningEffort` can be used without `model`. aharness resolves the target
model from Codex effective config for the clear CWD, then Codex's catalog
default. Static declarations are checked by `aharness verify` through Codex
`config/read` and `model/list`; function-form `cwd` may defer effort support
checks to runtime preflight.

The aharness run directory, snapshots, event logs, and final artifacts remain
anchored to the original launch working directory even when a state chooses a
different working directory.

`reasoningEffort` values are exactly `none`, `minimal`, `low`, `medium`,
`high`, and `xhigh`. `reasoningEffort` can be used without `model`; aharness
resolves the target model from Codex `config/read({ cwd })`, then from the
`model/list` default entry or first fallback. `aharness verify` checks static
model and effort declarations against Codex `config/read` and
`model/list({ includeHidden: true })`. When `cwd` is a function of machine
data, effort support may be deferred to runtime preflight after the CWD
resolves. Dynamic `model` and `reasoningEffort` callbacks are not supported.

Use `fsm.embed(...)` when a repeated sub-process deserves its own child FSM with
typed final outputs.

Use skills as guidance loaded into states, not as the source of process truth.
Skills can tell Codex how to behave inside a state; the FSM controls whether
the workflow may leave that state.

When converting an existing skill into an FSM, keep the top-level `SKILL.md` as
a short map for users who know the old workflow. Move process control into FSM
states, transitions, reducers, and final artifacts. Move phase-specific
operating guidance into state prompts or small guide files referenced by the
state. Do not make every state a standalone skill unless that guidance is
independently reusable.

## Inputs And Skills

Declare CLI inputs on the machine with `fsm.input.*` helpers:

```ts
input: {
  fixtureRoot: fsm.input.path({
    description: 'Fixture package to repair',
    default: './examples/coding-smoke/fixture',
    complete: 'directory',
  }),
  maxRepairAttempts: fsm.input.number({ default: 2 }),
}
```

Inputs become kebab-case CLI flags such as `--fixture-root` and
`--max-repair-attempts`.

Attach skills with `fsm.skill(name)` or `fsm.skill.path(path)`. Packaged FSMs
should use path-form references for bundled skills so the installed package can
resolve them reliably.

## Where To Start

Read [`examples/README.md`](../examples/README.md) first. Run the coding smoke
demo, then use [`examples/DEMOS.md`](../examples/DEMOS.md) as a catalog of
focused mechanism examples.
