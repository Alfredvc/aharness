# FSM Authoring And Review Lessons From The Recipe Runner

> Status: Source notes for improving `harness-fsm-authoring` and for designing
> a future FSM review skill. Captured from the attempt to author
> `fsms/superpowers-recipe-runner.fsm.ts` for
> `docs/plans/2026-05-27-superpowers-fsm-package-implementation-recipe.md`.

## Purpose

This document records what we learned while trying to author a Harness FSM that
finishes a multi-slice implementation recipe. The first versions technically
verified, but they were not good Harness designs. They over-modeled ordinary
agent work as state transitions, treated recoverable uncertainty as terminal
failure, and missed that hierarchy should be used for reusable recovery flows.

The goal is to feed these lessons back into:

- `harness-fsm-authoring`, so future authoring starts with the right design
  questions.
- A possible `harness-fsm-review` skill, so reviews catch topology and workflow
  fit issues, not only verifier errors.

## Context

The user wanted an FSM that could finish this recipe:

`docs/plans/2026-05-27-superpowers-fsm-package-implementation-recipe.md`

The recipe itself is a durable control file for a sliced implementation:

1. confirm or write the detailed plan for the current slice
2. execute only the current slice
3. review the completed slice
4. run final verification
5. update the recipe to the next slice/chunk and commit

The user emphasized two workflow requirements:

- Clear context routinely, especially after generating the detailed plan and
  after completing each slice.
- The FSM should finish the recipe autonomously. It should not depend on user
  supervision when a normal implementation phase gets stuck.

The first authoring attempt violated the spirit of both requirements in subtle
ways.

## Core Lesson

Harness should control process boundaries, not micromanage all work inside a
phase.

The model can perform bounded language work, coding work, inspection, command
execution, and judgment inside a single state. Harness transitions should
represent durable workflow decisions and gates:

- a slice has been oriented
- a detailed plan exists
- implementation is ready for review
- review passed or found blocking issues
- verification passed or failed
- the slice was finished and committed
- recovery was attempted and either succeeded or exhausted its budget

Harness transitions should not represent every internal subtask unless the
workflow genuinely needs the runtime to supervise those subtasks as separate
protocol states.

## Skill-To-FSM Conversion Lessons

Converting an existing skill into an FSM is likely to be a common adoption path.
Users already know the skill name and phases, so the FSM package should preserve
that vocabulary while moving enforcement into the graph.

The useful split is:

- top-level `SKILL.md`: a short compatibility map for humans who know the old
  skill
- FSM topology: durable process control, gates, recovery paths, outputs, and
  failure boundaries
- state prompt: the immediate assignment, current data, and typed exit
  discipline
- state guide: concise phase-level operating guidance for work inside one state

The top-level `SKILL.md` should not be the runtime source of truth once a
Harness FSM exists. Its purpose is to say: "this familiar workflow now lives in
this command, and these old phases correspond to these FSM states." It can also
provide a short manual fallback for environments where Harness is unavailable.

### State guides, not mini-skills by default

When cutting up an existing skill, do not call every piece a standalone skill.
Most pieces are state guides or prompt fragments because they are meaningful
only inside one FSM state. Reserve "skill" for guidance that is independently
discoverable and reusable outside that exact state.

Good state guide examples:

- design conversation guidance for a `designConversation` state
- spec writing and self-review guidance for a `writeAndReviewSpec` state
- plan authoring guidance for a `planAuthoring` state
- plan quality review guidance for a `planQualityGate` state

Good standalone skill candidates are narrower reusable methods that can serve
multiple workflows, such as spec self-review or plan quality review, but only if
they are intended to be loaded independently by name.

### Do not load the full legacy skill in every state

Repeatedly attaching the full original skill to multiple states teaches the
wrong pattern. It suggests the FSM is a skill loader with transitions. The
better example is that the FSM owns the workflow contract and each state loads
only the guidance needed for that phase.

The Superpowers package now demonstrates this shape:

```text
skills/superpowers/brainstorming/SKILL.md
skills/superpowers/brainstorming/guides/design-conversation.md
skills/superpowers/brainstorming/guides/write-and-review-spec.md

skills/superpowers/writing-plans/SKILL.md
skills/superpowers/writing-plans/guides/plan-authoring.md
skills/superpowers/writing-plans/guides/plan-quality-review.md
```

