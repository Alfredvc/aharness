# aharness demos

For the launch coding workflow, start with
[`coding-smoke.fsm.ts`](coding-smoke.fsm.ts). It runs a tiny real fixture through
planning, owner approval, implementation, testing, repair on failure, and final
reporting. The demos below isolate individual mechanisms.

Eight small example FSMs designed for **step-through walkthroughs**.
Each one isolates one mechanism or one tight cluster of related
mechanisms, runs in under five minutes, and keeps owner input short.

| Demo                                                                | Mechanism showcased                                            | Owner input |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ----------- |
| [`color-funnel`](#1-color-funnel--onboarding)                       | `ask` + typed `fsm.submit` + branching + final artifact        | 2 picks     |
| [`ops-clear-demo`](#2-ops-clear-demo--minimal-fresh-clear-smoke)    | **`clearOnEntry` smoke test** — fastest path to verify         | 2 words     |
| [`trivia-rounds`](#3-trivia-rounds--clearonentry-context-wipe)      | **`clearOnEntry` fresh thread** with FSM state retained        | 12 picks    |
| [`adventure`](#4-adventure--multi-exit-branching)                   | `fsm.submit({ route })` branching + success/failure finals     | 2 picks     |
| [`await-checkpoints`](#5-await-checkpoints--await-exits)            | `fsm.await` — user reply fires the FSM transition              | 3 yes/no    |
| [`pirate-roast`](#6-pirate-roast--skill-loading)                    | `fsm.skill.path` — sibling `.md` file injected as persona      | 1 sentence  |
| [`composed-pipeline`](#7-composed-pipeline--composition-and-inputs) | `fsm.embed` + typed `fsm.input.*` root CLI flags               | none        |
| [`approval-policy`](#8-approval-policy--hooks-events-and-passive)   | built-in hook events + `withEvents` + `effect` + `fsm.passive` | none        |

## Running a demo

```sh
aharness examples/<name>.fsm.ts
```

`composed-pipeline` requires a topic flag:

```sh
aharness examples/composed-pipeline.fsm.ts --topic auth-rework
```

`approval-policy` has optional flags for input-helper coverage:

```sh
aharness examples/approval-policy.fsm.ts --mode strict --plan-path ./PLAN.md --max-auto-approvals 1
```

The CLI verifies the FSM, starts the app-server and browser UI, and
drops you into the run. From there:

- **Free-text prompts** (`request_user_input`) appear inline; reply in
  the TUI.
- **Model output** (narration, questions, summaries) appears in the
  TUI as normal codex turns.
- **Artifacts** (`*.md`) land in `<repoRoot>/.aharness/runs/<runId>/artifacts/`.
- **Snapshot + event log** live alongside in the same run dir.

Runs are foreground-only. If the process dies, re-run the command to
start a new run; previous artifacts remain inspectable.

---

## 1. `color-funnel` — onboarding

**File:** `examples/color-funnel.fsm.ts`
**States:** `pickColor` → `modelPicksFruit` → `confirm` → `finalize`
**Mechanism:** the smallest possible end-to-end tour: one
owner-yield, one model-only state, one yes/no gate, one final state.

### Walkthrough

1. TUI prompts `Pick a color: 1) red  2) green  3) blue  4) yellow`.
   Reply with a number or color name.
2. Model emits a fruit suggestion + one-line reason and submits.
3. TUI prompts `Suggested fruit: <X>. Want this one? Reply yes or no`.
4. **Yes** → final state writes `result.md`. **No** → model picks a
   different fruit, prompt repeats.

### What to look for

- The model never narrates a transition itself — every state change is
  a typed `submit` you can see in the run's `events.jsonl`.
- The `confirm` state uses `fsm.submit({ route })` with an unguarded
  catch-all branch looping back to `modelPicksFruit`; the verifier checked
  this before any model call.

---

## 2. `ops-clear-demo` — minimal fresh-clear smoke

**File:** `examples/ops-clear-demo.fsm.ts`
**States:** `say` → `forget` → `done`
**Mechanism:** the **fastest** way to verify a replacement-thread boundary end-to-end.
`clearOnEntry` is used here only for thread freshness; model/effort is now set
using per-state `model` in the API docs.
Two states, two short typed replies, one fresh model thread between them.

### Walkthrough

1. TUI prompts `Pick any short secret word and type it.`. Type
   anything (e.g. `pumpkin`). Model submits the word.
2. The runtime replaces the parent thread; model context is wiped.
3. TUI prompts `Wipe complete. Type the same word again …`. Type
   another word (e.g. `tractor`). Model submits.
4. The final state writes `report.md` comparing the two.

### What to look for

- The model can't recall the word from step 1 (it's not in its chat
  history any more); the FSM still has it in `ctx.secret` because the
  XState actor remains live while only the model thread is replaced.

---

## 3. `trivia-rounds` — `clearOnEntry` context wipe

**File:** `examples/trivia-rounds.fsm.ts`
**States:** `pickGenre` / `pickGenreFresh` ⇄ `askQuestion` (loop ×3) → `finalize`
**Mechanism:** **`clearOnEntry: true`** on `pickGenreFresh` from round 2
onwards. The FSM stays live, while the runtime replaces the model
thread so the next round starts without previous conversation context.

### Walkthrough

For each of 3 rounds:

1. TUI prompts `Round N of 3. Pick a trivia genre: 1) movies  2)
science  3) history`. Reply with a number or genre name.
2. Three multi-choice questions in a row — each prompts `Your answer?
Reply with A, B, C, or D`.
3. After question 3, control transitions to `pickGenreFresh`; on entry,
   the runtime fresh-clears the thread. The model's first words in the
   new thread are something
   like _"I don't have memory of any earlier rounds — let's start
   fresh."_ That is the wipe.

After 3 rounds: the final state writes `scoreboard.md` with per-round score
breakdown.

### What to look for

- The model's narration in rounds 2 and 3 visibly forgets prior
  questions / topics. Free codex cannot do this — only a
  framework-driven fresh thread can.
- The FSM's per-round score is preserved because it lives in XState
  context, not in model context.

---

## 4. `adventure` — multi-exit branching

**File:** `examples/adventure.fsm.ts`
**States:** `entrance` → (`forest` | `cave` | `river`) → (`victory` | `defeat`)
**Mechanism:** every branching state uses `fsm.submit({ route })` with two
or three branches. The verifier proves all six branch outcomes
can reach one of the two terminals and the unguarded catch-all is total
before any model call.

### Walkthrough

1. TUI: `Forest, cave, or river? Reply 1, 2, or 3`. Model narrates the
   crossroads scene first.
2. TUI: `Bold or cautious? Reply 1 or 2`. Each path has a different
   bold/cautious → victory/defeat mapping (`forest`: bold wins,
   `cave`: cautious wins, `river`: bold wins).
3. Terminal state writes `adventure.md` with the trail and ending
   paragraph, then the run reaches the victory or defeat terminal.

### What to look for

- Two distinct final states (`fsm.final({ outcome: 'success' })` for victory,
  `fsm.final({ outcome: 'failure' })` for defeat) — both are first-class in the run
  log.
- `adventure.md` is written by `fsm.final({ artifacts })` before terminal
  success is reported, so CLI shutdown cannot outrun the artifact write.
- Owner makes only **two** picks but the FSM has an 8-state graph with
  6 branches — the verifier statically proved exit coverage.

---

## 5. `await-checkpoints` — `await` exits

**File:** `examples/await-checkpoints.fsm.ts`
**States:** `lintCheck` → `testsCheck` → `buildCheck` → `done`
**Mechanism:** every non-final state declares a single `fsm.await(...)`
transition (no `fsm.submit`). The framework's per-state
nudge tells the model to call codex's built-in `request_user_input`;
the user's reply itself fires the `AWAIT__<state>__<exit>` transition
— no model `submit` step in between. The reply text is captured into
FSM data via the await reducer.

### Walkthrough

1. TUI: model writes a one-line fake "lint passed" summary, then
   prompts `lint passed — proceed to tests? (yes/no)`.
2. You reply (yes or no — the FSM advances either way; the reply text
   is recorded). Model writes a fake "tests passed" summary, prompts
   `tests passed — proceed to build? (yes/no)`.
3. Reply again. Model writes a fake "build green" summary, prompts
   `build green — ship it? (yes/no)`.
4. Reply once more. Terminal writes `deploy-log.md` with a 3-row table
   of stages and your replies.

### What to look for

- The `events.jsonl` shows three `AWAIT__<state>__proceed` events —
  no `SUBMIT__*` events. The owner reply is the transition payload.
- `fsm.await` transitions are **single-branch only** — guarding on free text
  would re-introduce transition-by-text in violation of hard rule #3.
  The verifier rejects `{kind: 'await', when: [...]}`.
- Contrast with `fsm.state({ ask, on: { submit: fsm.submit(...) } })`: it pauses for an owner
  reply and then expects the model to construct a typed `submit` from
  the reply. `await` exits skip the model's submit altogether — the
  reply alone advances the FSM.
- The verifier emits an `await-only-strict-state` warning per pure-
  await state ("confirm this is intentional") — informational, not
  blocking. The demo deliberately triggers it three times.

---

## 6. `pirate-roast` — skill loading

**File:** `examples/pirate-roast.fsm.ts`
**Skill:** `examples/skills/pirate-mode.md`
**States:** `confess` → `verdict` → `done`
**Mechanism:** path-form `fsm.skill.path('./skills/pirate-mode.md')` on
the first stateful state. The framework resolves the path against the
FSM file's directory, reads the body, and prepends a `<skill>` block to
the per-state orientation nudge on entry. Once-per-run dedupe keeps the
persona alive into `verdict` without re-injection.

### Walkthrough

1. TUI: model greets you in pirate voice, then `Confess, ye scallywag —
what did ye do today?`. Type one short sentence (e.g. `I rebased a
branch`).
2. Model writes a 3-sentence pirate ribbing of the deed, submits.
3. Terminal writes `pirate-verdict.md` with the deed and the verdict.

### What to look for

- The pirate persona is **not** in the FSM source — it lives in the
  sibling `.md` file. Edit `examples/skills/pirate-mode.md`, re-run, and
  the model's voice changes without touching the FSM.
- The skill body is injected once, on `confess` entry. `verdict`'s
  orientation nudge does NOT re-include the skill block (check the run's
  `events.jsonl`); the model still talks like a pirate because the body
  is already in its conversation context.
- Path-form vs name-form: this demo uses the path form (sibling file).
  Name-form (`fsm.skill('pirate-mode')`) would search
  `<repoRoot>/.agents/skills/pirate-mode/SKILL.md`,
  `~/.agents/skills/pirate-mode/SKILL.md`, then
  `$CODEX_HOME/skills/pirate-mode/SKILL.md` — useful for skills you
  share across projects.

---

## 7. `composed-pipeline` — composition and inputs

**File:** `examples/composed-pipeline.fsm.ts`
**Child:** `examples/composed-pipeline-child.fsm.ts`
**States:** `router` → `spec` (embedded child) → `done`
**Mechanism:** root `fsm.input.string(...)` CLI flags plus `fsm.embed(...)`
composition. The parent projects its data into the child and handles the
child's exact final ids.

### Walkthrough

1. Run `aharness examples/composed-pipeline.fsm.ts --topic auth-rework`.
2. The parent `router` state submits `ready=true` to enter the child
   `spec` machine, or `ready=false` to loop.
3. The child writes a one-paragraph spec and submits `accepted=true` or
   `accepted=false`.
4. `accepted=true` reaches the child's `shipped` final and returns typed
   output to the parent. `accepted=false` reaches `failed` and routes the
   parent back to `router`.

### What to look for

- Only the root FSM's `input` fields become CLI flags. The child also
  declares `topic`, but the parent satisfies it through the embed input
  projection.
- The `embed(...).on` map covers both child finals exactly: `shipped`
  and `failed`. The verifier rejects missing or extra child-final keys.

---

## 8. `approval-policy` — hooks, events, and passive

**File:** `examples/approval-policy.fsm.ts`
**States:** `review` → `record` → `done`
**Mechanism:** canonical built-in hook events, a custom `withEvents(...)`
signal, submit `effect`, `fsm.passive`, and `fsm.input.*` helpers.

### Walkthrough

1. Run `aharness examples/approval-policy.fsm.ts` or pass optional flags:
   `--mode strict --plan-path ./PLAN.md --max-auto-approvals 1`.
2. The model writes a short policy report and submits it.
3. If a Bash approval request happens while the `review` state is active,
   the `permissionRequest` handler records it and either accepts a
   strict-mode `pnpm test...` command for the session or delegates the
   request to the browser approval card.
4. The passive `record` state immediately advances to `done`, which
   writes `approval-policy.md`.

### What to look for

- Built-in hook events live in the same `on` map as submit exits. The
  event handler returns a Codex approval decision; the branch reducer
  records what happened in FSM data.
- `policyNote` shows the `withEvents(...)` shape for machine-local
  events. The example does not install a producer for that event; it is
  present to demonstrate the canonical authoring surface.
- The submit `effect` validates the report before the reducer commits.
  If it throws, the transition is rejected before `record` is entered.

---

## Authoring more demos

Drop a new entry file `examples/<name>.fsm.ts` directly under
`examples/`. Run with `aharness examples/<name>.fsm.ts`. The CLI bundles
the FSM via esbuild against the workspace's `@aharness/core` — no
`package.json`, `tsconfig.json`, or tests required. Multi-file demos
can split helper `.ts` siblings alongside (e.g.
`examples/composed-pipeline.fsm.ts` + `examples/composed-pipeline-child.fsm.ts`);
the loader cache keys on the entry file's basename in addition to the
directory tree, so multiple FSMs in the same directory do not collide.
