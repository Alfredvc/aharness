# Project FSMs

This directory holds project-local Harness FSMs that are not package commands.

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