The package FSMs reference guide files by path, not the top-level `SKILL.md`.
The package README explains that top-level skill files are maps, while guides
describe how to work inside a state.

### Review questions for converted skills

When reviewing a skill-to-FSM conversion, ask:

1. Does the FSM enforce the workflow gates, or does critical control still live
   only in prose?
2. Does the top-level `SKILL.md` act as a short map and fallback, or is it still
   a long process driver?
3. Are state guides short and phase-specific?
4. Is any guide trying to define transitions, approvals, retries, or terminal
   outcomes that belong in the FSM?
5. Are one-off state fragments being promoted to standalone skills without
   independent reuse?
6. Do package tests or verifier coverage prove bundled guide paths resolve?
7. Do docs show users how to migrate a skill without teaching them to duplicate
   the full skill across states?

Red flags:

- multiple states load the same full top-level `SKILL.md`
- the FSM prompt says "follow the skill" instead of naming concrete state work
  and typed exits
- the state guide contains hidden gates that the FSM does not encode
- every phase becomes a separate "mini-skill" even when it is not reusable
- users cannot see how familiar skill phases map to FSM state names

## What Went Wrong In The Initial Design

### 1. The recipe checklist was copied into topology too literally

The first FSM expanded the recipe into many hard states:

- `readRecipe`
- `workspaceCheck`
- `confirmSliceBoundary`
- `ensureDetailedPlan`
- `taskContextRefresh`
- `implementTask`
- `taskSelfReview`
- `sliceImplementationSummary`
- `reviewSlice`
- `fixReviewFindings`
- `verifySlice`
- `repairVerificationFailure`
- `applyRecipeUpdate`
- `stageSliceChanges`
- `commitSlice`
- `postCommitRefresh`

This treated the recipe as a state-machine specification. It is not. The recipe
is a durable handoff/control file. It describes work that an agent should do,
but not every line in the recipe deserves a Harness state.

The over-modeled area was the execution loop:

`taskContextRefresh -> implementTask -> taskSelfReview -> taskContextRefresh`

That forced a Harness transition for every plan task. The detailed plan should
own task order. The FSM should let the model execute the slice plan internally
and submit one typed result when the slice is ready for review.

### 2. Preflight states duplicated each other

`readRecipe`, `workspaceCheck`, and `confirmSliceBoundary` all asked the model
to re-ground on the same materials:

- recipe
- roadmap
- current detailed plan
- git status
- current slice boundary

Those should be one broader `orientSlice` state. The durable output is simple:

- roadmap path
- current slice
- current plan path or `null`
- last completed marker or `null`
- slice summary
- workspace summary

If orientation cannot complete, that should trigger autonomous recovery, not a
separate owner decision state by default.

### 3. Post-verification was split into too many hard gates

The first design had:

`applyRecipeUpdate -> stageSliceChanges -> commitSlice -> postCommitRefresh`

The recipe does need these activities, but the FSM does not need four states
for them. The important deterministic rule is:

> Finishing a slice is unreachable until review and verification have passed.

Once that is true, updating the recipe, staging only owned files, and committing
can be one broad `finishSlice` state with a typed payload:

- summary
- recipe update summary
- staged files
- commit SHA
- next slice or `null`

### 4. `blocked` was treated as an ordinary branch

The first reduced topology still had many exits to a terminal `blocked` state.
That was wrong for an autonomous recipe runner.

A `blocked` or `failed` final should mean:

- the workflow attempted recovery
- the recovery attempt budget was exhausted
- the remaining problem requires external state or a user decision outside the
  promised autonomous workflow

It should not mean:

- the model is unsure
- a file is missing
- the plan is stale
- verification setup is unclear
- git status is messy
- the model needs to re-read source material

Those are recovery scenarios.

### 5. Owner interaction was introduced where autonomy was required

`workspaceOwnerDecision` used `ask`, which makes sense for workflows that need
owner-paced decisions. It does not fit an autonomous recipe finisher.

