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

Use `fsm.embed(...)` when a repeated sub-process deserves its own child FSM with
typed final outputs.

Use skills as guidance loaded into states, not as the source of process truth.
Skills can tell Codex how to behave inside a state; the FSM controls whether
the workflow may leave that state.

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
