---
name: writing-plans
description: Use when turning an approved spec or requirements document into an implementation plan; prefer the aharness run writing-plans FSM command when Harness is available.
---

# Writing Plans

This skill has been converted into the `aharness run writing-plans` Harness FSM command.

Use the FSM command when available. The FSM enforces the workflow gates: plan authoring, broad-spec owner decision, plan quality review, owner plan review, and execution-mode choice.

## FSM State Map

- `planAuthoring`: read the approved spec and relevant code, write a bounded implementation plan, and self-review it. Detailed guidance: `guides/plan-authoring.md`.
- `broadSpecOwnerDecision`: ask whether to narrow and continue or stop for upstream decomposition.
- `planQualityGate`: review the plan for structural defects before owner review. Detailed guidance: `guides/plan-quality-review.md`.
- `ownerPlanReview`: ask the owner to approve the plan or request concrete changes.
- `chooseExecutionMode`: record whether execution should be `subagent-driven` or `inline`.

## Direct Skill Fallback

If Harness is not available, follow the same phases manually:

1. Read the spec and relevant code.
2. Stop and narrow if the spec is too broad for one executable plan.
3. Write a concrete task-by-task implementation plan.
4. Self-review for coverage, placeholders, type consistency, tests, and commands.
5. Ask the owner to approve the plan before execution.
6. Record the chosen execution mode.

Keep process control in the FSM when using Harness. Use the guides only for phase-level operating guidance.
