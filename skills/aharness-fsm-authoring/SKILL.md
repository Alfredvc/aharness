---
name: aharness-fsm-authoring
description: Author, review, and verify general @aharness/core finite state machines. Use when Codex needs to design or write an aharness FSM for any workflow, convert an informal process into typed states and transitions, choose between strict/open/await/passive/embed/final states, or diagnose aharness FSM verifier and authoring errors.
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
   - `ask` when the model needs owner text before a typed submit.
   - `fsm.await` when the owner reply itself should advance the FSM.
   - `fsm.passive` for deterministic or invoked XState behavior with no model prompt.
   - `fsm.embed` for reusable child machines.
   - `fsm.final` for terminal success or failure.
   - `withEvents`/`fsm.event` only when an advanced FSM has typed runtime inputs that are not ordinary submits, awaits, or built-in hook events.
7. Audit every path to `blocked` or `failed`: make sure it is a true terminal outcome for the requested workflow, or encode the recovery/owner-input policy that should happen first.
8. Author with the canonical `createFsm` API.
9. Run `aharness verify <file.fsm.ts>` and fix verifier errors using [fsm-authoring.md](references/fsm-authoring.md).
10. If the user asked to execute the aharness, run `aharness <file.fsm.ts>` and inspect the run artifacts.

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

## Authoring Rules

- Use `createFsm`, `fsm.machine`, `fsm.state`, `fsm.submit`, `fsm.await`, `fsm.final`, `fsm.passive`, `fsm.embed`, `fsm.input.*`, `fsm.skill`, and, for advanced event-driven FSMs, `fsm.withEvents`/`fsm.event`.
- Make every submit payload a concrete object type. Wrap primitives and top-level unions inside object fields.
- Use routed submits for branching. Every non-last branch needs `if`; the last branch is the catch-all.
- Keep reducers synchronous. Use `effect` only for awaited external work before reducer commit.
- Do not write `SUBMIT__*` or `AWAIT__*` handlers by hand.
- Do not use owner input as an implicit transition. Use `ask` plus typed submit, or use exactly one `fsm.await`.
- Do not introduce `ask` as a normal path in autonomous workflows unless owner input is explicitly part of the workflow contract.
- Prefer `fsm.submit`, `fsm.await`, and built-in hook events over custom events unless the workflow genuinely has another typed runtime input.
- Use `model` on a state whenever you need to set Codex model and/or effort.
- `model` syntax is `{ name?: string, effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }`.
- Use `clearOnEntry` only on a live, non-initial and not initially reachable state where stale history should be discarded; it is freshness-only.
- Use `clearOnEntry: true` to start in a fresh thread in the original aharness launch working directory.
- Use `clearOnEntry: { cwd: '/absolute/path' }` or `clearOnEntry: { cwd: (data) => data.worktreePath }` when a worktree or multi-project workflow needs fresh context in a specific directory; the resolved `cwd` must be a non-empty existing absolute path.
- You can pair state-level `model` with `clearOnEntry` in the same state to run the fresh thread under a specific model/effort.
- `model` declarations are sticky for non-clear states: when `model` is omitted, aharness keeps the prior model/effort settings.
- Use `fsm.final({ artifacts })` for final reports. Artifact renderers must be synchronous.
- Do not promote every checklist item, implementation task, command, or review note into a state. Promote it only when the runtime needs separate routing, evidence, ownership, recovery, clearing, or supervision.
- If parent prompts prescribe a strategy such as subagents, command order, or review-loop shape, make sure that strategy is part of the workflow contract.
- Use nullable payload/data fields when real source artifacts can say "not yet written", "none", or "not selected".
- Avoid duplicate sources of truth. Store a durable fact once, then consume it or recompute it in a named refresh/orientation state.
- Use `fsm.embed` when a subprocess has its own reusable lifecycle and typed final outputs. For same-file embedded child machines with submit exits, keep the child machine expression textually inside the parent embed host; use a separate child file when it is reused.
- Keep raw `xstate` usage explicit and local. Prefer canonical fields when they express the behavior.

## CLI Use

- New standalone projects: `aharness init --dir <path>`.
- Static validation: `aharness verify <file.fsm.ts>`.
- Run an FSM: `aharness <file.fsm.ts> [--<input-flag> <value>]`.
- Environment checks: `aharness doctor`.
- Optional shell setup: `aharness completion install` and `aharness completion uninstall`.

## References

Read [fsm-authoring.md](references/fsm-authoring.md) for the current `@aharness/core` API, verifier rules, runtime semantics, and common authoring mistakes.
