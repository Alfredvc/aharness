# FSM Authoring Reference

Use this when writing a real `@aharness/core` FSM. This reference reflects the current `createFsm` API, not the older lower-level primitive style.

## Table Of Contents

- [Canonical Surface](#canonical-surface)
- [Advanced Escape Hatches](#advanced-escape-hatches)
- [Workflow Contract And Topology](#workflow-contract-and-topology)
- [Control-Plane FSMs Around Skills](#control-plane-fsms-around-skills)
- [Choosing States](#choosing-states)
- [Submit Rules](#submit-rules)
- [Custom Typed Events](#custom-typed-events)
- [Data, Effects, And Artifacts](#data-effects-and-artifacts)
- [Inputs](#inputs)
- [CLI Commands](#cli-commands)
- [Composition](#composition)
- [Hooks And Approvals](#hooks-and-approvals)
- [Runtime Contract](#runtime-contract)
- [Verifier Posture](#verifier-posture)
- [Footguns](#footguns)

## Canonical Surface

Use:

```ts
import { createFsm } from '@aharness/core';

interface Data {
  result: string | null;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'example',
  initial: 'work',
  data: () => ({ result: null }),
  states: {
    work: fsm.state({
      prompt: 'Do the work and submit the result.',
      on: {
        submit: fsm.submit<{ result: string }>({
          to: 'done',
          reduce: (draft, payload) => {
            draft.result = payload.result;
          },
        }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

Normal public API:

- `createFsm<Data>()`
- `fsm.machine({ id, input?, data?, initial, states })`
- `fsm.state({ mode?, main?, prompt, on?, entry?, model?, clearOnEntry?, guidance?, skills?, xstate? })`
- `fsm.submit<TPayload>({ to, effect?, reduce?, actions? })`
- `fsm.submit<TPayload>({ route: [...] })`
- `fsm.choice({ question, options })`
- `fsm.event<TPayload>()`
- `fsm.event<TPayload, TReturn>({ defaultReturn })`
- `fsm.withEvents({ eventName: fsm.event<...>() })`
- `fsm.final({ outcome, main?, output?, artifacts? })`
- `fsm.passive({ main?, ...xstate }?)`
- `fsm.embed(child, { input, on })`
- `fsm.input.string`, `number`, `path`, `custom`, `values`
- `fsm.skill(name)` and `fsm.skill.path(path)`

Lower-level `aharness.machine`, `state`, `exit`, `terminal`, `final`, `passive`, `arg`, `embed`, and `skill` remain compatibility escape hatches. Do not use them for new FSMs unless you intentionally need a lower-level behavior.

## Advanced Escape Hatches

Most FSMs should stay on the canonical `createFsm` surface above. Reach for these exports only for advanced tooling, tests, migration work, or a behavior the canonical API cannot express cleanly.

- Lower-level primitives: `aharness.machine`, `state`, `exit`, `terminal`, `final`, `passive`, `arg`, `embed`, `skill`.
- Artifact/event helpers: `writeArtifact` and `appendEventEntry`. Prefer `fsm.final({ artifacts })` for normal run reports.
- Run and snapshot helpers: `deriveRunId`, `ensureRunDir`, `fsmHash6`, `loadSnapshot`. Normal runs create fresh run directories automatically.
- Introspection helpers: `iterStates`, `getAharnessMeta`, `stateKeyPath`. Use these for analyzers or custom tooling, not ordinary workflow logic.
- Owner-input provider types and mock queues are for tests and aharness integration boundaries, not ordinary FSM source.

## Workflow Contract And Topology

Start by naming the workflow contract, not the expected implementation recipe.
The contract says what the runtime must supervise, remember, route, recover
from, clear, coordinate, or stop on. It also says whether the workflow is
autonomous, owner-paced, a verification gate, an orchestration flow, or a
discussion.

Promote work into the graph when a separate runtime-visible state is needed for
one of these reasons:

- The workflow must route differently after the work.
- A durable decision or evidence bundle must be recorded.
- A different actor, model, worktree, or tool policy owns the phase.
- Stale conversation history must be discarded before the next phase.
- A known class of blocker needs an explicit recovery or retry policy.
- A subprocess has its own lifecycle and typed final outputs.

Do not automatically promote checklist items, recipe lines, command runs, or
ordinary skill judgment into states. A broad state may read several files, run
several commands, fix issues, and submit one typed result when command-level
routing is not part of the workflow contract.

Before authoring, perform this topology check:

```text
For each proposed state:
  - What workflow contract requirement makes it runtime-visible?
  - What durable data or output does a later state consume?
  - Could this be ordinary work inside a broader state without losing a gate?
  - Is any terminal path from this state consistent with the workflow mode?
```

For every path to `blocked` or `failed`, audit the terminal policy:

```text
For every path to blocked/failed:
  - Is this a true terminal outcome for the requested workflow?
  - If owner input is required, is owner input part of the workflow contract?
  - If recovery is expected, where is that policy encoded?
  - If direct failure is expected, what safety or contract reason justifies it?
```

Recovery is a design answer, not a universal requirement. Autonomous workflows
often need recovery before terminal failure. Other workflows may correctly stop
and report as soon as a required precondition is missing.

## Control-Plane FSMs Around Skills

When converting an existing skill or prose workflow into an FSM, keep the FSM
focused on the workflow contract. Let skill guidance own ordinary in-phase
judgment unless the contract explicitly requires aharness to supervise that
judgment as separate runtime states.

Good conversion shape:

- Top-level skill file: a short map from familiar skill phases to FSM states
  and a manual fallback when aharness is unavailable.
- FSM topology: durable gates, routing, recovery policy, outputs, and terminal
  boundaries.
- State prompt: the immediate assignment, current data, and typed submit
  discipline.
- State guide: concise phase-level guidance for work inside one state.

Avoid copying a full legacy skill into every state prompt. Avoid turning every
phase fragment into a standalone skill unless it is independently reusable
outside that exact FSM state.

If a parent prompt prescribes a strategy such as subagents, a fixed command
order, or a review/fix loop shape, make sure that strategy is part of the
workflow contract rather than an artifact of one prior run.

## Choosing States

Use strict stateful states when the aharness should keep driving the model until it submits a typed result.

Use open stateful states when owner-paced discussion is the intended behavior and the aharness should not drive repeated turns.

Use `fsm.choice` when the owner should make a deterministic labeled decision.
Choice states are first-class graph nodes and each option label is an authored
route.

Use open stateful states when free-form owner discussion is intentionally part
of the workflow. The owner text does not advance the FSM directly; the model
must submit a typed exit after interpreting the discussion.

In an autonomous workflow, owner input should not be a normal path unless the
contract explicitly says that autonomy stops at that decision.

Use passive states for deterministic or invoked behavior that should not expose a model prompt or submit exits.

Use final states for terminal outcomes. Every branch of the graph should be able to reach a final state.

Use embedded machines when a subprocess has its own lifecycle and typed final
outputs, especially when several parent phases share the same child lifecycle.
Do not embed only because the parent graph is large; first check whether the
subprocess has an independent contract.

Use `main: true` sparingly on states, passive states, and finals that form the
primary graph spine. This is visualization-only metadata: acyclic marked paths
become the dominant top-to-bottom graph path, while marked loops render as main
feedback edges and cannot all point downward. It does not affect runtime
behavior, transition legality, or verification of workflow correctness. Leave
recovery, exception, and control states unmarked unless they are genuinely part
of the primary story.

## Submit Rules

Payload types must be concrete object types:

```ts
fsm.submit<{ changedFiles: string[]; passed: boolean }>({ to: 'verify' });
```

Do not use top-level primitive payloads:

```ts
// Bad
fsm.submit<string>({ to: 'done' });

// Good
fsm.submit<{ value: string }>({ to: 'done' });
```

Do not use top-level object unions. Wrap the union in a field if needed:

```ts
type Decision = { kind: 'pass' } | { kind: 'fail'; reason: string };
fsm.submit<{ decision: Decision }>({ to: 'route' });
```

Direct submit:

```ts
save: fsm.submit<{ result: string }>({
  to: 'done',
  effect: async ({ data, payload }) => {
    await recordResult(data, payload);
  },
  reduce: (draft, payload) => {
    draft.result = payload.result;
  },
});
```

Routed submit:

```ts
checked: fsm.submit<{ passed: boolean; output: string }>({
  route: [
    { if: (_data, payload) => payload.passed, to: 'done', reduce: recordCheck },
    { to: 'repair', reduce: recordCheck },
  ],
});
```

Route constraints:

- Declare either `to` or `route`, not both.
- `route` has at least two branches.
- Every non-last route branch has `if` and `to`.
- The last branch omits `if` and is the catch-all.
- Routed submits do not allow top-level `effect`, `reduce`, or `actions`; put them on each branch.
- Branch predicates are synchronous and see current data before the branch reducer runs.

Ordering:

- Route predicates run first.
- The selected branch `effect` runs and is awaited.
- The selected branch `reduce` runs synchronously.
- If `effect` throws, the transition fails before reducer commit or state entry.

## Custom Typed Events

Use `withEvents` when an advanced FSM has a typed runtime input that is not a model submit, owner choice, or built-in hook event. If the workflow can be expressed with `fsm.submit`, `fsm.choice`, `permissionRequest`, `preToolUse`, `postToolUse`, or `userPromptSubmit`, prefer those higher-level surfaces.

```ts
const base = createFsm<Data>();
const fsm = base.withEvents({
  testsFinished: base.event<{ passed: boolean; outputPath: string }>(),
  approval: base.event<{ command?: string }, 'acceptForSession' | 'delegate'>({
    defaultReturn: 'delegate',
  }),
});

review: fsm.state({
  prompt: 'Review the implementation.',
  on: {
    testsFinished: {
      route: [{ if: (_data, payload) => payload.passed, to: 'done' }, { to: 'fixTests' }],
    },
    approval: {
      reduce: (draft, payload) => {
        draft.lastCommand = payload.command ?? null;
      },
      return: (_data, payload) =>
        payload.command?.startsWith('pnpm test') ? 'acceptForSession' : 'delegate',
    },
  },
});
```

Signal events use `fsm.event<TPayload>()` and cannot return a value. Request events use `fsm.event<TPayload, TReturn>({ defaultReturn })`; if no active handler returns a value, the default is returned. Event handlers and event route branches may omit `to` for internal data updates without state exit or re-entry.

Event keys share a state's collision domain with submit/await exit names, built-in hook names, generated `SUBMIT__*`/`AWAIT__*` keys, embedded final events, and raw `xstate.on` keys.

## Data, Effects, And Artifacts

Use `data` for durable FSM state. The runtime also adds framework fields such as visit counts and last owner reply internally.

For resumable workflows, store the durable facts needed to route after a clear
or later run: current phase, selected artifact paths, review summaries,
verification evidence, current fix source, commit identifiers, and recovery
summaries. Do not store transcript-level minutiae unless later routing or final
artifacts consume it.

Use nullable fields when source artifacts can legitimately say "not yet
written", "none", "not selected", or equivalent:

```ts
interface Data {
  currentPlanPath: string | null;
  lastCompletedCommit: string | null;
  nextSlice: string | null;
}
```

Avoid duplicate sources of truth. Store a fact once, then consume that durable
value or recompute it in a clearly named refresh/orientation state.

Reducers receive mutable draft data. They must be synchronous. They may mutate `draft` or return a partial data object.

Effects receive read-only data and payload plus `ops`. They are for external work that must complete before commit. There is no fire-and-forget effect API.

`AharnessOps` is currently a reserved empty facade. Fresh context controls are
declarative via `model` and `clearOnEntry`, not `ops.clear()`.

Use `model` to declare per-state model and effort overrides:

```ts
implement: fsm.state({
  model: { name: 'gpt-5.1-codex', effort: 'high' },
  prompt: 'Implement the approved change and submit test evidence.',
  on: {
    implemented: fsm.submit<{ summary: string }>({ to: 'verify' }),
  },
});

highEffort: fsm.state({
  model: { effort: 'high' },
  prompt: 'Review with higher reasoning effort.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});

reviewWorktree: fsm.state({
  clearOnEntry: { cwd: '/absolute/path/to/worktree' },
  model: { name: 'gpt-5.1-codex', effort: 'high' },
  prompt: 'Review this worktree and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});
```

`model` can include `name`, `effort`, or both. Omit `model` on a non-clear state
to keep the previously effective settings.

Use `clearOnEntry` on a live, non-initial and not initially reachable state when
entering should discard prior thread context. Boolean form keeps the working
directory at the original launch CWD:

```ts
freshStart: fsm.state({
  clearOnEntry: true,
  model: { name: 'gpt-5.1-codex' },
  prompt: 'Start this phase from a replacement thread.',
  on: {
    started: fsm.submit<{ summary: string }>({ to: 'done' }),
  },
});
```

Use function-form `cwd` for worktree and multi-project workflows where the
directory comes from machine data:

```ts
packageWork: fsm.state({
  clearOnEntry: { cwd: (data) => data.packageDir },
  prompt: 'Work in the package directory and submit a summary.',
  on: {
    changed: fsm.submit<{ summary: string }>({ to: 'done' }),
  },
});
```

`cwd` must resolve to a non-empty absolute path for an existing directory. The
aharness run directory, snapshots, event logs, and artifacts remain anchored to
the original launch directory. `model.name` and `model.effort` must be static
declarations. Allowed efforts are `none`, `minimal`, `low`, `medium`, `high`, and
`xhigh`.

"Initially reachable" includes targets reached through initial passive states
or always transitions. Do not rely on an initial passive state to hop into a
clear state. If a recovery child needs fresh context, make the first attempt
no-clear and route retries through a later clear state, or enter the child only
after a non-initial parent transition.

Use final artifacts for run reports:

```ts
done: fsm.final({
  outcome: 'success',
  artifacts: {
    'aharness-report.md': (data) => renderReport(data),
  },
});
```

Artifact renderers are synchronous and receive read-only data. If asynchronous artifact work is needed, put it in an explicit `fsm.passive` state before the final.

## Inputs

Root `input` declarations become CLI flags:

```ts
export default fsm.machine({
  input: {
    topic: fsm.input.string({ description: 'Project topic' }),
    rounds: fsm.input.number({ default: 3 }),
    planPath: fsm.input.path({ default: './PLAN.md', complete: 'file' }),
  },
  data: ({ input }) => ({ topic: input.topic, rounds: input.rounds }),
  // ...
});
```

Only the root FSM exposes CLI flags. Embedded child inputs are satisfied by the parent `fsm.embed(...).input` projection.

## CLI Commands

Use `aharness verify <file.fsm.ts>` for the static gate and `aharness <file.fsm.ts> [--<flag> <value>]` to run. Root `input` fields become kebab-case CLI flags.

Use `aharness init --dir <path>` when scaffolding a standalone FSM project, `aharness doctor` for local Codex/runtime diagnostics, and `aharness completion install` or `aharness completion uninstall` for optional shell completion setup.

## Composition

Use `fsm.embed(child, { input, on })` when a child process has its own state tree and final outputs:

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

Rules:

- The `on` map exactly covers child final ids. No missing or extra keys.
- The input projection must satisfy the child input declaration.
- Embedded states cannot also declare `prompt`, `ask`, `entry`, `skills`, or `xstate`.
- Child final ids must not contain dots or start with `xstate.`
- If a reusable child lives in a separate `.fsm.ts` file, import it and embed it from the parent.
- If a same-file embedded child has submit exits, keep the child machine expression textually inside the parent embed host. A top-level same-file child machine constant can produce schema sidecar paths that do not match the embedded runtime state path.
- Parent states should consume child final outputs, not inspect child internals or duplicate child counters.

## Hooks And Approvals

Built-in hook events live under state `on`:

- `permissionRequest`
- `preToolUse`
- `postToolUse`
- `userPromptSubmit`

Example:

```ts
review: fsm.state({
  prompt: 'Review implementation.',
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
    submit: fsm.submit<{ accepted: boolean }>({ to: 'done' }),
  },
});
```

`match` is a hook-source delivery prefilter, not workflow logic. Use branch `if` predicates for workflow decisions.

`aharness_submit` and `request_user_input` do not reach `preToolUse` or `postToolUse`; matchers targeting those names are inert.

## Runtime Contract

The runtime starts one Codex `app-server`, registers one dynamic tool named `aharness_submit`, and uses per-state orientation messages to tell the model the current state, valid exits, and submit data schema.

Model submit shape:

```json
{ "state": "review", "exit": "decide", "data": { "accepted": true } }
```

The dispatcher:

1. Rejects off-state submits.
2. Rejects undeclared exits.
3. Validates `data` against the sidecar JSON Schema extracted from the TypeScript payload type.
4. Dry-runs the XState transition.
5. Runs canonical effects and reducers.
6. Flushes snapshot and event log before success reply.
7. Starts the next turn with the next state's orientation for cross-state transitions.

The model cannot advance the FSM by narrating a transition. A successful typed submit or await resolution is required.

## Verifier Posture

`aharness verify` is the source of truth for the full check set. Design so the graph is reachable, every live state can eventually reach a final state, submit payloads are object-shaped and schema-resolvable, awaits are unambiguous, embedded finals are wired, and skills resolve from the FSM's filesystem context.

When verification fails, fix the reported issue directly instead of trying to work around the verifier. Do not hand-write generated `SUBMIT__*` or `AWAIT__*` handlers.

## Footguns

- Do not put workflow-specific policy in the SDK. Put it in the FSM prompt, data, route predicates, reducers, and artifacts.
- Do not present observations from one workflow as universal topology rules.
- Do not convert every checklist item, implementation task, command, or review note into a state without a runtime-visible reason.
- Do not replace a working skill's in-phase judgment with a longer parent prompt unless the workflow contract requires runtime supervision.
- Do not rely on model memory for state. Store durable decisions in FSM data.
- Do not put verification only in prose. Encode required gates as typed states, transitions, and artifacts.
- Do not use owner-yield, `ask`, or direct owner decisions as normal paths where unattended execution is required.
- Do not send ordinary uncertainty to terminal failure when the workflow promised autonomous recovery.
- Do not set `clearOnEntry` on the first state or any state active during initial startup through an always transition.
- Do not hard-code subagent use, command ordering, or retry shape unless the workflow contract requires that strategy.
- Do not use raw `xstate` unless the canonical surface cannot express the behavior.
