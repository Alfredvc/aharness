# Plan Authoring Guide

Use this guide only while the FSM is in `planAuthoring`.

## Scope Check

- Read the approved spec and relevant code before writing tasks.
- If the spec covers multiple independent subsystems, submit `broadSpec` with the reason and suggested narrowing instead of forcing one large plan.
- Keep the plan bounded to the approved spec and owner narrowing instructions.

## Plan Shape

Every plan should start with:

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]
```

Before tasks, map files that will be created or modified and what each is responsible for.

## Task Requirements

- Each task should be independently reviewable and testable.
- Use exact file paths.
- Include concrete code snippets or precise edits for code steps.
- Include exact verification commands and expected results.
- Prefer test-first task structure: failing test, run it, implementation, run tests, commit.
- Do not use placeholders such as `TBD`, `TODO`, `similar to above`, or `add appropriate error handling`.

## Self-Review Before Submit

- Spec coverage: every spec requirement maps to a task.
- Placeholder scan: no vague or unfinished steps.
- Type consistency: names and signatures stay consistent across tasks.
- Verification: tests and commands are realistic for this repository.

Submit `planReady` only after the plan has been written and self-reviewed.