If unrelated dirty files exist, the autonomous runner should:

- identify them
- avoid staging or reverting them
- continue if they do not overlap the slice
- enter recovery if overlap or ownership is unclear

Only the final exhausted recovery state should report that external user input
is required.

## Better Topology

The reviewed topology should be closer to this:

```text
orientSlice
  -> planSlice
  -> executeSlice
  -> reviewSlice
  -> repairSlice
  -> verifySlice
  -> repairSlice
  -> finishSlice
  -> clearForNextSlice
  -> orientSlice / planSlice

any normal phase that cannot proceed
  -> recover (embedded reusable recovery FSM)
  -> resumeAfterRecovery
  -> originating phase

recover exhausted
  -> failed

recipe complete
  -> complete
```

The exact return from `clearForNextSlice` can be either `orientSlice` or
`planSlice` depending on how much orientation it performs. If `clearForNextSlice`
already re-reads the recipe, roadmap, git status, and plan, returning directly
to `planSlice` is reasonable. If it only clears and confirms minimal state, it
should return to `orientSlice`.

## What Should Be A Hard Gate

### Keep: planning gate

`planSlice` should be a hard gate because execution should not begin until a
bounded plan exists.

The state should not implement the plan. It should write or confirm a plan and
submit:

- `planPath`
- whether it was written or merely confirmed
- summary
- verification commands

### Keep: execution complete gate

`executeSlice` should be broad. It may do many tasks internally. It should
submit only when implementation is ready for review:

- summary
- changed files
- completed plan items
- documentation update status
- local check summary

This state is a good place for `clearOnEntry: true`, because stale planning
context is a real risk and the implementation phase benefits from a fresh
thread that re-reads the recipe and plan.

### Keep: review gate

`reviewSlice` should remain a hard gate. It is one of the clearest reasons to
use Harness:

- approved with no blocking findings -> verification
- blocking findings -> repair
- cannot review -> recovery

The route condition should not trust `approved: true` alone. It should also
check that `blockingFindings.length === 0`.

### Keep: verification gate

`verifySlice` should remain a hard gate:

- passed -> finish
- failed commands -> repair
- cannot set up or determine verification -> recovery

Verification failure is not the same as recovery failure. A failed test usually
routes to `repairSlice`, not to recovery. Recovery is for cases where the gate
itself cannot be executed or interpreted.

### Keep: finish gate

`finishSlice` should be a hard gate because it crosses a durable boundary:

- recipe update
- staging
- commit
- next slice selection

This can be one state. It should not be split unless there are separate
deterministic decisions that the parent graph must enforce.

### Keep: clear-for-next-slice gate

`clearForNextSlice` should be explicit and should use `clearOnEntry: true`.
This state exists because stale context after a committed slice is a real
workflow risk. It should re-read the recipe and roadmap before continuing.

## What Should Not Be A Hard Gate

### Do not gate every implementation task

The detailed plan can contain tasks, but the FSM does not need:

- select next task
- implement task
- self-review task
- clear
- repeat

That turns the FSM into a task runner. It increases transition count without
improving the workflow guarantee. The useful guarantee is that the slice as a
whole is reviewed and verified before finishing.

### Do not gate every command

The FSM should not require a transition after every local check. A broad state
can run several commands, inspect output, fix issues, and submit one summary.

### Do not turn normal uncertainty into terminal failure

Missing plan, unclear git status, stale docs, failed verification setup, and
ambiguous recipe state should route to recovery. Terminal failure should be
reserved for recovery exhaustion or safety caps.

### Do not add owner `ask` for autonomous workflows

If the stated goal is autonomous execution, owner input should not be a normal
path. Owner interaction can be part of a separate owner-paced workflow, but not
the default recipe runner.

## Recovery Design

### Recovery should be hierarchical

Recovery logic is cross-cutting. It should not be duplicated inside every
parent phase. The parent should set recovery context and enter one reusable
embedded child FSM.

Parent data should include:

- `recoveryPhase`
- `recoveryReason`
- `recoveryEvidence`
- `recoveryGuidance`
- `maxRecoveryAttempts`

The child should own:

