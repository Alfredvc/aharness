# Plan Quality Review Guide

Use this guide only while the FSM is in `planQualityGate`.

Review the implementation plan as a structural reviewer before owner review.

## Review Checklist

- Boundary: the plan implements one bounded slice, not a roadmap disguised as a plan.
- Current reality: file paths, APIs, commands, and existing behavior match the repository.
- Buildability: an implementer can execute each task without inventing missing design.
- Task granularity: tasks are small enough to review and verify independently.
- Test design: tests are specific, meaningful, and include expected red/green verification where behavior changes.
- Verification gates: commands are exact and cover the changed surface.
- Documentation: docs that describe changed behavior are included in the same workflow.
- No placeholders: no `TBD`, `TODO`, "similar to above", or vague "handle edge cases" instructions.
- Execution handoff: the plan states how it should be executed after owner approval.

## Exit Discipline

- Submit `review` with `approved=false` when the plan needs changes; include concrete required changes.
- Submit `review` with `approved=true` only when the plan is ready for owner review.
