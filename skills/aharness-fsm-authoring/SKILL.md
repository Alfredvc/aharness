---
name: aharness-fsm-authoring
description: Author, review, verify, and package general @aharness/core finite state machines. Use when Codex needs to design or write an aharness FSM for any workflow, convert an informal process into typed states and transitions, choose between strict/open/choice/passive/embed/final states, create or review installable aharness FSM packages, or diagnose aharness FSM verifier and authoring errors.
---

# aharness FSM Authoring

## Core Rule

Author the FSM from the workflow the user asked for. Do not import assumptions from an unrelated task, hard-code hidden answers, or choose a prebuilt process shape unless the user's workflow actually has that shape.

aharness controls deterministic process flow. The model performs bounded language, coding, inspection, or judgment work inside the active state and advances only through declared typed exits.

Start from the workflow contract: what the runtime must supervise, remember,
route, recover from, or stop on. Do not automatically convert checklist items,
recipe lines, command runs, or ordinary skill judgment into states.

## Authoring Workflow

1. Identify the workflow goal, success criteria, workflow mode, and terminal
   success/failure outcomes.
2. Separate deterministic control from model work:
   - Deterministic: states, transition topology, schemas, guards, attempt caps, artifacts, terminal outcomes.
   - Model work: reading, drafting, summarizing, implementing, judging ambiguity, asking the owner.
3. Decide which facts or activities need runtime visibility because they route,
   decide, collect evidence, coordinate an actor, recover, clear stale context,
   or supervise a boundary.
4. Sketch the smallest state graph that enforces the process. Name states and exits in domain terms.
5. Define FSM data: durable facts, counters, decisions, artifacts inputs, and outputs needed by later states.
6. Choose state mechanisms:
   - `fsm.state` for normal model work.
   - strict mode for aharness-driven progress.
   - open mode for owner-paced discussion.
   - `fsm.choice` when the owner should make a deterministic labeled decision.
   - `fsm.passive` for deterministic or invoked XState behavior with no model prompt.
   - `fsm.embed` for reusable child machines.
   - `fsm.final` for terminal success or failure.
   - `withEvents`/`fsm.event` only when an advanced FSM has typed runtime inputs that are not ordinary submits, owner choices, or built-in hook events.
7. Audit every path to `blocked` or `failed`: make sure it is a true terminal outcome for the requested workflow, or encode the recovery/owner-input policy that should happen first.
8. Author with the canonical `createFsm` API.
9. Run `aharness verify <file.fsm.ts>` and fix verifier errors directly.
10. If the user asked to execute the aharness, run `aharness run <file.fsm.ts>` and inspect the run artifacts.

## Design Checklist

Before writing the file, answer these in the FSM itself or in brief notes:

- What are the terminal success and failure outcomes?
- What workflow mode is promised: autonomous, owner-paced, orchestration, verification, discussion, or something else?
- What state stores each durable decision?
- Which state owns each owner interaction?
- Which proposed states need runtime visibility, and which checklist items can stay inside broader state work?
- Which transitions need typed payloads?
- Which branch conditions are deterministic guards rather than model prose?
- What artifacts should be written at the end?
- What can go wrong, and where does the graph route that blocker before terminal failure?
- If the FSM wraps an existing skill, what judgment stays inside the skill-guided state instead of moving into the parent graph?
- What durable evidence is required to resume after a clear or a later run?
- What verification command or manual evidence proves the FSM is valid for the workflow?

## Canonical Surface

Use the current `createFsm` surface for new FSMs:

- `createFsm<Data>()`
- `fsm.machine({ id, input?, data?, availableSkills?, threadSkills?, initial, states })`
- `fsm.state({ mode?, main?, prompt, on?, entry?, model?, clearOnEntry?, guidance?, skills?, xstate? })`
- `fsm.submit<TPayload>({ to, effect?, reduce?, actions? })`
- `fsm.submit<TPayload>({ route: [...] })`
- `fsm.choice({ question, options, main? })`
- `fsm.final({ outcome, main?, output?, artifacts? })`
- `fsm.passive({ main?, ...xstate }?)`
- `fsm.embed(child, { input, on })`
- `fsm.input.string`, `fsm.input.number`, `fsm.input.path`, `fsm.input.custom`, `fsm.input.values`
- `fsm.skill(name)`, `fsm.skill.path(path)`, and `fsm.skill.dir(path)`
- `fsm.withEvents({ eventName: fsm.event<...>() })` for advanced typed runtime events