- attempt counter
- fresh context between attempts where verifier-safe
- recovery prompt
- recovered vs retry vs exhausted
- final output with attempts, summary, and changed files

Parent routing after recovery should be deterministic:

```text
recover.recovered -> resumeAfterRecovery -> original phase
recover.exhausted -> failed
```

The parent can implement `resumeAfterRecovery` as a passive router over
`recoveryPhase`.

### Recovery guidance must be phase-specific

Generic "try again" is not enough. Each phase needs concrete recovery
instructions:

- `orient`: reconcile recipe and roadmap, inspect recent commits, separate
  unrelated dirty files from slice-owned files.
- `plan`: generate or repair the bounded current-slice plan from roadmap and
  recipe.
- `execute`: re-read the detailed plan and continue with the smallest
  current-slice fix that removes the blocker.
- `review`: reconstruct the intended diff and review basis from plan, roadmap,
  and git diff.
- `verify`: derive commands from the plan and roadmap, fix slice-owned setup
  problems, rerun focused checks.
- `repair`: re-read the last review or verification failure and preserve the
  failed gate.
- `finish`: re-check git status, stage only slice-owned files plus recipe,
  follow commit conventions.
- `clear-next`: re-read committed recipe state and confirm the next slice.

### Recovery is not repair

`repairSlice` handles known review or verification findings.

`recover` handles the inability to run a parent phase correctly:

- missing or stale source material
- inconsistent recipe and roadmap
- missing detailed plan
- unclear verification commands
- git/index state that prevents safe finishing
- lost context after clear
- no recorded repair source

### Recovery exhaustion is the true failure boundary

The parent should have very few direct paths to failure. A normal phase should
submit `needsRecovery`, not `blocked`. The recovery child should try up to a
configured cap. Only then should the parent enter `failed`.

There may still be non-recovery terminal failures for deterministic safety
limits, such as `maxIterations` exhausted. Those should be explicit and rare.

## Clear Semantics Lessons

### Use clear where stale context is a real workflow risk

Good clear points for this workflow:

- entering `executeSlice` after `planSlice`
- entering `clearForNextSlice` after a committed slice
- possibly inside recovery retry attempts, but only if verifier constraints are
  satisfied

Bad clear points:

- every internal task
- every review finding
- every command
- states that are active during initial startup

### `clearOnEntry` cannot be initially active

The verifier rejects `clearOnEntry` on states active during initial startup. In
the recovery child attempt, this failed:

```text
prepareAttempt (initial passive) -> attemptRecovery (clearOnEntry)
```

Even though `attemptRecovery` was not the declared initial state, the verifier
treated it as active during startup because the initial passive state had an
always transition to it.

Implications:

- Do not rely on an initial passive state to hop into a clear state.
- A child recovery machine's first attempt likely cannot clear using
  `clearOnEntry` if it is reached immediately at child startup.
- If fresh context is needed before recovery, consider making the parent
  recovery embed state itself reachable only after a non-self transition that
  causes the normal state nudge, or design the child with a first no-clear
  attempt and clear only on retry attempts.
- The authoring skill should explicitly warn that "initially reachable" includes
  always-transition targets, not only the declared `initial` state.

### Clear is not a substitute for state design

The first version used frequent clear points to compensate for too much
topology. That is backwards. First choose the smallest graph that enforces the
process. Then add clear only where stale conversation context threatens the
next phase.

## Embedded FSM Lessons

### Same-file embedded child machines must preserve the host state path

When the recovery child machine was defined as a top-level same-file machine and
then embedded from the parent, parent verification failed with:

```text
per-state-data-schema-resolvable (recover.attemptRecovery):
submit exit 'recover.attemptRecovery::recovered' has no schema sidecar entry
```

The sidecar extractor can prefix submit schemas for embedded children imported
from separate `.fsm.ts` modules. A top-level same-file child machine does not
carry the parent host state in its AST path, so its submit schemas are extracted
under `attemptRecovery` while the loaded embedded runtime state is
`recover.attemptRecovery`.

Two verified authoring shapes now matter:

- Separate child file: import the child FSM and embed it from the parent. The
  loader prefixes child sidecar entries with the host state.
