# Project FSMs

This directory holds project-local aharness FSMs that are not package commands.

## `recipe-driven-development.fsm.ts`

Generic replacement for the recipe-driven development skill. It takes an
implementation roadmap, creates a recipe, and then implements the roadmap
slice-by-slice until every slice is committed:

1. read the roadmap, identify required grounding files, and create the
   implementation recipe
2. confirm or write the current slice plan
3. clear context before executing the planned slice
4. execute the slice
5. review, repair when needed, and verify
6. update the recipe, stage only slice-owned files plus the recipe, and commit
7. clear context, re-read the recipe, and repeat from the next slice until the
   roadmap is complete

Routine phase blockers do not go straight to terminal failure. Each phase routes
through fix cycles or an autonomous recovery protocol with phase-specific
guidance, then returns to the failed phase after recovery. The default
plan/slice fix-cycle budget is 3. Before the FSM reaches the failed final, it
passes through a failure handoff state that records the terminal blocker in the
current detailed plan, or in the recipe if no detailed plan exists, so a later
run can restart from durable context. The FSM reaches failure only when the fix
cycle budget is exhausted, recovery is exhausted, or the slice safety cap is
hit.

Live workflow states declare `gpt-5.5` with medium reasoning effort. Recovery
attempts declare `gpt-5.5` with xhigh effort, and the implementation/review
prompts require delegated subagents to use `gpt-5.5` with high or xhigh effort,
respectively.

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
`--max-fix-cycles` to override the default budget of 3 plan/slice repair cycles.

Run static verification with:

```sh
aharness verify fsms/recipe-driven-development.fsm.ts
```

## `superpowers-recipe-runner.fsm.ts`

Finishes `docs/plans/2026-05-27-superpowers-fsm-package-implementation-recipe.md`
slice by slice. It keeps only the recipe-level gates explicit:

1. read the recipe and roadmap
2. record workspace state without staging unrelated files
3. write or confirm the detailed slice plan
4. clear context before executing the planned slice
5. execute the whole slice inside one broad state
6. review, repair, verify, finish the slice, and clear before the next slice

Routine phase blockers route into the embedded recovery loop inside the same
FSM file, with fresh context before retry attempts. The runner only reaches a
failure final after that recovery loop exhausts its attempt budget or the
iteration safety cap is hit.

The primary slice path is marked with `main: true` so the browser graph uses
`orientSlice -> planSlice -> executeSlice -> reviewSlice -> verifySlice ->
finishSlice` as the main slice spine. From there, `clearForNextSlice` is the
marked next-slice checkpoint before returning to planning, and `complete` is the
marked success final when the recipe is done. Repair, recovery, resume, and
failure paths remain inspectable but do not define the main graph layout.

Run static verification with:

```sh
aharness verify fsms/superpowers-recipe-runner.fsm.ts
```