Lower-level `aharness.machine`, `state`, `exit`, `terminal`, `final`,
`passive`, `arg`, `embed`, and `skill` are compatibility escape hatches. Do
not use them for new FSMs unless the canonical surface cannot express the
behavior.

## Minimal Skeleton

```ts
import { createFsm } from '@aharness/core';

interface Data {
  topic: string;
  accepted: boolean | null;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'workflow',
  input: {
    topic: fsm.input.string({ description: 'Workflow topic' }),
  },
  data: ({ input }) => ({
    topic: input.topic,
    accepted: null,
  }),
  initial: 'review',
  states: {
    review: fsm.state({
      prompt: (data) => `Review ${data.topic} and submit whether it is accepted.`,
      on: {
        decide: fsm.submit<{ accepted: boolean }>({
          route: [
            {
              if: (_data, payload) => payload.accepted,
              to: 'done',
              reduce: (draft, payload) => {
                draft.accepted = payload.accepted;
              },
            },
            {
              to: 'failed',
              reduce: (draft, payload) => {
                draft.accepted = payload.accepted;
              },
            },
          ],
        }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
    failed: fsm.final({ outcome: 'failure' }),
  },
});
```

## Workflow Contract And Topology

Start by naming what the runtime must supervise, remember, route, recover from,
clear, coordinate, or stop on. Also name the workflow mode: autonomous,
owner-paced, verification gate, orchestration flow, discussion, or another
explicit contract.

Promote work into the graph only when a separate runtime-visible state is
needed because:

- the workflow must route differently after the work;
- a durable decision or evidence bundle must be recorded;
- a different actor, model, worktree, or tool policy owns the phase;
- stale conversation history must be discarded before the next phase;
- a known blocker class needs explicit recovery or retry policy;
- a subprocess has its own lifecycle and typed final outputs.

For each proposed state, check:

```text
What workflow contract requirement makes this state runtime-visible?
What durable data or output does a later state consume?
Could this be ordinary work inside a broader state without losing a gate?
Is every terminal path from this state consistent with the workflow mode?
```

For every path to `blocked` or `failed`, check:

```text
Is this a true terminal outcome for the requested workflow?
If owner input is required, is owner input part of the workflow contract?
If recovery is expected, where is that policy encoded?
If direct failure is expected, what safety or contract reason justifies it?
```

Recovery is a design answer, not a universal requirement. Autonomous workflows
often need recovery before terminal failure. Other workflows may correctly stop
and report as soon as a required precondition is missing.

## State Mechanisms

Use strict stateful states when aharness should keep driving the model until it
submits a typed result. This is the default `fsm.state` behavior.

Use `mode: 'open'` when owner-paced free-form discussion is intentionally part
of the workflow. Owner text does not advance the FSM directly; the model must
interpret the discussion and submit a typed exit.

Use `fsm.choice` when the owner should make a deterministic labeled decision.
Choice states are first-class graph nodes. Each option label is an authored
route and does not mutate data by itself.

Use model-originated Codex `request_user_input` only for ad hoc clarification
inside state work. The reply is not an FSM transition; the model must still
submit a typed exit.

Use `fsm.passive` for deterministic or invoked XState behavior with no model
prompt or submit exits.

Use `fsm.final` for terminal outcomes. Serious FSMs usually need both success
and failure finals when failure is a valid workflow outcome.

Use `fsm.embed` when a subprocess has its own state tree, input contract, and
final outputs. Do not embed only because the parent graph is large.

Use `main: true` sparingly on states, passive states, choices, and finals that
form the primary visual graph spine. It is visualization-only metadata and
does not affect runtime behavior, transition legality, or verification.

## Submits, Routes, Reducers, And Effects

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

Do not use top-level object unions. Wrap the union in a field:

```ts
type Decision = { kind: 'pass' } | { kind: 'fail'; reason: string };
fsm.submit<{ decision: Decision }>({ to: 'route' });
```

Direct submits go straight to one target:

```ts
save: fsm.submit<{ result: string }>({
  to: 'done',
  reduce: (draft, payload) => {
    draft.result = payload.result;
  },
});
```

Routed submits branch from payload and data:

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

Reducers receive mutable draft data. They must be synchronous. They may mutate
`draft` or return a partial data object.

Effects receive read-only `data`, the submitted `payload`, and `ops`. Use them
for external work that must complete before reducer commit. There is no
fire-and-forget effect API. `AharnessOps` is currently a reserved empty facade;
fresh context controls are declarative via `model` and `clearOnEntry`, not
`ops.clear()`.

## Data, Inputs, And Artifacts

