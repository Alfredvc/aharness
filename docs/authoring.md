# Authoring

This guide teaches how to design and write aharness FSMs. It is a workflow
authoring guide, not the exhaustive API reference. Use
[`reference.md`](./reference.md) for full option shapes, CLI forms, and package
metadata; use [`architecture.md`](./architecture.md) for the runtime boundary.

If you are using Codex to write an FSM, start with the bundled authoring skill:

```text
Use $aharness-fsm-authoring to design and author an aharness FSM for this workflow.
```

The skill helps with the same process this guide describes: identify the
workflow contract, sketch the smallest enforcing state graph, write typed
submissions, verify, and then run.

## Table Of Contents

- [What Authoring Means](#what-authoring-means)
- [When To Use aharness](#when-to-use-aharness)
- [Start With The Workflow Contract](#start-with-the-workflow-contract)
- [Sketch The Smallest Enforcing Graph](#sketch-the-smallest-enforcing-graph)
- [A Small FSM](#a-small-fsm)
- [Data And Inputs](#data-and-inputs)
- [Choosing State Mechanisms](#choosing-state-mechanisms)
- [Submits, Routes, Reducers, And Effects](#submits-routes-reducers-and-effects)
- [Owner Interaction](#owner-interaction)
- [Reports And Artifacts](#reports-and-artifacts)
- [Fresh Context, Models, And Skills](#fresh-context-models-and-skills)
- [Composition And Runtime Events](#composition-and-runtime-events)
- [Verify, Visualize, Run, Inspect](#verify-visualize-run-inspect)
- [Common Authoring Mistakes](#common-authoring-mistakes)
- [Where To Read Next](#where-to-read-next)

## What Authoring Means

An aharness FSM is executable process control around Codex. Codex does the
language, coding, inspection, and judgment work inside the active state.
aharness owns the workflow boundary: states, valid exits, typed submissions,
owner choices, approval routing, final outcomes, and run evidence.

The model cannot move the workflow forward by saying it is done. It must submit
typed data through the active state's declared exit. aharness validates that
payload, runs the configured effect and reducer, records the event, and only then
transitions the FSM.

That distinction is the main authoring rule: prompts and skills guide what
Codex should do inside a state; the FSM decides whether the workflow may leave
that state.

## When To Use aharness

Use aharness when the coding process has durable structure that should be
enforced:

- ordered phases such as plan, approve, implement, verify, repair, and report;
- typed evidence that later states or final artifacts consume;
- deterministic owner choices or approval policy;
- repair loops, attempt caps, or terminal failure policy;
- fresh context or different working directories between phases;
- reusable subprocesses that should be embedded or packaged.

For one-shot prompts and tiny edits, a direct Codex session is usually simpler.
If the owner wants to steer every turn manually, the conversation itself is the
workflow. If the work is general non-coding agent orchestration, a broader agent
framework may be a better fit.

The core package provides mechanisms, not one team's process. Planning rituals,
review policies, retry strategies, and team-specific command order belong in
your FSMs, examples, or installable packages.

## Start With The Workflow Contract

Do not start by listing API primitives. Start by naming the workflow contract:
what the runtime must supervise, remember, route, recover from, clear, or stop
on.

Answer these before writing the file:

- What is terminal success?
- What is terminal failure?
- Which facts must survive across states?
- Which decisions route the workflow?
- Which evidence must be structured instead of left in prose?
- Which owner interactions are deterministic choices, and which are free-form
  discussion?
- Which failures should repair, retry, ask the owner, or stop?
- Which final artifacts should the run produce?

For a coding workflow, a common contract is:

1. Plan the change.
2. Ask the owner to approve or request changes.
3. Implement only after approval.
4. Run tests and submit structured evidence.
5. Repair when evidence fails, up to a defined policy.
6. Write a final report only after passing evidence.

That is a useful example, not a framework rule. The right graph is the one that
enforces the contract for the workflow you are actually authoring.

### Separate Runtime Control From Model Work

Keep the runtime contract in the FSM. State topology, submit schemas, route
predicates, reducers, effects, attempt limits, owner choices, terminal outcomes,
and final artifacts are process control and should be encoded in the graph.

Keep ordinary in-phase work inside Codex and selected skills. Reading files,
drafting plans, implementing code, evaluating ambiguity, summarizing evidence,
and asking clarifying questions can happen inside a state as long as they do not
decide whether the workflow may leave, retry, or stop.

## Sketch The Smallest Enforcing Graph

### Promote Only Runtime Gates

Promote work into a separate state only when the runtime needs a visible gate.
A state is justified when it:

- routes differently after the work;
- records durable data or evidence;
- changes the owner, model, working directory, or tool policy;
- discards stale conversation history before the next phase;
- owns a known recovery or retry path;
- represents a subprocess with its own lifecycle and final outputs.

Do not turn every checklist item, command, or paragraph from a skill into a
state. A broad state may inspect several files, run several commands, and submit
one typed result if intermediate steps do not affect routing.

### Check Each Proposed State

For every proposed state, ask:

```text
What workflow requirement makes this state runtime-visible?
What data does a later state or artifact consume?
Could this be normal work inside a broader state?
Can every path from here reach a valid terminal outcome?
```

### Audit Failed And Blocked Paths

Trace every path to terminal failure or a blocked-style terminal before writing
code. For each one, ask whether the workflow is truly done, whether owner input
or repair should be encoded instead, and what evidence the final state should
report.

Recovery is not mandatory for every workflow. If the contract promises recovery,
make it a route, loop, attempt counter, or owner choice in the graph rather than
only a sentence in a prompt.

## A Small FSM

This tiny FSM shows the canonical authoring surface. It plans a coding task,
stores the plan in FSM data, parks on an owner choice, and ends only through an
authored terminal state.

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
    ownerApproval: fsm.choice({
      question: (data) => `Approve this plan before implementation?\n\n${data.plan}`,
      options: [{ label: 'Approve', to: 'done' }],
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

Run the static gate first:

```bash
aharness verify ./tiny-coding-task.fsm.ts
aharness visualize ./tiny-coding-task.fsm.ts
aharness run ./tiny-coding-task.fsm.ts
```

The real coding example is
[`examples/coding-smoke.fsm.ts`](../examples/coding-smoke.fsm.ts). It adds owner
revision, implementation evidence, test evidence, repair loops, success/failure
finals, and a final report artifact.

## Data And Inputs

### FSM Data

Use `Data` for durable workflow facts: approved plans, selected files, evidence,
counters, owner decisions, final report text, and anything later states or
artifacts need. Do not rely on model memory for workflow state.

Use nullable fields when a fact is genuinely not known yet:

```ts
interface Data {
  plan: string | null;
  testPassed: boolean | null;
  repairAttempts: number;
}
```

### Run Inputs

Declare run inputs at the machine root. Inputs become kebab-case CLI flags for
`aharness run` and `aharness visualize`.

```ts
export default fsm.machine({
  id: 'coding-smoke',
  input: {
    fixtureRoot: fsm.input.path({
      description: 'Fixture package the coding model should repair',
      default: './examples/coding-smoke/fixture',
      complete: 'directory',
    }),
    maxRepairAttempts: fsm.input.number({
      description: 'Maximum repair loops after failing test evidence',
      default: 2,
    }),
  },
  data: ({ input }) => ({
    fixtureRoot: input.fixtureRoot,
    maxRepairAttempts: input.maxRepairAttempts,
    plan: null,
    testPassed: null,
    repairAttempts: 0,
  }),
  initial: 'plan',
  states: {
    // ...
  },
});
```

Then run with input flags after the target:

```bash
aharness run ./workflow.fsm.ts --fixture-root ./fixture --max-repair-attempts 3
```

Runtime flags go before the target. FSM input flags go after it:

```bash
aharness run --ask ./workflow.fsm.ts --fixture-root ./fixture
```

Use `aharness run <file.fsm.ts|command> --help` to inspect FSM input help for
local FSM files and installed commands. That help form is exact: runtime flags
such as `--ask`, `--yolo`, and `--no-open` still go before the target for real
runs, but they are not accepted in the input-help command shape.

## Choosing State Mechanisms

### Canonical Primitives

Use the canonical `createFsm` surface for new FSMs:

- `fsm.state(...)` for Codex work that must end in a typed submit or event.
- `fsm.choice(...)` for deterministic owner choices.
- `mode: 'open'` on `fsm.state(...)` for owner-paced free-form discussion.
- `fsm.passive(...)` for deterministic XState behavior with no model prompt.
- `fsm.embed(...)` for reusable child FSMs with typed final outputs.
- `fsm.final(...)` for terminal success or failure.

### Prompted States

Most states should be strict `fsm.state` nodes. Their prompt should say what the
model owns now, what data matters, and what it must submit when ready.

### Graph Hints And Escape Hatches

Use `main: true` only as a graph-layout hint for the primary story path. It does
not affect runtime behavior, verifier checks, or transition legality.

Use raw `xstate` only when the canonical fields cannot express the behavior
cleanly, and keep it local.

## Submits, Routes, Reducers, And Effects

### Submit Payloads

Use `fsm.submit<T>()` when Codex must provide structured evidence.

Payload types should be concrete object types:

```ts
submitTestEvidence: fsm.submit<{
  command: string;
  passed: boolean;
  outputSummary: string;
}>({
  to: 'finalReport',
});
```

Avoid top-level primitives or top-level unions. Wrap them in object fields:

```ts
type Decision = { kind: 'pass' } | { kind: 'fail'; reason: string };

decide: fsm.submit<{ decision: Decision }>({ to: 'routeDecision' });
```

### Reducers

Use `reduce` to commit durable data. Reducers are synchronous and receive a
mutable draft:

```ts
reduce: (draft, payload) => {
  draft.testPassed = payload.passed;
  draft.testSummary = payload.outputSummary;
}
```

### Effects

Use `effect` for external validation or work that must finish before the reducer
commits. If the effect throws, the transition is rejected.

```ts
effect: ({ payload }) => {
  if (payload.outputSummary.trim().length === 0) {
    throw new Error('outputSummary must not be empty');
  }
}
```

### Routed Submits

Use routed submits when the payload decides the next state:

```ts
submitTestEvidence: fsm.submit<{
  command: string;
  passed: boolean;
  outputSummary: string;
}>({
  route: [
    {
      if: (_data, payload) => payload.passed,
      to: 'finalReport',
      reduce: recordTestEvidence,
    },
    {
      if: (data) => data.repairAttempts < data.maxRepairAttempts,
      to: 'repair',
      reduce: recordTestEvidence,
    },
    {
      to: 'failed',
      reduce: recordTestEvidence,
    },
  ],
});
```

### Route Rules

- declare either `to` or `route`, not both;
- `route` has at least two branches;
- every non-last branch has `if` and `to`;
- the last branch omits `if` and acts as the catch-all;
- branch predicates are synchronous and run before that branch reducer;
- routed submits put `effect`, `reduce`, and `actions` on branches, not at the
  top level.

## Owner Interaction

### Deterministic Choices

Use `fsm.choice(...)` when the owner should pick one of the authored labels.
Choice states are deterministic graph nodes. The label routes the FSM; it does
not mutate data by itself.

```ts
ownerApproval: fsm.choice({
  question: (data) =>
    ['Approve this plan for implementation?', '', data.plan ?? '(missing plan)'].join('\n'),
  options: [
    { label: 'Approve', to: 'implement' },
    { label: 'Request changes', to: 'revisePlan' },
  ],
});
```

If you need to record the owner choice in `Data`, route to a state that records
it, or use separate states whose prompts and submits capture the durable value.

### Open States

Use open states when free-form discussion is intentionally part of the workflow:

```ts
revisePlan: fsm.state({
  mode: 'open',
  prompt:
    'Ask the owner for requested changes to the plan. Submit a revisedPlan that addresses the feedback.',
  on: {
    submit: fsm.submit<{ ownerReply: string; revisedPlan: string }>({
      to: 'ownerApproval',
      reduce: (draft, payload) => {
        draft.ownerReply = payload.ownerReply;
        draft.plan = payload.revisedPlan;
      },
    }),
  },
});
```

### Model Clarifications

Model-originated Codex `request_user_input` prompts are different. They can ask
for ad hoc clarification inside a state, but the reply is not an FSM transition.
The model must still submit a typed exit when the state is done.

## Reports And Artifacts

### Terminal Outcomes

Use `fsm.final(...)` for terminal outcomes. Most serious FSMs should have both a
success terminal and a failure terminal if failure is a valid outcome of the
workflow contract.

### Final Artifacts

Final artifacts are the normal way to write run reports:

```ts
done: fsm.final({
  outcome: 'success',
  artifacts: {
    'coding-smoke-report.md': renderCodingSmokeReport,
  },
});
```

Artifact renderers are synchronous and receive readonly data. If an artifact
needs asynchronous work, put that work in an explicit state before the final.

Standalone runs use final `outcome` and artifacts. Embedded child FSMs may also
use `final({ output })` so the parent can consume typed final outputs.

## Fresh Context, Models, And Skills

### State Models

Use `model` when a state should run under a specific Codex model or effort:

```ts
review: fsm.state({
  model: { name: 'gpt-5.1-codex', effort: 'high' },
  prompt: 'Review the requested change and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'repair' }),
  },
});
```

### Clearing Context

Use `clearOnEntry` when entering a non-initial state should behave like `/clear`
before the next Codex turn. The model conversation context is discarded, but the
FSM data remains available to prompts, reducers, route predicates, and final
artifacts.

```ts
implementation: fsm.state({
  clearOnEntry: true,
  prompt: 'Implement the approved plan in a fresh thread and submit test evidence.',
  on: {
    implemented: fsm.submit<{ summary: string }>({ to: 'test' }),
  },
});
```

`clearOnEntry: true` clears context and starts the next state from the original
launch working directory. `clearOnEntry: { cwd }` clears context and starts that
state in a specific existing absolute directory. The `cwd` may be a string or a
function of data. Run directories, event logs, and final artifacts remain
anchored to the original launch directory.

State-level model declarations are sticky across non-clear states. If a state
sets `model` and later non-clear states omit `model`, Codex keeps the previously
effective model and effort. The sticky setting ends when another state declares
a new `model`, or when `clearOnEntry` clears context and starts a fresh thread.
A clear state without `model` uses Codex's user-configured default model and
effort for that working directory; a clear state with `model` applies those
explicit settings to the fresh thread. See
[`reference.md`](./reference.md#state-options) for exact validation rules and
Codex catalog behavior.

### State Skills

Skills guide Codex inside a state. They do not own process truth.

During startup
preflight, aharness resolves each state skill reference. When that state starts a
Codex turn, aharness sends the state orientation text plus the selected skill
items in `turn/start.input`; it does not paste `SKILL.md` into the state prompt.

```ts
review: fsm.state({
  skills: [fsm.skill.path('../skills/reviewing-code/SKILL.md')],
  prompt: 'Review the change and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});
```

Use `fsm.skill('reviewing-code')` to select one enabled Codex catalog skill by
name. Use `fsm.skill.path('../skills/reviewing-code/SKILL.md')` to select a
specific bundled skill. Add `{ optional: true }` only when the workflow can still
run correctly if that skill is unavailable.

Selected state skills are deduped by resolved path within the live thread.
`clearOnEntry` starts a fresh context, so the active state's selected skills may
be sent again in the new thread.

### Available Skills

Use state `skills` for skills selected on that state turn. Use top-level
`availableSkills` for package- or repository-owned skill roots that should be
discoverable during the run but not automatically injected. For example for subagents:

```ts
export default fsm.machine({
  id: 'package-workflow',
  availableSkills: [
    fsm.skill.dir('../skills'),
    fsm.skill.path('../support/review/SKILL.md'),
  ],
  initial: 'review',
  states: {
    review: fsm.state({
      skills: [fsm.skill.path('../skills/reviewing-code/SKILL.md')],
      prompt: 'Review the change and submit findings.',
      on: {
        reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

State skills accept name-form and `SKILL.md` path-form refs. Top-level
`availableSkills` accepts path-form and dir-form refs. Dir-form refs are not
valid in state `skills`.

`availableSkills` does not select a skill for a state by itself. It contributes
skill roots to the run so bundled skills can be discovered, while the state
`skills` array decides what the active turn receives.

## Composition And Runtime Events

### Embedded FSMs

Use `fsm.embed(...)` when a subprocess has its own state tree, input contract,
and final outputs. Do not embed only because the parent graph is large.

```ts
spec: fsm.embed(child, {
  input: (data) => ({ topic: data.topic }),
  on: {
    shipped: {
      to: 'done',
      reduce: (draft, output) => {
        draft.shippedTopic = output.topic;
      },
    },
    failed: { to: 'router' },
  },
});
```

The parent projection must satisfy the child input declaration, and the `on` map
must cover the child final ids exactly.

Embed-host states are exclusive. Do not add prompt, entry, state skills, or raw
XState behavior to the same state that hosts `fsm.embed(...)`. The parent should
consume the child's typed final outputs, not reach into the child's internal
states.

### Built-In Events

Built-in runtime events can also live in a state `on` map:

- `permissionRequest`
- `preToolUse`
- `postToolUse`
- `userPromptSubmit`

Use them when repository policy should intercept Codex activity while a state is
active:

```ts
review: fsm.state({
  prompt: 'Review the implementation and submit the report.',
  on: {
    permissionRequest: {
      match: '^Bash$',
      route: [
        {
          if: (_data, payload) => payload.command?.startsWith('pnpm test') === true,
          return: () => 'acceptForSession',
        },
        { return: () => 'delegate' },
      ],
    },
    submit: fsm.submit<{ report: string }>({ to: 'done' }),
  },
});
```

`match` is a delivery prefilter, not workflow logic. Put workflow decisions in
branch `if` predicates.

`aharness_submit` and Codex `request_user_input` are not delivered through
`preToolUse` or `postToolUse`. Do not write hook policy that expects those events
to be intercepted there.

### Custom Events

Use `fsm.withEvents(...)` and `fsm.event(...)` only for advanced typed runtime
inputs that are not model submits, owner choices, or built-in hook events.

`fsm.event<Payload>()` declares a signal event. `fsm.event<Payload, Return>({
defaultReturn })` declares a request event; the default is returned if the active
state has no matching handler or a selected handler fails before returning.

Event handlers can update data without leaving the state by omitting `to`. Event
names share the state's `on` map with submit exits, so avoid collisions with
submit names, built-in hook event names, and generated `SUBMIT__*`, `AWAIT__*`,
or `OWNER_CHOICE__*` prefixes.

## Verify, Visualize, Run, Inspect

### Verify

Always verify before running:

```bash
aharness verify ./workflow.fsm.ts
```

Verification fails before Codex starts. It checks graph reachability, terminal
reachability, submit schemas, exit targets, route shape, embedded final wiring,
skill placement, hook placement, model declarations, and other authoring
invariants. Fix verifier errors directly; do not work around generated
`SUBMIT__*`, `AWAIT__*`, or `OWNER_CHOICE__*` keys.

### Visualize

Use visualization to inspect the graph without starting Codex:

```bash
aharness visualize ./workflow.fsm.ts
```

### Run

Use `run` for a live foreground run:

```bash
aharness run [--ask|--yolo] [--no-open] ./workflow.fsm.ts [--<input-flag> <value>]...
```

`--ask` restores manual user/browser review for approval prompts. `--yolo`
bypasses approval prompts and grants broad filesystem access; use it only when
that risk is intentional. `--no-open` serves and prints the browser UI URL
without launching a separate browser window.

### View

Use recorded inspection after a run:

```bash
aharness view [run-id]
```

With no run id, `view` opens the newest recorded run. View mode is read-only; it
does not start Codex, a live thread, hooks, or the FSM actor.

### Run Artifacts

Every live run writes artifacts under `.aharness/runs/<runId>/`. Treat that
directory as sensitive. `events.jsonl` is canonical runtime evidence and can
contain raw owner input, browser replies, tool arguments and results, command
output, file diffs, approval data, token usage, sub-thread activity, and workflow
context snapshots. For browser transcript visibility rules, see
[`run-event-visibility.md`](./run-event-visibility.md).

## Common Authoring Mistakes

- Starting from API primitives instead of the workflow contract.
- Creating a state for every checklist item, command, or skill paragraph.
- Letting the model narrate transitions instead of submitting typed exits.
- Using owner free text as an implicit transition instead of `fsm.choice` or an
  open state plus typed submit.
- Sending normal uncertainty to terminal failure when the workflow promised
  autonomous recovery.
- Storing the same durable fact in multiple places.
- Relying on model memory instead of FSM data.
- Writing top-level primitive submit payloads instead of object-shaped payloads.
- Making routed submits without a final catch-all branch.
- Putting `clearOnEntry` on the initial state or an initially reachable state.
- Copying full skill bodies into every state prompt instead of selecting state
  skills or writing concise prompts.
- Assuming `availableSkills` selects a skill for the active state. It only adds
  skill roots; state `skills` performs selection.
- Putting workflow gates only in skill text instead of encoding them as states,
  routes, choices, or final outcomes.
- Expecting `preToolUse` or `postToolUse` to intercept `aharness_submit` or Codex
  `request_user_input`.
- Duplicating reference-level option details in prompts or docs instead of
  linking to the public reference.

## Where To Read Next

Start with the real example:

- [`examples/coding-smoke.fsm.ts`](../examples/coding-smoke.fsm.ts) shows plan,
  owner approval, implementation, tests, repair, success/failure finals, and a
  report artifact.
- [`examples/README.md`](../examples/README.md) gives the recommended example
  path.
- [`examples/DEMOS.md`](../examples/DEMOS.md) catalogs focused mechanism demos.

Use the public docs as the source of truth for adjacent details:

- [`reference.md`](./reference.md) for complete SDK, CLI, package, graph, and
  verifier details.
- [`architecture.md`](./architecture.md) for the Codex/aharness runtime boundary.
- [`troubleshooting.md`](./troubleshooting.md) for setup, verify, input, skill,
  approval, and artifact failures.
- [`run-event-visibility.md`](./run-event-visibility.md) for browser transcript
  visibility policy.
- [`../packages/core/SUPPORTED_CODEX.md`](../packages/core/SUPPORTED_CODEX.md)
  for the Codex CLI compatibility gate.
