# Project FSMs

This directory holds project-local aharness FSMs that are not package commands.

## `recipe-driven-development.fsm.ts`

Generic replacement for the recipe-driven development skill. It takes an
implementation roadmap, creates a recipe, and then implements the roadmap
slice-by-slice until every slice is committed:

1. read the roadmap, identify required grounding files, and create the
   implementation recipe
2. confirm or write the current slice plan
3. clear context and review the current slice plan
4. clear context before executing the reviewed plan
5. clear context to accept the completed diff, repair when needed, and verify
6. update the recipe, stage only slice-owned files plus the recipe, and commit
7. clear context, re-read the recipe, and repeat from the next slice until the
   roadmap is complete

Routine phase blockers do not go straight to terminal failure. Each phase routes
through fix cycles or an autonomous recovery protocol with phase-specific
guidance, then returns to the failed phase after recovery. The first review for
each plan version always uses two xhigh reviewers. Reviewers then choose the
follow-up review shape for the next plan-fix proof: none, one or two medium
reviewers, one or two xhigh reviewers, or replanning. Plan-review fixes must
submit proof-of-fix evidence for the selected follow-up path; when reviewers ask
for no follow-up review, the FSM proceeds from plan fix to execution after the
proof is recorded. The plan-review budget still counts stalled prior-blocker
cycles, not productive rounds that resolve old findings and uncover new ones.
Slice acceptance still uses the default fix-cycle budget of 3. Before the FSM
reaches the failed final, it passes through a failure handoff state that records
the terminal blocker in the current detailed plan, or in the recipe if no
detailed plan exists, so a later run can restart from durable context. The FSM
reaches failure only when the plan-review stall budget or slice fix-cycle budget
is exhausted, recovery is exhausted, or the slice safety cap is hit.

Live workflow states declare `gpt-5.5` with medium reasoning effort. Recovery
attempts declare `gpt-5.5` with xhigh effort, and the implementation/review
prompts require delegated implementation subagents to use `gpt-5.5` with high
effort. Plan review and slice acceptance start in fresh parent threads so review
work is not biased by planning or implementation context. Plan-review prompts
keep the initial plan review at two xhigh reviewers, then follow the
reviewer-selected follow-up mode for later proof checks.

The first state stores required context files such as idea files, specs,
architecture docs, parent plans, API contracts, and migration notes. Later
states and recovery prompts include that list so the model can reload the
grounding context instead of recovering from the roadmap alone.


Run it with an explicit roadmap path:

```sh
aharness fsms/recipe-driven-development.fsm.ts --roadmap-path docs/plans/example-roadmap.md
```

The run continues through additional slices until the roadmap is complete,
failing if it reaches the `--max-slices` safety cap, which defaults to 10. Use
`--max-fix-cycles` to override the default budget of 3 plan-review stalled
prior-blocker cycles and slice repair cycles.

Run static verification with:

```sh
aharness verify fsms/recipe-driven-development.fsm.ts
```
