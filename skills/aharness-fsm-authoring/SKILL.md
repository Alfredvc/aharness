---
name: aharness-fsm-authoring
description: Author, review, and verify general @aharness/core finite state machines. Use when Codex needs to design or write an aharness FSM for any workflow, convert an informal process into typed states and transitions, choose between strict/open/await/passive/embed/final states, or diagnose aharness FSM verifier and authoring errors.
---

# aharness FSM Authoring

## Core Rule

Author the FSM from the workflow the user asked for. Do not import assumptions from an unrelated task, hard-code hidden answers, or choose a prebuilt process shape unless the user's workflow actually has that shape.

aharness controls deterministic process flow. The model performs bounded language, coding, inspection, or judgment work inside the active state and advances only through declared typed exits.

## Authoring Workflow

1. Identify the workflow goal and success criteria.
2. Separate deterministic control from model work:
   - Deterministic: states, transition topology, schemas, guards, attempt caps, artifacts, terminal outcomes.
   - Model work: reading, drafting, summarizing, implementing, judging ambiguity, asking the owner.
3. Sketch the smallest state graph that enforces the process. Name states and exits in domain terms.
4. Define FSM data: durable facts, counters, decisions, artifacts inputs, and outputs needed by later states.
5. Choose state mechanisms:
   - `fsm.state` for normal model work.
   - strict mode for aharness-driven progress.
   - open mode for owner-paced discussion.
   - `ask` when the model needs owner text before a typed submit.
   - `fsm.await` when the owner reply itself should advance the FSM.
   - `fsm.passive` for deterministic or invoked XState behavior with no model prompt.
   - `fsm.embed` for reusable child machines.
   - `fsm.final` for terminal success or failure.
   - `withEvents`/`fsm.event` only when an advanced FSM has typed runtime inputs that are not ordinary submits, awaits, or built-in hook events.
6. Author with the canonical `createFsm` API.
7. Run `aharness verify <file.fsm.ts>` and fix verifier errors using [fsm-authoring.md](references/fsm-authoring.md).
8. If the user asked to execute the aharness, run `aharness <file.fsm.ts>` and inspect the run artifacts.

## Design Checklist

Before writing the file, answer these in the FSM itself or in brief notes:

- What are the terminal success and failure outcomes?
- What state stores each durable decision?
- Which state owns each owner interaction?
- Which transitions need typed payloads?
- Which branch conditions are deterministic guards rather than model prose?
- What artifacts should be written at the end?
- What can go wrong, and where does the graph route that failure?
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
- Prefer `fsm.submit`, `fsm.await`, and built-in hook events over custom events unless the workflow genuinely has another typed runtime input.
- Use `model` on a state whenever you need to set Codex model and/or effort.
- `model` syntax is `{ name?: string, effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }`.
- Use `clearOnEntry` only on a live, non-initial state where stale history should be discarded; it is freshness-only.
- Use `clearOnEntry: true` to start in a fresh thread in the original aharness launch working directory.
- Use `clearOnEntry: { cwd: '/absolute/path' }` or `clearOnEntry: { cwd: (data) => data.worktreePath }` when a worktree or multi-project workflow needs fresh context in a specific directory; the resolved `cwd` must be a non-empty existing absolute path.
- You can pair state-level `model` with `clearOnEntry` in the same state to run the fresh thread under a specific model/effort.
- `model` declarations are sticky for non-clear states: when `model` is omitted, aharness keeps the prior model/effort settings.
- Use `fsm.final({ artifacts })` for final reports. Artifact renderers must be synchronous.
- Keep raw `xstate` usage explicit and local. Prefer canonical fields when they express the behavior.

## CLI Use

- New standalone projects: `aharness init --dir <path>`.
- Static validation: `aharness verify <file.fsm.ts>`.
- Run an FSM: `aharness <file.fsm.ts> [--<input-flag> <value>]`.
- Environment checks: `aharness doctor`.
- Optional shell setup: `aharness completion install` and `aharness completion uninstall`.

## References

Read [fsm-authoring.md](references/fsm-authoring.md) for the current `@aharness/core` API, verifier rules, runtime semantics, and common authoring mistakes.
