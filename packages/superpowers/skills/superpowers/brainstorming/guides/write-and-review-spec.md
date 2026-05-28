# Write And Review Spec Guide

Use this guide only while the FSM is in `writeAndReviewSpec`.

## Write The Spec

- Write the approved design to the FSM-provided target spec path unless the owner has given a more specific path.
- Include the decisions needed for implementation: goal, non-goals, architecture, affected files or modules, data flow, error handling, testing, rollout or migration notes, and open risks.
- Keep the spec bounded to the approved design. Do not add unrelated cleanup or extra features.
- Make ambiguous decisions explicit instead of leaving placeholders.

## Self-Review

Review the written spec before asking the owner to approve it:

- Placeholder scan: no `TBD`, `TODO`, incomplete sections, or vague promises.
- Consistency check: requirements, architecture, and testing strategy do not contradict each other.
- Scope check: the work is small enough for one implementation plan, or the spec clearly says what should be split.
- Ambiguity check: requirements should not have two plausible interpretations.
- Buildability check: the spec gives enough implementation context for a planner to produce concrete tasks.

Fix required changes before submitting `specReview` with `approved=true`.

## Exit Discipline

- Submit `specReview` with `approved=false` when self-review finds required changes.
- Submit `specReview` with `approved=true` only when the spec is ready for owner review and include the final spec path.
- Submit `blocked` only when writing cannot proceed without missing information.