Use `data` for durable FSM state: decisions, counters, evidence, selected
paths, summaries, owner decisions, terminal report text, and anything later
states or final artifacts consume. Do not rely on model memory for workflow
state.

Use nullable fields when a fact can legitimately be unknown:

```ts
interface Data {
  currentPlanPath: string | null;
  testPassed: boolean | null;
  repairAttempts: number;
}
```

Root `input` declarations become kebab-case CLI flags:

```ts
export default fsm.machine({
  input: {
    topic: fsm.input.string({ description: 'Project topic' }),
    rounds: fsm.input.number({ default: 3 }),
    planPath: fsm.input.path({
      default: './PLAN.md',
      complete: 'file',
    }),
    mode: fsm.input.string({
      default: 'observe',
      complete: fsm.input.values(['observe', 'strict']),
    }),
  },
  data: ({ input }) => ({ topic: input.topic, rounds: input.rounds }),
  // ...
});
```

Only the root FSM exposes CLI flags. Embedded child inputs are satisfied by the
parent `fsm.embed(...).input` projection.

Use final artifacts for run reports. Artifact renderers are synchronous and
receive read-only data:

```ts
done: fsm.final({
  outcome: 'success',
  artifacts: {
    'aharness-report.md': (data) => renderReport(data),
  },
});
```

If asynchronous artifact work is needed, put it in an explicit state before the
final.

## Fresh Context, Models, And Guidance

Use `model` to declare per-state model and effort overrides:

```ts
review: fsm.state({
  model: { name: 'gpt-5.1-codex', effort: 'high' },
  prompt: 'Review with high effort and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});
```

`model` can include `name`, `effort`, or both. Allowed efforts are `none`,
`minimal`, `low`, `medium`, `high`, and `xhigh`. Omit `model` on a non-clear
state to keep the previously effective settings.

Use `clearOnEntry` on a live, non-initial and not initially reachable state
when entering should discard prior thread context while preserving FSM data:

```ts
implementation: fsm.state({
  clearOnEntry: { cwd: (data) => data.worktreePath },
  model: { effort: 'high' },
  prompt: 'Implement in the worktree and submit test evidence.',
  on: {
    implemented: fsm.submit<{ summary: string }>({ to: 'test' }),
  },
});
```

`clearOnEntry: true` starts a replacement thread in the original aharness
launch working directory. Object-form `cwd` must resolve to a non-empty
absolute path for an existing directory. Do not set `clearOnEntry` on the first
state or any state active during initial startup through an always transition.

Use `guidance` only when the default strict-state drive-forward reminder is
wrong for the state. It is stop guidance, not a replacement for state `prompt`.

## Skills In FSMs

Skills guide Codex inside a state. They do not own process truth.

Use state `skills` to select skills for the active state turn:

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
specific bundled skill. Add `{ optional: true }` only when the workflow can
still run correctly if that skill is unavailable.

Use top-level `availableSkills` for package- or repository-owned skill roots
that should be discoverable during the run but not automatically injected:

```ts
export default fsm.machine({
  id: 'package-workflow',
  availableSkills: [fsm.skill.dir('../skills'), fsm.skill.path('../support/review/SKILL.md')],
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

State `skills` accepts name-form and `SKILL.md` path-form refs. Top-level
`availableSkills` accepts path-form and dir-form refs. Machine-level
`threadSkills` accepts keyed name-form and `SKILL.md` path-form refs for
managed sidecar threads. Dir-form refs are not valid in state `skills` or
`threadSkills`. Name-form refs are not valid in `availableSkills`.

Use `threadSkills` only when author code will start managed Codex sidecar
threads and needs stable first-turn skill aliases:

```ts
export default fsm.machine({
  id: 'sidecar-workflow',
  threadSkills: {
    reviewer: fsm.skill('reviewing-code'),
    subjectHelper: fsm.skill.path('../skills/subject-helper/SKILL.md'),
  },
  initial: 'review',
  states: {
    review: fsm.state({
      prompt: 'Review the subject and submit findings.',
      on: {
        reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

`initialSkills` passed to a sidecar thread must reference `threadSkills` keys.
Do not put raw `{ type: 'skill' }` items in sidecar `send(...)` input; aharness
injects verified sidecar skill items from `initialSkills`.

If the FSM wraps an existing skill or prose workflow, keep the FSM focused on
durable gates, routing, recovery policy, outputs, and terminal boundaries. Let
skill guidance own ordinary in-phase judgment unless the workflow contract
requires aharness to supervise that judgment as separate runtime states.

## Sidecar Ops

Use sidecar threads when the FSM needs scoped auxiliary Codex work that should
not become the active parent thread or change the FSM graph. Sidecars reuse the
run's single Codex app-server and WebSocket connection. They do not receive
`aharness_submit`; they return typed boundaries to author code.

Use `ops.codex` only from entry/effect callbacks, and use `ops.emit(...)` to
route sidecar results through declared typed events:

```ts
import { createFsm, type CodexSidecarBoundaryResult } from '@aharness/core';

interface Data {
  requestId?: string;
  questionId?: string;
}

const base = createFsm<Data>();
const fsm = base.withEvents({
  sidecarDone: base.event<{ result: CodexSidecarBoundaryResult }>(),
});

export default fsm.machine({
  id: 'sidecar-example',
  threadSkills: {
    helper: fsm.skill.path('../skills/helper/SKILL.md'),
  },
  data: () => ({}),
  initial: 'start',
  states: {
    start: fsm.state({
      prompt: 'Start the sidecar.',
      entry: async (_data, ops) => {
        const thread = await ops.codex.createThread('helper', {
          initialSkills: ['helper'],
          defaultTurnTimeoutMs: 120_000,
          instructions: { developer: 'Stay focused on the helper task.' },
        });
        const result = await thread.send('Inspect the target and report one finding.');
        await ops.emit('sidecarDone', { result });
        if (!result.ok || result.kind === 'completed') {
          await thread.close();
        }
      },
      on: {
        sidecarDone: {
          route: [
            {
              if: (_data, payload) => payload.result.ok && payload.result.kind === 'completed',
              to: 'done',
            },
            {
              if: (_data, payload) => payload.result.ok && payload.result.kind === 'needsInput',
              to: 'answer',
              reduce: (draft, payload) => {
                if (payload.result.ok && payload.result.kind === 'needsInput') {
                  draft.requestId = payload.result.request.id;
                  draft.questionId = payload.result.request.questions[0]?.id;
                }
              },
            },
            { to: 'failed' },
          ],
        },
      },
    }),
    answer: fsm.state({
      prompt: 'Resume the sidecar after its input request.',
      entry: async (data, ops) => {
        if (data.requestId === undefined || data.questionId === undefined) return;
        const thread = ops.codex.thread('helper');
        const result = await thread.answer(data.requestId, {
          [data.questionId]: 'Use the repository README as the source of truth.',
        });
        await ops.emit('sidecarDone', { result });
        if (!result.ok || result.kind === 'completed') {
          await thread.close();
        }
      },
      on: {
        sidecarDone: {
          route: [
            {
              if: (_data, payload) => payload.result.ok && payload.result.kind === 'completed',
              to: 'done',
            },
            { to: 'failed' },
          ],
        },
      },
    }),
    done: fsm.final({ outcome: 'success' }),
    failed: fsm.final({ outcome: 'failure' }),
  },
});
```

`send()` and `answer()` return `{ ok: true, kind: 'completed' }`,
`{ ok: true, kind: 'needsInput' }`, or `{ ok: false, reason: ... }`. Failure
reasons are `timeout`, `interrupted`, `thread_closed`, `app_server_closed`, and
`error`. `needsInput` is sidecar `request_user_input` evidence only; it does
not create owner-input controls. Sidecar command, file, permission, and MCP
elicitation approvals can still appear as normal browser approval cards
according to the run approval mode. Close sidecars when done; `close()` is
idempotent.

## Composition

Use `fsm.embed(child, { input, on })` when a child process has its own state
tree and final outputs:

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
- Embedded states cannot also declare `prompt`, `entry`, `skills`, or `xstate`.
- Child final ids must not contain dots or start with `xstate.`
- If a reusable child lives in a separate `.fsm.ts` file, import it and embed it from the parent.
- If a same-file embedded child has submit exits, keep the child machine expression textually inside the parent embed host.
- Parent states should consume child final outputs, not inspect child internals or duplicate child counters.

## Hooks And Custom Events

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

`match` is a hook-source delivery prefilter, not workflow logic. Use branch
`if` predicates for workflow decisions. `aharness_submit` and
`request_user_input` do not reach `preToolUse` or `postToolUse`.

Use `withEvents` only when an advanced FSM has a typed runtime input that is
not a model submit, owner choice, or built-in hook event:

```ts
const base = createFsm<Data>();
const fsm = base.withEvents({
  testsFinished: base.event<{ passed: boolean; outputPath: string }>(),
  approval: base.event<{ command?: string }, 'acceptForSession' | 'delegate'>({
    defaultReturn: 'delegate',
  }),
});
```

Signal events use `fsm.event<TPayload>()` and cannot return a value. Request
events use `fsm.event<TPayload, TReturn>({ defaultReturn })`; if no active
handler returns a value, the default is returned. Event handlers and event
route branches may omit `to` for internal data updates without state exit or
re-entry.

## Runtime Contract

The runtime starts one Codex `app-server`, registers one parent-thread dynamic
tool named `aharness_submit`, and uses per-state orientation messages to tell
the model the current state, valid exits, and submit data schema. Managed
sidecar threads reuse that same app-server/WebSocket connection, do not receive
`aharness_submit`, and appear as compact sidecar run evidence instead of parent
FSM topology.

Programmatic callers outside FSM source can import `startAharnessRun` from
`@aharness/core/runtime`. It is a sibling live-run surface to `aharness run`
with the same target resolution, verifier, single Codex `app-server`, single
aharness WebSocket client, XState actor, reply handling, approval dispatch,
hook dispatch, and local run artifacts. It defaults to no browser UI, but can
serve the same run-scoped UI when requested. User `.fsm.ts` source must still
import only from the root `@aharness/core`; do not import
`@aharness/core/runtime` from FSM source.

Model submit shape:

```json
{ "state": "review", "exit": "decide", "data": { "accepted": true } }
```

The dispatcher:

1. Rejects off-state submits.
2. Rejects undeclared exits.
3. Validates `data` against the submit JSON Schema extracted from the TypeScript payload type.
4. Dry-runs the XState transition.
5. Runs canonical effects and reducers.
6. Flushes run evidence before success reply.
7. Starts the next turn with the next state's orientation for cross-state transitions.

The model cannot advance the FSM by narrating a transition. A successful typed
submit or owner choice is required.

Each live run writes artifacts under `.aharness/runs/<runId>/`. Treat run
directories as sensitive: `events.jsonl` can contain raw owner input, browser
replies, tool arguments and results, command output, file diffs, approval data,
permission data, MCP elicitation data, cancellation reasons, token usage,
sub-thread activity, and workflow context snapshots.

## CLI Use

- New FSM package scaffolds: `aharness init --dir <path>`.
- Static validation: `aharness verify <file.fsm.ts>`.
- Visual graph inspection: `aharness visualize <file.fsm.ts> [--<input-flag> <value>]`.
- Run an FSM: `aharness run [--ask|--yolo] [--no-open] <file.fsm.ts|command> [--<input-flag> <value>]`.
- Local FSM input help: `aharness run <file.fsm.ts> --help`.
- Recorded run inspection: `aharness view [run-id]`.
- Environment checks: `aharness doctor`.
- Optional shell setup: `aharness completion install` and `aharness completion uninstall`.

Runtime flags such as `--ask`, `--yolo`, and `--no-open` go before the run
target. FSM input flags go after it:

```bash
aharness run --ask ./workflow.fsm.ts --fixture-root ./fixture
```

Use `--no-open` when aharness should serve and print the browser UI URL without
launching a separate system browser window.

`aharness view [run-id]` is read-only recorded inspection. With no run id, it
opens the newest recorded run. It does not start Codex, an app-server, hooks, a
live thread, or the FSM actor. Topology recovery imports recorded FSM source on
a best-effort basis and has the same import-time trust boundary as `verify` and
`run`.

## Verifier Posture

`aharness verify` is the source of truth for the full check set. Design so the
graph is reachable, every live state can eventually reach a final state,
submit payloads are object-shaped and schema-resolvable, embedded finals are
wired, skills are well-formed, model declarations are valid, and hook/event
placement is legal.

When verification fails, fix the reported issue directly. Do not work around
the verifier or hand-write generated `SUBMIT__*`, `AWAIT__*`, or
`OWNER_CHOICE__*` handlers.

## Footguns

- Do not convert every checklist item, implementation task, command, or review note into a state without a runtime-visible reason.
- Do not rely on model memory for state. Store durable decisions in FSM data.
- Do not put verification only in prose. Encode required gates as typed states, transitions, and artifacts.
- Do not send ordinary uncertainty to terminal failure when the workflow promised autonomous recovery.
- Do not set `clearOnEntry` on the first state or any state active during initial startup.
- Do not hard-code subagent use, command ordering, or retry shape unless the workflow contract requires that strategy.
- Do not use raw `xstate` unless the canonical surface cannot express the behavior.

## References

Read [fsm-packages.md](references/fsm-packages.md) when creating, reviewing, or diagnosing installable aharness FSM packages.