- Same file: place the child `recovery.machine({ ... states ... })` expression
  directly inside the parent `recover: parent.embed(...)` state initializer. The
  recovery state's AST path then includes `recover`, so sidecar extraction emits
  `recover.attemptRecovery` and the verifier passes.

Implications:

- Separate child files are still the clearest shape when the child is reused in
  multiple parent files.
- If the user wants parent and child in one file, avoid a top-level child
  machine constant with submit exits. Nest the child machine expression directly
  at the embed host.
- The review skill should flag same-file embedded children whose state calls are
  not textually underneath the embed host state.

### Parent output from child finals is the right contract

The child recovery FSM should emit final outputs such as:

- phase
- attempts
- summary
- changed files

The parent should reduce that into durable parent data and route based on the
child final id. This is cleaner than having parent states inspect child internals
or duplicate recovery counters.

## Open vs Strict Mode

Open mode is not the answer for autonomous work. Open mode is for owner-paced
discussion where the runtime should not drive repeated turns.

For autonomous implementation:

- use normal strict states
- give broad but bounded prompts
- require one typed submit at the phase boundary
- route failures into recovery

Use `ask` only when owner text is intentionally part of the workflow. In the
autonomous recipe runner, normal owner decisions should not appear.

## Data Contract Lessons

### Use nullable fields for not-yet-written artifacts

The current recipe can say:

```text
Current detailed plan: not yet written
```

Therefore `currentPlanPath` must be `string | null`, not `string`.

The same applies to `lastCompleted`, `commitSha`, and `nextSlice`.

### Avoid duplicate sources of truth

An earlier design recorded `nextSlice` in one state and asked for it again in a
later state. That creates drift. A slice finisher should produce the next slice
once, and later states should either consume that durable value or recompute it
from disk in a clearly named refresh/orientation phase.

### Record enough evidence to resume after clear

Every phase boundary should store durable summaries that survive a fresh thread:

- current slice
- current plan path
- changed files
- verification commands
- review summary
- verification summary
- next slice
- commit SHA
- recovery phase/reason/evidence/guidance

But avoid storing internal minutiae that turn the parent data into a transcript.

## Review Skill Requirements

A future FSM review skill should not only ask "does it verify?" It should review
the shape of the workflow.

### Required review questions

1. What is the external workflow goal?
2. Which states are true durable process gates?
3. Which states merely describe work that could happen inside a broader state?
4. Are terminal failure paths reserved for unrecoverable outcomes?
5. If the workflow must be autonomous, does every normal blocker route to
   recovery before failure?
6. Are owner `ask` states used only where owner input is a real requirement?
7. Are clear points justified by stale-context risk?
8. Does any `clearOnEntry` state become active during initial startup?
9. Are embedded subprocesses used for repeated lifecycle patterns?
10. Does parent data contain durable facts without duplicating child internals?
11. Are typed payloads concrete and aligned with the actual recipe/artifact
    state, including nullable values?
12. Are there duplicate sources of truth for next slice, commit, plan path, or
    verification commands?

### Red flags

- Many direct transitions to `blocked` or `failed`.
- A terminal failure reachable from ordinary uncertainty.
- A task-by-task implementation loop where the detailed plan could own task
  order.
- Separate states for activities that do not require different deterministic
  routing.
- `ask` in a workflow described as autonomous.
- `clearOnEntry` on initial or initially reachable states.
- Inline embedded child FSMs with their own submit exits.
- Parent topology duplicating the same recovery loop in multiple places.
- Payload fields that cannot represent real recipe values such as "not yet
  written."

### Severity calibration

Important issues:

- over-granular topology that changes workflow ergonomics
- direct blocked/failure paths without recovery in autonomous workflows
- owner interaction in autonomous workflows
- missing or wrong clear boundaries
- child schema extraction failures
- impossible payload contracts

Medium issues:

- duplicated orientation prompts
- duplicated next-slice data
- overly broad parent data
- lack of phase-specific recovery guidance

Minor issues:

- naming that is understandable but not domain-aligned
- report artifact formatting
- redundant summaries that do not affect routing

## Proposed Updates To `harness-fsm-authoring`

The authoring skill should add a pre-authoring topology check:

1. Identify the durable gates. If a proposed state does not store a durable
   decision, own an owner interaction, enforce a gate, clear stale context, or
   embed a reusable subprocess, consider folding it into a broader state.
2. For autonomous workflows, design recovery before terminal failure. Count
   direct paths to failure. If most normal states can fail directly, the graph is
   probably wrong.
3. Prefer broad strict states for autonomous work. Use open mode only for
   owner-paced discussion.
4. Use hierarchy for repeated subprocesses such as recovery, review loops,
   approval loops, and branch finishing.
5. Check clear points after graph design. Do not use clear to compensate for
   excessive topology.
6. Verify that `clearOnEntry` is not on an initial or initially reachable state.
7. For embedded child FSMs with submit exits, either use a separate child file
   or keep the child machine expression textually inside the parent embed host.
8. Make nullable data explicit when source documents can say "not yet written,"
   "none," or "not selected."

The authoring skill should also add a "blocked path audit":

```text
For every path to blocked/failed:
  - Is this a true terminal outcome?
  - Has recovery been attempted?
  - Is there an attempt cap?
  - Does the model have enough guidance and durable evidence to recover?
  - If this requires owner input, is owner input part of the requested workflow?
```

## Recommended Skill Split

### Keep in `harness-fsm-authoring`

The authoring skill should include concise guidance for:

- smallest state graph
- hard gates vs model work
- clear placement
- recovery-before-failure for autonomous workflows
- hierarchy for reusable subprocesses
- verifier constraints that affect authoring

### Add a separate `harness-fsm-review` skill

The review skill should be used when:

- reviewing a newly authored FSM
- evaluating whether a workflow is over-modeled
- checking autonomous recovery behavior
- checking clear placement
- checking embedded-child contracts
- checking typed payload contracts against real docs

It should produce findings in this order:

1. workflow/topology issues
2. autonomy and recovery issues
3. clear/hierarchy issues
4. typed data and verifier/API issues
5. ordinary style/documentation issues

This matters because an FSM can pass `harness verify` and still be a poor
workflow design.

## Checklist For Future Recipe Runner FSMs

Before writing:

- What must the FSM finish without owner input?
- What are the true terminal success and failure conditions?
- What recovery attempts should happen before failure?
- What is the maximum recovery attempt budget?
- Where does stale model context create real risk?
- Which subprocesses are repeated enough to embed?
- What data must survive clear?

During authoring:

- Keep the parent topology close to recipe-level gates.
- Use one broad implementation state per slice.
- Use review and verification as hard gates.
- Route unknown blockers to a recovery child.
- Do not introduce `ask` unless the workflow explicitly needs owner text.
- Keep same-file child machines textually inside their parent embed host when
  they have submit exits.

During review:

- Count direct failure paths.
- Count states that only restate previous prompts.
- Look for task-runner topology.
- Check whether recovery has enough context and phase-specific guidance.
- Verify `clearOnEntry` constraints.
- Run `harness verify` on parent and reusable child FSMs.
- Run typecheck if the FSM directory is included in the TypeScript project.

## Recovery Clear Follow-up From This Session

The recovery-child draft showed this standalone verifier issue:

```text
clearOnEntry-not-initial (attemptRecovery):
state 'attemptRecovery' declares clearOnEntry but is active during initial startup
```

The chosen resolution was to remove `clearOnEntry` from the first recovery
attempt and add a separate `refreshForRetry` state with `clearOnEntry: true`.
The first attempt starts without a clear, and only later retry attempts enter
the fresh-clear checkpoint. That preserves bounded autonomous recovery without
putting `clearOnEntry` on an initially reachable state.

## Summary

The main lesson is that Harness authoring is not about making every workflow
sentence a transition. It is about making the important workflow guarantees
explicit while leaving bounded work inside states.

For autonomous long-running development workflows, the design center should be:

- broad strict phase states
- hard gates for review, verification, and durable finishing
- explicit clear points where stale context is dangerous
- reusable hierarchical recovery with attempt caps
- terminal failure only after recovery exhaustion

That combination gives Harness control over the process without turning the
model into a button-pusher between dozens of tiny states.
