# Execution Planning — Step 3 of Autonomous Agent Harness

Task decomposition and execution policy for an LLM agent that is about to build what Step 1 (requirements) and Step 2 (design) specified. Takes the full Step 1 and Step 2 output set as inputs — `docs/REQUIREMENTS.md`, `docs/CONTEXT.md`, `docs/SCOPE.md`, `docs/SMOKE.md`, `docs/OPEN_QUESTIONS.md` (Step 1), `docs/DESIGN.md`, `docs/GOVERNANCE.md`, `docs/INCIDENT.md`, `docs/TRACEABILITY.md` (Step 2 — created only on HEAVY) — and produces an executable task graph plus the policies that govern execution.

The central finding from the 2024–2026 empirical literature is counter-intuitive: **the dominant failure in multi-agent code generation is not bad planning — it is the plan-to-code translation gap**. Independent measurement on mutation-based fuzzing showed 75.3% of failures in multi-agent coding systems come from plans that look right but fail to carry enough detail for the executor [arXiv 2510.10460]. Pure planning errors accounted for only 15.3%. This document is designed around that finding: every task carries its own acceptance criterion, and every task is reviewable in isolation.

---

## 0. Operating Principles

1. **The plan is an editable checkpoint, not a prophecy.** Every serious production system — Devin, Kiro, Spec-Kit, Copilot Workspace, Claude Code — produces an artifact plan before execution, and every one of them supports revision mid-run [Cognition 2024; Kiro docs; Spec-Kit repo; Copilot Workspace manual]. Commit early, revise on failure, track drift.
2. **A task without a measurable acceptance criterion is not a task.** The plan-coder gap is closed by acceptance criteria that specify the observable done signal, not by more planner-side words [arXiv 2510.10460]. Monitor agents that enforce this closed 40–88.9% of previously failing cases.
3. **Granularity is bounded on both sides.** Too big and the task is unreviewable and self-conditions on its own errors [arXiv 2509.09677]. Too small and orchestration tokens exceed execution tokens. Heuristic: one task ≈ one observable SMOKE step or one reviewable change surface.
4. **Fresh subagent per task is the default for medium- and high-risk tasks.** Long-running single contexts self-condition on earlier mistakes; spawning a fresh context for the next task resets that [arXiv 2509.09677].
5. **Orchestrator-worker with artifact handoff beats shared-context handoff.** Workers write outputs to files; the orchestrator reads references. Structured multi-agent gave +90.2% over single-agent on Anthropic's internal eval; unstructured multi-agent amplified errors up to 17.2× in a controlled Google DeepMind study [Anthropic multi-agent research; Google DeepMind 2025].
6. **Re-plan triggers are declared up front, not improvised.** Cursor stops at 25 tool calls [Cursor docs]; OpenAI Agents SDK defaults `max_turns=10` and raises `MaxTurnsExceeded` [OpenAI Agents SDK]; Claude Code retries 10× at transport layer only and is known to repeat identical failing calls without diagnosis [Claude Code issues #29944, #41659]. Our defaults are explicit, not inherited.
7. **Independent reviewer per task, same pattern as Step 1.** The gatherer does not review. The executor does not review. Reviewer agent spawns as a separate subagent.
8. **Context is cleared on task and step boundaries. State lives in files, not in conversation.** Chroma's context-rot study measured continuous performance decay at every length increment — Claude code bug-fixing dropped from 29% at 32K to 3% at 256K [trychroma.com/research/context-rot, 2025]. Self-conditioning on prior errors accounts for 20–48% of agent failures independent of context length [arXiv 2509.09677]. The mitigation is structural, not threshold-based: each task runs in a fresh context, resumes from files it declares up front, and writes its outputs back to files before returning. The orchestrator clears between waves. Every task must be resumable from `CLAUDE.md` + its continuation prompt + its declared required files — nothing else.
9. **Step 3 runs fully autonomously. No human in the loop.** The initial conversation with the owner happens in Step 1 only. Asking the owner anything during Step 3 is a disqualifying act (per harness contract). Gates that would otherwise be "owner confirmation" are replaced by the independent `tasks-reviewer` subagent's PASS verdict. If a decision genuinely cannot be made without owner input, append a new `Q<n>` entry to `docs/OPEN_QUESTIONS.md` using **Step 1's canonical format** (§8.3) — `Q<n>.` / `Why unresolved:` / `Blast radius:` / `Proposed resolution path:` — and let that be the escalation. Do not block, do not invent alternate schemas, do not create per-step subsections.

---

## 1. Inputs and Outputs

**Inputs:**
- From Step 1: `docs/REQUIREMENTS.md`, `docs/CONTEXT.md`, `docs/SCOPE.md` (with Rigor Score and `budgets:` list per Step 1 §8.4), `docs/SMOKE.md` (with `S<k>` identifiers per Step 1 §8.2), `docs/OPEN_QUESTIONS.md` (canonical Step 1 format).
- From Step 2: `docs/DESIGN.md` (architecture, walking-skeleton definition, ADR log, fitness-function invariants with `wired_at` fields), `docs/GOVERNANCE.md` (toolchain, test strategy, skills/MCPs, risk register, hard abort conditions, MoSCoW drop policy, escalation-ladder principle, `INCIDENT.md` schema, `## Approval Log`), `docs/INCIDENT.md` (initialised empty or with entries from prior runs), `docs/TRACEABILITY.md` (on HEAVY path only — columns 1–5 populated by Step 2).
- Pre-existing working directories: `docs/deps/` (dep reverse-engineering notes), `docs/research/` (candidate research), `docs/handoffs/` (created on demand).

**Outputs (committed to repo):**

| File | Purpose |
|---|---|
| `docs/TASKS.md` | Executable task DAG. Each task has an acceptance criterion, traceability links, fitness gates, and a risk tier. Header contains execution policy (budgets, retry, kill switches, replan counter). T1 is always the walking-skeleton implementation task per §3/§4/§5. |
| `docs/TRACEABILITY.md` | **HEAVY path only** (regulated compliance — ISO/IEC/IEEE 29148). Step 3 appends the `task` column to the matrix Step 2 HEAVY created (columns 1–5 already populated). LIGHT / STANDARD derive coverage on demand from `Traces to:` fields on each task — no standalone file. `tasks-reviewer` checks coverage field-by-field; gaps are reviewer failures. |
| `docs/INCIDENT.md` (appended) | Step 3 writes entries at the moment of each decision per Step 2 §9 schema. This is the sole structured-log channel — Step 3 does NOT create `.claude/reports/step3-*.md` files. |
| `docs/RUN_REPORT.md` | Terminal-state report — written ONLY when Step 3 halts before reaching its §10 exit criteria. Uses the shared Step 2 §1.1 schema with `phase: step3`. Absent on successful completion. Presence suppresses Step 3 re-activation. |
| `docs/handoffs/<file>.md` | Handoff files — partial task outputs during a replan freeze, large subagent returns (>20K tokens), orchestrator working-memory dumps before `/clear`. Transient; Step 2 §1 names the directory. |

`docs/deps/<name>.md` files are owned initially by Step 1's HEAVY path and refreshed by Step 2 HEAVY or by Step 3 execution spikes. A Step 3 dep-spike task writes its output to the file path (creating or appending); the path is tracked via the task's `Output files` schema field, not as a separate primary output. `docs/research/<name>.md` holds candidate research and pattern investigations — Step 3 research subagents write large returns here.

---

## 2. Phase 0 — Preflight and inherit triage

Step 3 does not re-score the project. Before branching, run these preflight checks in order. Any failure halts Step 3 with a `docs/RUN_REPORT.md` per Step 2 §1.1 (`phase: step3`, appropriate `halt_reason`) — do not improvise recovery. The presence of `RUN_REPORT.md` suppresses Step 3 re-activation until the owner deletes it.

### 2.1 Preflight checks

1. **No prior-run halt marker.** `docs/RUN_REPORT.md` does NOT exist. If it does exist and references a prior halted Step 3 run (`phase: step3`), do NOT re-activate — the owner must delete it after resolving the blocking precondition. If it references a halted Step 2 run, Step 3 cannot start because Step 2 did not complete.
2. **Step 1 artefacts exist and are complete.** `docs/REQUIREMENTS.md`, `docs/CONTEXT.md`, `docs/SCOPE.md`, `docs/SMOKE.md`, `docs/OPEN_QUESTIONS.md` all present and non-empty. Missing ⇒ halt with `halt_reason: missing_precondition`, listing the missing file(s).
3. **Step 2 artefacts exist.** `docs/DESIGN.md` AND `docs/GOVERNANCE.md` present and non-empty. On HEAVY path, `docs/TRACEABILITY.md` must also exist (Step 2 HEAVY creates it with columns 1–5). `docs/INCIDENT.md` must exist (initialised empty at Step 2 close). Missing any of these ⇒ halt with `halt_reason: missing_precondition`. Step 3 treats these files as structured inputs whose section contracts are owned by Step 2's guide; absence of a section the task planner needs is a reviewer finding, not a preflight halt.
4. **Rigor Score present.** `SCOPE.md` YAML frontmatter contains `rigor_score` (5–15) and `rigor_factors` (all five). Missing ⇒ halt with `halt_reason: missing_precondition`.
5. **Budget block is valid.** `SCOPE.md` frontmatter contains a `budgets:` list per Step 1 §8.4. Valid shapes:
   - Empty list (`budgets: []`) — explicit "no budget" — proceed; Step 3 kill switches that reference a budget are silently skipped.
   - One or more entries, each with `unit`, `cap`, `warn_at`, `abort_at`, `scope` fields filled. At least one entry must have `scope: step3` or `scope: total` (Step 2 apportions a `total` entry across phases per Step 2 §2.1). If entries exist but none apply to Step 3, that's a Step 2 apportionment failure ⇒ halt with `halt_reason: missing_precondition`.
   - Malformed or missing YAML ⇒ halt with `halt_reason: missing_precondition`.
6. **Approval Log present in `GOVERNANCE.md`.** Step 2 writes a one-line Approval Log entry at owner approval; its absence means Step 2 did not close cleanly ⇒ halt with `halt_reason: missing_precondition`.
7. **`CLAUDE.md` exists at the current working directory root.** Missing ⇒ halt with `halt_reason: missing_precondition: project convention file missing`.

### 2.2 Branch on Rigor Score

- Rigor 5–7 → §3 LIGHT
- Rigor 8–11 → §4 STANDARD
- Rigor 12–15 → §5 HEAVY

---

## 3. LIGHT Path (~20 min, flat list)

Use when the inherited Rigor Score is 5–7.

1. **T1 = walking-skeleton implementation.** The first task is always the walking skeleton defined in `DESIGN.md` §8.1. Its acceptance criterion is "the end-to-end slice passes the SMOKE.md golden path (`S1` through `Sn`) end-to-end with production-quality code, not throwaway." Every other task is `Blocked by: [T1]` — directly or transitively. This is non-negotiable on all paths.
2. **Extract the in-scope slice from `SCOPE.md`.** Every remaining item in the slice becomes at least one task. The slice may be a minimum viable subset or a full-product release — Step 3 treats both the same way, the slice is whatever Step 1 recorded.
3. **Write a flat list of 5–20 tasks** (including T1) using the §7 task schema. Omit parallelism: LIGHT path executes sequentially.
4. **For each task, write an acceptance criterion that is a single observable.** A file with specific contents, a CLI command that returns exit 0, a curl that returns a specific status, or a screen state visible in the SMOKE walkthrough. Include the applicable fitness-function checks (see §7 `Fitness gates:` field) from `DESIGN.md` §8.4.
5. **Trace every task** back to at least one `R<n>` and, if applicable, one `S<k>` in SMOKE (using the stable `S<k>` identifiers Step 1 §8.2 emits).
6. **Wire the risk register.** For every `RSK<n>` in `GOVERNANCE.md`, add either a dedicated mitigation task OR an `Escalate on` clause on the nearest relevant task. This is how risks become work (not kill switches — see Step 2 §8.3).
7. **Set the execution policy header** in `TASKS.md` per the template in §8. Populate the `Budgets:` block from `SCOPE.md` `budgets:` entries scoped to `step3` or `total`.
8. **Coverage check** — every in-scope `R<n>` in `SCOPE.md` has ≥1 task citing it in `Traces to:`; every `S<k>` in `SMOKE.md` has ≥1 task citing it in `Smoke step:`. No standalone file on LIGHT. Reviewer (§6.2) walks task fields directly. Gaps become reviewer findings.
9. **Run the decomposition reviewer** (§6). Apply findings per the re-plan procedure in §8.6. Re-run until reviewer returns PASS or the re-plan counter trips (see §8.6).

If reviewer returns PASS: Step 3 is complete. No owner confirmation.

If task count exceeds 20, upgrade to STANDARD before running the reviewer.

---

## 4. STANDARD Path (~1–2 hours, DAG with reviewer-per-task)

Use when the inherited Rigor Score is 8–11.

1. **T1 = walking-skeleton implementation.** Same rule as LIGHT §3 step 1 — the first task is the walking skeleton from `DESIGN.md` §8.1; every other task is `Blocked by: [T1]` directly or transitively.
2. **Identify spike tasks.** Anything novel to the codebase, any third-party integration whose behaviour is not yet confirmed, any undocumented dep. Each spike is its own task with its own acceptance criterion. **Dep-spike outputs go to `docs/deps/<dep-name>.md`** (facts about opaque third-party systems — protocol, API, observed behaviour); **research spike outputs go to `docs/research/<name>.md`** (candidate research, pattern investigation, selection rationale). Refresh an existing dep file if Step 1 or Step 2 already created one — do not duplicate. Spikes run after T1 but before dependent feature tasks.
3. **Decompose the remaining in-scope slice into a DAG.** Use the §7 task schema including `blocked_by` and `parallel_safe`. A task is `parallel_safe: yes` only if it touches files disjoint from every other parallel-safe task in the same wave.
4. **Attach an acceptance criterion to every task** in the format from §7. Monitor-agent principle: the acceptance criterion is what the reviewer will check, not a restatement of the description [arXiv 2510.10460 §4]. Acceptance includes any applicable `per_task`-wired fitness functions from `DESIGN.md` §8.4.
5. **Tag risk tier** per task: low / medium / high. High-risk tasks touch shared state, modify external systems, or implement security- or privacy-relevant behaviour. Medium- and high-risk tasks get an independent reviewer subagent; low-risk tasks are reviewed in a single batch call at end-of-wave (one reviewer invocation reads all low-risk tasks' outputs together).
6. **Wire the risk register.** For every `RSK<n>` in `GOVERNANCE.md`, add a mitigation task OR an `Escalate on` clause on a relevant task (Step 2 §8.3). Reviewer §6 verifies coverage.
7. **Wire fitness functions.** Per-task-wired fitness functions go into the relevant tasks' acceptance criteria and `Fitness gates:` field (§7). Per-wave-wired functions go into the execution policy header's `Wave fitness gates:` section (§8). Continuous-wired functions begin running against the walking skeleton as soon as T1 passes acceptance.
8. **Write the execution policy header** (§8): per-task budget (derived from `SCOPE.md` `budgets:` scoped to `step3` or `total`), retry policy, re-plan triggers, kill switches, orchestration pattern (sequential / parallel waves / dependency DAG), wave fitness gates.
9. **Coverage check** — same as LIGHT §3 step 8. No standalone file on STANDARD. `tasks-reviewer` walks `Traces to:` and `Smoke step:` fields directly; gaps fail the gate.
10. **Run the decomposition reviewer** (§6). Apply findings per the re-plan procedure in §8.6. Re-run until reviewer returns PASS or the re-plan counter trips.

If reviewer returns PASS: Step 3 is complete. No owner confirmation.

---

## 5. HEAVY Path (≥4 hours, monitor-agent pattern)

Use when the inherited Rigor Score is 12–15 or any Step-1 override fired.

1. **All STANDARD steps**, including the T1 = walking-skeleton rule.
2. **Dependency spikes are mandatory** for every closed-source or undocumented dep identified in Step 1 or Step 2. Refresh `docs/deps/<name>.md` files; do not duplicate.
3. **Extend the existing `docs/TRACEABILITY.md`.** Step 2 HEAVY created the file with columns 1–5 (`requirement | design element | fitness function | test | smoke step`). Step 3 HEAVY appends the `task` column in-place. Do not overwrite Step 2's columns; do not create a second file.
4. **Monitor-agent pattern per task.** For each medium- or high-risk task, insert a monitor step between planner-form and executor-form: a subagent reads the task's acceptance criterion, generates the five-error-pattern checklist from [arXiv 2510.10460] (core concepts, edge cases, complex logic, relational phrases, condition judgments), and commits it into the task block as `monitor_checklist`. The task's reviewer will verify against this checklist.
5. **Multi-prompt generation for high-risk tasks.** For each high-risk task, generate two description paraphrases alongside the original (k=2 per [arXiv 2510.10460]). A valid paraphrase preserves semantics (≥95% sentence-embedding similarity if tooling available; otherwise: passes a read-aloud check where the same acceptance criterion still applies) and varies at least one of: sentence order, clause structure, or specificity level. Store the two paraphrases in the task block under `Paraphrases:`. The executor receives all three as context to reduce interpretation-path starvation [cf. PlanSearch arXiv 2409.03733, which raised pass@200 on LiveCodeBench from 41.4% to 77.0% via plan diversity].
6. **Threat model and failure-mode-effects per risk-relevant task.** Security-relevant tasks get a per-task threat model with at least: what trust boundary is crossed, what input is validated, what happens on malformed input.
7. **Per-task reviewer is mandatory** (no batch review on HEAVY).
8. **Run the decomposition reviewer** (§6) twice: first on the DAG + traceability matrix, second after monitor-checklists and paraphrases are drafted. Both must return PASS.

If both reviewer passes return PASS: Step 3 is complete. No owner confirmation.

---

## 6. Decomposition Review Gate (all paths)

Run before claiming `TASKS.md` is complete (HEAVY also: `TRACEABILITY.md`). Spawn an independent `tasks-reviewer` subagent. Every check must pass.

### 6.1 Structural checks

- [ ] Every task has all fields required by §7.
- [ ] **T1 is the walking-skeleton implementation task** per §3/§4/§5 step 1. Its `Traces to:` cites the requirements the skeleton crosses; its acceptance is "SMOKE.md golden path `S1`–`Sn` passes end-to-end." No task id precedes T1.
- [ ] **Every other task is transitively `Blocked by: [T1]`** — either directly or through its `blocked_by` chain. A task not reachable from T1 through reverse-blocked-by walks is a scope-disconnect failure.
- [ ] Every task has a Volere-style acceptance criterion that is a single observable, not a restatement of the description.
- [ ] The DAG is acyclic (no `blocked_by` cycle).
- [ ] `parallel_safe` claims are true — no two parallel-safe tasks share a file, a database table, or a service endpoint being mutated.
- [ ] Every `blocked_by` reference points to an existing task id.

### 6.2 Coverage checks

- [ ] Every requirement in the in-scope slice of `SCOPE.md` is cited in `Traces to:` on at least one task (HEAVY also: logged in `TRACEABILITY.md`).
- [ ] Every step in `SMOKE.md` (each `S<k>` identifier from Step 1 §8.2) is cited in `Smoke step:` on at least one task. No `Smoke step: S<k>` value may be a dangling reference to an id that does not exist in SMOKE.md.
- [ ] Every task cites at least one `R<n>` in its `Traces to` field. Tasks that do not cite a requirement are scope creep candidates — flag individually.
- [ ] **Fitness-function coverage.** Every fitness function in `DESIGN.md` §8.4 is wired per its `wired_at:` field: `per_task` functions appear in the `Fitness gates:` field of at least one task; `per_wave` functions appear in the execution policy header's `Wave fitness gates:` section; `continuous` functions are listed under the execution policy header's `Continuous fitness monitors:` section and depend on T1 passing acceptance.
- [ ] **Risk-register coverage.** Every `RSK<n>` in `GOVERNANCE.md` has either (a) a dedicated mitigation task in the DAG whose `Traces to:` references the risk id, OR (b) an `Escalate on:` clause on an existing task that names the risk's `abort_if` observable. Missing coverage = FAIL.

### 6.3 Granularity checks

- [ ] If any `budgets:` entry has `scope: step3` or `scope: total`, no task's `Estimated budget` exceeds 20% of the smallest applicable cap (in the cap's own unit). If `budgets:` is empty, this check is skipped.
- [ ] No task is so small that its acceptance check is trivial ("update this one constant"). Merge upward unless it genuinely isolates risk.
- [ ] Task count is within path bounds: LIGHT 5–20, STANDARD 10–60, HEAVY 20–150. Outside those bounds ⇒ FAIL. The planner must re-decompose; the reviewer does not speculate on the correct count.

### 6.4 Risk and policy checks

- [ ] Every high-risk task has an assigned independent reviewer (not batch).
- [ ] Every task has an `Escalate on` condition. "Retry until it works" is not a condition.
- [ ] Kill-switch thresholds in the `TASKS.md` header are set to concrete numbers, not phrases.
- [ ] Destructive tasks (modify external state, delete data, push to shared branches, network-mutating operations) are flagged `Risk: high` and have a `Destructive: yes` marker plus an `Escalate on: any non-dry-run invocation without prior dry-run confirmation in the task log` condition. Since Step 3 is autonomous, the "confirmation" is a structural one: the task's continuation prompt requires executing a dry-run first and reading its output into context before the mutating call.

### 6.5 Agent-specific checks

- [ ] **Hallucinated dependency check.** No task `blocked_by` references a task that does not exist. No task acceptance criterion references a file, API, or library symbol that has not been confirmed to exist (either via research step, dep spike, or existing codebase).
- [ ] **Plan-coder gap check.** For each medium- or high-risk task, is the acceptance criterion executable by a reviewer without reading the task description? If it cannot stand alone, rewrite.
- [ ] **Repeat-error susceptibility.** If the same error class across two tasks would not trigger a replan, the trigger is too weak. Require a cross-task error-class re-plan trigger.
- [ ] **Sycophancy audit on the decomposition.** Re-read the decomposition against `REQUIREMENTS.md`. Is any task an "obvious addition" that did not appear in the requirements and was not owner-authorized? Flag.

### 6.6 Continuation-readiness checks

- [ ] **Every task has a `Continuation prompt`.** The prompt references `Required files` by path and states the acceptance criterion verbatim. A task with no continuation prompt cannot resume from a cleared context.
- [ ] **Every `Required files` path resolves to a file that exists or will exist after a declared upstream task completes.** Dangling refs are blocked.
- [ ] **Every task's state dependencies live in `Required files`, not in implicit conversation memory.** Reject any continuation prompt that says "you already discussed X" or "continuing from where you left off".
- [ ] **Every task's `Output files` are referenced by at least one downstream task's `Required files`, OR are part of the final deliverable, OR are explicitly justified in the task's rationale.** Unreferenced outputs are dead weight.
- [ ] **Model tier is set per task.** See §8.5 rules. `Model tier` is mandatory in the schema; a missing value is a failure, not a default. The reviewer also verifies the recorded `Reviewer model tier` matches the derivation rule (low→haiku, medium→sonnet, high→opus).
- [ ] **Clear boundaries declared.** The `TASKS.md` policy header states which wave boundaries trigger `/clear` on the orchestrator.

---

## 7. Task Schema

Every task in `TASKS.md` uses this format. YAML-ish markdown block; pick whichever your tooling prefers, keep the fields identical.

```
T<id>. <Short name>
Description: <one imperative sentence — "Implement the /login POST handler that validates email+password and returns a session cookie.">
Acceptance: <single observable condition. "curl -X POST localhost:8080/login with valid credentials returns 200 and a Set-Cookie header whose value parses as a JWT with exp > now().">
Traces to: R<n>, R<m>, RSK<n>    [risk ids allowed when the task is a mitigation task per Step 2 §8.3]
Smoke step: S<k>   [required if this task is on the golden path; resolves against SMOKE.md ids per Step 1 §8.2]
Fitness gates: [FF-<n>, …]   [per_task-wired fitness functions from DESIGN.md §8.4 whose guarded surface this task touches; checked as part of acceptance]
Blocks: [T<id>, …]
Blocked by: [T<id>, …]      [every non-T1 task must be transitively Blocked by T1]
Parallel safe: yes | no   [yes only if files/endpoints/tables are disjoint from every other parallel-safe task in the same wave]
Risk: low | medium | high
Destructive: yes | no   [yes if the task mutates external state, deletes data, or pushes to a shared branch]
Model tier: haiku | sonnet | opus   [executor tier; see §8.5]
Reviewer model tier: haiku | sonnet | opus   [derived: low-risk→haiku, medium-risk→sonnet, high-risk→opus; record explicitly]
Estimated budget: {unit: <same as some `budgets` entry unit or "tokens">, value: <positive number>}
                          [unit must match at least one SCOPE.md budgets entry (dollars / tokens / hours) OR default "tokens" when SCOPE.md budgets is empty]
Reviewer: independent | batch   [independent is mandatory for medium and high risk; batch only for low-risk structural tasks]
Escalate on: <explicit condition — "2 consecutive task failures" | "monitor checklist reports any EP violation" | "observable matches RSK03 abort_if">
Monitor checklist: <list of five-pattern checks; HEAVY path only, see §5 step 4>
Paraphrases: [<paraphrase 1>, <paraphrase 2>]   [HEAVY high-risk tasks only, per §5 step 5]

Required files: [<path>, …]   [files that must exist on disk before this task starts; executor reads these, not the conversation]
Output files: [<path>, …]     [files this task must write to; these become required-files for downstream tasks]
Continuation prompt: |
  <The exact prompt a fresh context needs to execute this task. Must reference Required files by path and state the Acceptance criterion verbatim. No reliance on prior conversation. Short — typically 5–15 lines.>
```

**Definitions for schema fields.**

- **Golden path task.** A task is "on the golden path" iff every downstream task it transitively blocks is required for the `SMOKE.md` golden-path walkthrough to succeed. Practically: a task is on the golden path iff the smoke walkthrough cannot run without it. Not-golden-path tasks are still allowed; they just do not require an `S<k>` link. T1 (walking skeleton) is always on the golden path.
- **Estimated budget.** The unit must match at least one `unit` field in `SCOPE.md` `budgets:` entries — so the orchestrator can sum tasks and compare against the relevant cap in the same unit. If `budgets:` is empty (no budget declared), use `unit: tokens` as the default for internal tracking; no cap is enforced. For wall-time-bound spikes, estimate the agent's active tokens during the wait, not the wall-clock time, unless the project declared an `hours` budget.
- **Reviewer model tier.** Derived deterministically from `Risk`. Must be recorded explicitly in the schema — the decomposition reviewer checks the recorded value against the derivation rule. Low-risk → haiku, medium-risk → sonnet, high-risk → opus. Deviations from the rule are failures unless an `Escalate on` note justifies the exception.
- **Fitness gates.** One or more `FF-<n>` ids from `DESIGN.md` §8.4 whose `wired_at:` is `per_task` AND whose guarded surface this task touches. The orchestrator runs each listed fitness function as part of acceptance; any trip is an acceptance failure feeding §8.6's rung-1 retry, then the replan cascade. A task that touches a guarded surface without listing the relevant `FF-<n>` is a coverage failure at §6.2.

Design choices and why they differ from production systems:

- **Acceptance criterion is first-class** — Spec-Kit, Kiro, Claude Code, and Cursor have no per-task acceptance field [Spec-Kit templates; Kiro docs; Claude Code issue #21901; Cursor plans convention]. The plan-coder gap paper is precisely the research that closes this hole [arXiv 2510.10460]. We are not replicating their omission.
- **Traces to is first-class** — Kiro has `_Requirements: X.X_`, Spec-Kit has `[US<n>]`. We normalize to `Traces to: R<n>` matching Step 1's `R<n>` convention.
- **Parallel safe is explicit, not implicit** — only Spec-Kit has a parallelism marker (`[P]`). Others leave it implicit. We require explicit.
- **Escalate on is required** — none of the production systems require a per-task escalation condition. Claude Code's known retry-without-diagnosis bug (issues #29944, #41659) is the failure this prevents.
- **Blocked by is a structured list** — Spec-Kit uses prose for dependencies. We require a machine-readable list so the decomposition reviewer can check DAG acyclicity.
- **Continuation prompt + required/output files are first-class** — Anthropic's orchestrator-worker pattern uses file-based artifact handoff for exactly this reason [Anthropic multi-agent research]. No production `tasks.md` format carries a continuation prompt as a schema field. Ours does, because the executor runs in a fresh context per task (see §8.5) and cannot rely on conversation history.
- **Model tier is first-class** — production task schemas do not carry a per-task model tier. Our harness operates under a hard budget cap, so cost-per-task must be planned, not inherited from whichever model the orchestrator happened to be using.

---

## 8. Execution Policy Header

The top of `TASKS.md` carries an execution policy. Not a suggestion — the orchestrator reads it.

```
## Execution Policy

Budgets: <copy of SCOPE.md `budgets:` entries where scope == "step3" or scope == "total">
  [empty list if SCOPE.md budgets is empty — no budget-based abort applies]
Budget cap per task: <min(20% of smallest applicable cap, 200000 tokens or equivalent)>
  [200K tokens is the hard cap per task regardless of budget unit; covers one Opus context fill]
Turn limit per task: <haiku: 10, sonnet: 15, opus: 20>
Retry policy: rung-1 local retry (1 attempt, documented hypothesis) per §8.5; beyond rung-1 follows the replan cascade
Orchestration: <sequential | parallel waves | DAG>   [match the path: LIGHT→sequential, STANDARD→parallel waves or DAG, HEAVY→DAG]
replan_count: 0   [mandatory; incremented by §8.6 procedure; kill switch on >3]

Wave fitness gates: [FF-<n>, …]
  [per_wave-wired fitness functions from DESIGN.md §8.4; orchestrator runs each between task waves]
Continuous fitness monitors: [FF-<n>, …]
  [continuous-wired fitness functions from DESIGN.md §8.4; orchestrator runs these against the running walking skeleton after T1 passes acceptance]

Model tiering (rules in §8.5):
- Orchestrator: opus
- Standard executor (low/medium risk): sonnet
- High-risk executor: opus
- Reviewer (low-risk): haiku
- Reviewer (medium-risk): sonnet
- Reviewer (high-risk): opus
- Research subagent: sonnet
- replan-agent (rung 2): sonnet
- tasks-reviewer (replan review): sonnet

Context management:
- Default: fresh context per task. Executor receives CLAUDE.md + task continuation prompt + required files.
- Orchestrator: `/clear` between task waves; never between tasks within the same wave unless a trigger fires.
- Orchestrator safety net: `/compact` at 70% context fill; full `/clear` at 90%.
- Any subagent return > 20K tokens: orchestrator writes it to `docs/research/<name>.md` (for candidate research), `docs/deps/<name>.md` (for dep spikes), or `docs/handoffs/handoff-<origin>-<topic>-<UTC-date>.md` (for transient handoffs), then compacts.

Rung-2 (replan) triggers:
- Any task fails rung-1 local retry (one attempt with documented hypothesis did not pass acceptance).
- Task budget overrun >2× its `Estimated budget`.
- Same error class occurs in two different tasks (systemic signal — triggers structural replan, not per-task replan).
- Reviewer returns FAIL twice on the same task after replan adjustments.
- A `GOVERNANCE.md` risk-register `abort_if` observable is tripped during execution (per Step 2 §8.3: risks trigger replan, not hard abort).
- Orchestrator has executed > 300 tool calls on a Sonnet-tier session — force `/clear` and resume from TASKS.md (this is a context-hygiene event; it is not a replan but the resume protocol applies).

Rung-3 (hard-abort) kill switches (halt execution; write RUN_REPORT.md per Step 2 §1.1 with `phase: step3`):
- A Must-Have is blocked and the replan cascade (2a + 2b) cannot restore a feasible path — `halt_reason: must_blocked_no_fallback`.
- Any `Budgets:` entry trips its `abort_at` threshold (Step 2 §8.6) — `halt_reason: budget_exhausted`. Skipped if `Budgets:` is empty.
- Any task attempts to modify files outside its declared change surface — `halt_reason: hard_abort_tripped` (integrity violation).
- Any task not flagged `Destructive: yes` attempts a destructive action — same halt_reason.
- Review gate (§6) fails on a high-risk task more than twice consecutively — same halt_reason.
- Orchestrator cannot resume from files after a `/clear` — indicates incomplete state persistence; `halt_reason: hard_abort_tripped`.
- Re-plan counter exceeds 3 (see §8.6) — `halt_reason: replan_count_exceeded`.
- The walking skeleton (T1) end-to-end test fails 3 times with distinct root causes — `halt_reason: walking_skeleton_triple_fail` (Step 2 §8.6).
- Any fitness function trips continuously through more than one escalation round — `halt_reason: hard_abort_tripped` (Step 2 §8.6).
```

These numbers are defaults. They may be tuned in `SCOPE.md` for the specific project, but never removed.

---

## 8.6 Re-plan procedure (rung-2 cascade)

A re-plan trigger firing is never "retry the same task harder" by the failing agent. It is a structural intervention driven by a dedicated `replan-agent` subagent and gated by the `tasks-reviewer` subagent. The shape is Step 2 §8.5's rung-2 cascade (2a exact → 2b softened → 2c drop); this section operationalises it.

**Core invariant.** The main orchestrator does NOT propose the recovery. The failing executor does NOT propose the recovery. A `replan-agent` (project-internal; Step 2 §0.1) is spawned with the failure context and owns the cascade. A `tasks-reviewer` (project-internal) gates every proposal. This is the anti-sycophancy guard: the agent that failed is not the agent that decides how to recover, and the agent that proposes recovery is not the agent that approves it.

**Procedure:**

1. **Freeze execution.** Pause any tasks in `in_progress`; save their partial outputs to `docs/handoffs/handoff-<task-id>-partial-<UTC-date>.md`. Write an INCIDENT.md entry (Step 2 §9 schema) with `status: open`, `detection: tool_failure` (or the appropriate enum value), `trigger:` naming the replan trigger from §8, and `diagnostics:` capturing the observed error class.

2. **Spawn `replan-agent`** with inputs: (a) the failing task's full entry from TASKS.md; (b) the handoff file with partial output; (c) the INCIDENT.md entries for this task (not the whole log); (d) the relevant `R<n>` from REQUIREMENTS.md with its fit criterion; (e) the matching `RSK<n>` from GOVERNANCE.md if any; (f) relevant fitness functions from DESIGN.md §8.4. The replan-agent runs the three-phase cascade:

    - **2a — Exact-requirements replan.** Re-investigate via codebase grep / web search / library docs (Context7) / GitHub issues. Propose a new plan whose acceptance criterion matches the requirement's fit criterion **verbatim** — different approach, different library, different decomposition, same requirement. Return the proposal. If the agent concludes that no feasible plan exists at exact fit, return `status: no_feasible_exact` with reasoning; caller advances to 2b.
    - **2b — Softened-requirements replan.** Only if 2a returned `no_feasible_exact` OR 2a's proposal was reviewer-rejected OR 2a's executed plan failed acceptance. Propose a softened interpretation of the fit criterion (weaker threshold, partial handling, documented carve-out) plus a plan that meets it. Record the original fit criterion and the softened version in the return; do NOT mutate REQUIREMENTS.md. If no softer version is feasible, return `status: no_feasible_softened`; caller advances to 2c.
    - **2c — MoSCoW drop.** Only if 2b returned `no_feasible_softened` OR 2b's proposal was reviewer-rejected OR 2b's executed plan failed acceptance. Propose a drop per Step 2 §8.2 ladder (Won't → Could → Should, never Must). Non-empty `drop_justification` mandatory (§9.2 rule 2). If the requirement is Must-Have, 2c is not valid — the replan-agent returns `status: must_blocked` and the caller triggers hard abort (Step 2 §8.6).

3. **Spawn `tasks-reviewer`** on the replan-agent's proposal. The reviewer runs §6 checks against the proposal as if it were a fresh plan, plus additional replan-specific checks: MoSCoW ladder honoured, `scope_restoration_policy` respected, 50%-Should-drop ceiling not exceeded, softening (if 2b) is actually weaker than the original and not equivalent.

4. **Apply reviewer verdict:**
   - Reviewer PASS on 2a → edit `docs/TASKS.md` in place with the new plan (allowed edits: split a task into smaller tasks, merge two tasks, rewrite an acceptance criterion, add `Required files`, change model tier, add a new task, mark a task blocked on a new dep spike). INCIDENT entry moves to `status: resolved` with `resolution:` citing the new plan. Resume execution.
   - Reviewer PASS on 2b → same as PASS on 2a, plus append the softened fit criterion to the INCIDENT entry's diagnostics (for round-trip consumption by `scope_restoration_policy`).
   - Reviewer PASS on 2c → apply the drop per Step 2 §8.2. INCIDENT entry populates `dropped_items` with `moscow_class`, `drop_reason`, `drop_justification`, `restore_conditions`. Resume execution with reduced scope.
   - Reviewer FAIL on any phase → replan-agent re-runs within the same rung with the reviewer's findings (one re-run allowed per rung). Second FAIL on the same rung advances to the next rung.
   - Replan-agent returns `status: must_blocked` → trigger Step 2 §8.6 hard abort with `halt_reason: must_blocked_no_fallback`.

5. **Counter management.** The orchestrator maintains `replan_count: <n>` in TASKS.md header. Increment on each **completed** replan cycle (reviewer PASS or final FAIL). On `replan_count > 3`, the re-plan kill switch fires: halt, write `docs/RUN_REPORT.md` with `halt_reason: replan_count_exceeded`, stop. Do not loop indefinitely.

6. **No owner gate.** Step 3 is autonomous. The `tasks-reviewer` PASS is the only approval. If the cascade exhausts all three rungs without a PASS, hard abort is the outcome — not owner escalation (the owner is unreachable by contract).

---

## 8.5 Agent Economics & Context Management

This section is the core agent-specific adaptation. Human project plans do not need it. Agent harnesses do.

### 8.5.1 Cost model

Every message pays: **input tokens × input price** (or cache-read price if the prefix was cached) **plus output tokens × output price**. Output is ~5× input across the Claude family. Every tool call is a message. Every subagent return becomes context for the next orchestrator message — so subagent outputs are paid for repeatedly for the rest of the orchestrator's session unless cleared.

Standard pricing (per 1M tokens):

| Model | Input | Cache read | 1h cache write | Output |
|---|---|---|---|---|
| Opus | $5.00 | $0.50 | $10.00 | $25.00 |
| Sonnet | $3.00 | $0.30 | $6.00 | $15.00 |
| Haiku | $1.00 | $0.10 | $2.00 | $5.00 |

Implication: an orchestrator with 100K tokens of accumulated context on Opus pays $0.50 per *cached* message and $5.00 per uncached one. Letting context grow to 200K doubles that. Clearing costs nothing; not clearing costs every remaining message of the run.

### 8.5.2 Model tiering (prescriptive)

Canonical list lives in the §8 policy header under "Model tiering". One source; this section covers rationale only.

- **Orchestrator Opus** — plan-coder gap reasoning + replan decisions; short sessions after each `/clear` bound cost.
- **Executor Sonnet default, Opus on high-risk** — Sonnet competitive with Opus on typical SWE-bench; Opus paid for security/data/user-facing impact.
- **Reviewer tier = executor risk** — low→Haiku (structural only), medium→Sonnet, high→Opus. Review is last gate before irreversible action.
- **Research / replan-agent / tasks-reviewer: Sonnet** — read-only or structural; Opus not justified.
- **Trivial Haiku** — most trivial tasks should be merged (§6.3); remainder goes to Haiku.

**Fallback rules:**
- Opus unavailable / rate-limited → fall back to Sonnet AND add a second independent reviewer pass. No silent fallback.
- Fast-mode Opus (6× pricing) is never used in Step 3 — breaches Step 1 budget cap on any non-trivial session.

### 8.5.3 Clear-per-boundary protocol (the core pattern)

Context is cleared at deterministic boundaries, not on token-count triggers. Triggers are safety nets.

**Natural clear boundaries:**
- Between task waves on the orchestrator.
- After any subagent that wrote > 20K tokens of output to files.
- After any failed task + reviewer cycle that was resolved.
- Between `docs/TASKS.md` phases (Setup, Foundational, per-user-story, Polish — see Spec-Kit phasing).

**Resumption protocol:** every resume from a cleared context follows the same four steps, in order:

1. Re-read `CLAUDE.md` (auto-loaded on new session).
2. Re-read `docs/TASKS.md` — the single source of truth for what's done, what's next, what's blocked.
3. For each task about to run: read its `Required files` list into context.
4. Execute using the task's `Continuation prompt`.

What must survive a `/clear` (because it lives on disk):

- `docs/REQUIREMENTS.md`, `docs/CONTEXT.md`, `docs/SCOPE.md`, `docs/SMOKE.md`, `docs/OPEN_QUESTIONS.md` (Step 1); `docs/DESIGN.md`, `docs/GOVERNANCE.md`, `docs/INCIDENT.md` (Step 2); `docs/TASKS.md` (Step 3); `docs/TRACEABILITY.md` (HEAVY only, Step 2 + Step 3).
- `docs/research/*.md` — candidate research and pattern investigation (Step 2 research outputs, Step 3 research spikes).
- `docs/deps/*.md` — dependency reverse-engineering notes (initialised Step 1 HEAVY, refreshed Step 2 / Step 3).
- `docs/handoffs/handoff-<origin>-<topic>-<UTC-date>.md` — orchestrator hand-offs during a multi-step task, partial task outputs during replan freezes, large subagent returns (>20K tokens). Step 2 §1 names the directory; this is the Anthropic community pattern for preserving state across resets [Anthropic multi-agent research], adapted to the Step 2 "all state in docs/" rule.
- Task status (pending / in_progress / completed / blocked) persisted in `TASKS.md` itself (per-task status field) — do NOT rely on `.claude/tasks/` or any Claude Code internal state.
- Any source code written, any tests added, any config changed (these are the work product).

What must **not** be relied on surviving a `/clear`:

- Conversation history, intermediate reasoning, tool-call transcripts.
- Any decision made in the session that was not written to a file.
- Subagent return bodies larger than a short summary — persist to file first.
- Orchestrator "working memory" of the current task — must be re-derived from files on resume.

### 8.5.4 Subagent inheritance rules

Subagents do not inherit the same context as the orchestrator. Known constraints:

- Subagents do not inherit skills by default. If a skill is needed, invoke it explicitly or include its instructions in the subagent's prompt.
- The Explore and Plan subagents (Claude Code defaults) do not receive `CLAUDE.md`. All others do.
- Subagents receive only the prompt and the tool set explicitly granted.
- Subagents run in isolated sidechain transcripts; their conversation does not pollute the orchestrator's context. Only their summary return is paid for by the orchestrator [Claude Code architecture, arXiv 2604.14228].

Implication: for every subagent spawn, pass the minimal necessary context via prompt plus file references — never assume the subagent has access to anything from the orchestrator's recent turns.

**Subagent types used by Step 3 (concrete `subagent_type` strings).** Naming convention matches Step 2 §0.1: external / plugin-provided agents carry a namespace prefix (`agentfiles:*`); project-internal agents use bare names and resolve to `plugin/agents/<name>.md` in this repo.

| Purpose | `subagent_type` | Prerequisite |
|---|---|---|
| Decomposition reviewer (§6) | `tasks-reviewer` (project-internal) | `plugin/agents/tasks-reviewer.md` must exist |
| Replan cascade (§8.6 rung 2) | `replan-agent` (project-internal) | `plugin/agents/replan-agent.md` must exist |
| Monitor agent (HEAVY only, per-task) | `tasks-reviewer` with a monitor-checklist prompt variant | same as decomposition reviewer |
| Research / dep spike | `general-purpose` (always available in Claude Code) | n/a |
| Task executor | spawned by Step 4, not Step 3; Step 3 only specifies the model tier | n/a |

If any prerequisite agent file is missing at the time of spawn, Step 3 halts with `docs/RUN_REPORT.md` (Step 2 §1.1 schema, `phase: step3`, `halt_reason: missing_precondition`) naming the missing file. Do not improvise a substitute.

### 8.5.5 Cache strategy

The 1h cache write costs 2× input price but is read at 10% input price, so the break-even is 3 cached reads. Rules:

- **Write a 1h cache** iff the current wave's plan (as recorded in `TASKS.md`) already includes ≥ 3 subagent spawns sharing the same prefix (e.g., all reviewers reading the same `TASKS.md` header), OR iff a task has ≥ 3 sequential executor turns reading the same `Required files` list. The decision is made from `TASKS.md`, not from prediction.
- **Do not write a 1h cache** for one-off prefixes.
- **Do not write a 1h cache** for any prefix that will be cleared by the next wave-boundary `/clear`. The write cost is wasted.
- **Use the 5m cache** (cheaper; $6.25/MTok on Opus vs $10.00 for 1h) for prefixes reused within the same wave only.

### 8.5.6 Output brevity

Output tokens are the dominant cost driver — priced 5× input. Reviewer reports, subagent returns, and orchestrator planning messages cap output length:

- Reviewer report: 500 words max (see Step-1 reviewer agent template).
- Research subagent return: 600 words max.
- Task executor return: a one-paragraph summary plus a file reference. The full detail is in the file.
- Orchestrator plan revision: diff against `TASKS.md`, not a full rewrite.

These caps are expressed in the continuation prompt for subagents so the constraint is enforced at spawn, not retroactively.

---

## 9. Anti-Patterns (must not do)

| Anti-pattern | Why it fails |
|---|---|
| Task without an acceptance criterion, OR acceptance that restates the description | Plan-coder gap 75.3% of failures [arXiv 2510.10460]; executor has no target and monitor cannot verify |
| Retry without diagnosis; "just loop until it works" as escalate condition | Claude Code #29944/#41659; MAST FM-1.3 step repetition 15.7% [arXiv 2503.13657] |
| Single long-lived agent context for full run | Self-conditioning [arXiv 2509.09677]; context rot continuous decay [trychroma.com/research/context-rot] |
| Continuation prompt that depends on conversation memory | Breaks `/clear` resumption; contradicts state-in-files invariant [Anthropic multi-agent] |
| Task with non-trivial deps but no declared `Required files` | Executor hallucinates missing context [arXiv 2509.18970] |
| Granularity failures: mega-task (unreviewable) OR trivially-small tasks (orchestration tokens dominate) | Both reviewed at §6.3; reject at gate |
| `parallel_safe: yes` without disjoint file/endpoint verification | Silent write conflicts in parallel waves |
| Self-review by the executor; unstructured multi-agent debate | Sycophancy toward own output [arXiv 2411.15287]; up to 17.2× error amplification [Google DeepMind 2025] |
| Main orchestrator / failing executor proposing its own replan | Anti-sycophancy rule. Use `replan-agent` + `tasks-reviewer` gate (§8.6) |
| Dropping a requirement without `tasks-reviewer` PASS | MoSCoW drops are gated (Step 2 §8.2); autonomous unreviewed drop = "easy path" forbidden by CLAUDE.md |
| Running every task on Opus "to be safe" OR silent Opus→Sonnet fallback on high-risk | Budget burn; silent capability drop. Fallback requires second reviewer pass |
| Creating `.claude/reports/*.md` or `.claude/tasks/*` | State lives in `docs/`. `INCIDENT.md` for logs; `RUN_REPORT.md` for halts; `docs/handoffs/` for transient |

---

## 10. When to Stop (Exit Criteria)

All must hold before Step 4 (execution) begins. Step 3 is autonomous — there is no owner-confirmation criterion; the reviewer's PASS is the final gate.

1. `docs/TASKS.md` exists, DAG is acyclic, every task has an acceptance criterion, parallel-safe claims verified. T1 is the walking-skeleton implementation task per §3/§4/§5; every other task is transitively `Blocked by: [T1]`.
2. Coverage: every in-scope `R<n>` in `SCOPE.md` cited in `Traces to:` on ≥1 task; every `S<k>` in `SMOKE.md` cited in `Smoke step:` on ≥1 task; every `RSK<n>` in `GOVERNANCE.md` has a mitigation task or an `Escalate on` clause on a relevant task. HEAVY only: the same facts are also logged in `docs/TRACEABILITY.md`.
3. If `SCOPE.md` `budgets:` has any entry scoped to `step3` or `total`: for each such entry, the sum of every task's `Estimated budget` (in that entry's unit) ≤ the entry's `cap`. If `budgets:` is empty, this check is skipped.
4. `tasks-reviewer` subagent returned `PASS` with no outstanding findings (two consecutive PASSes on HEAVY — see §5).
5. Every task has a `Continuation prompt` and `Required files` list. The reviewer's §6.6 checks all pass.
6. Execution policy header in `TASKS.md` declares the model tier per role, the clear-per-boundary policy, the safety-net triggers, the re-plan counter initial value (`replan_count: 0`), the `Budgets:` block (copy of SCOPE.md entries scoped to `step3` or `total`), the `Wave fitness gates:` list, and the `Continuous fitness monitors:` list.
7. Every fitness function in `DESIGN.md` §8.4 is wired according to its `wired_at:` (per-task in some task's `Fitness gates:`; per-wave in the header's wave-gates list; continuous in the header's continuous list).
8. `docs/RUN_REPORT.md` does NOT exist. If it does, see §10.1.

If any criterion fails, Step 3 is not complete. Do not begin execution.

### 10.1 Halt recovery

A `docs/RUN_REPORT.md` is terminal for the current run. It is never silently cleared. When a fresh context resumes Step 3 and finds `RUN_REPORT.md` present, follow this procedure:

1. **Read the RUN_REPORT.** It contains the `halt_reason`, `phase`, affected task(s), pending owner questions, budget spent, and a next-step recommendation (Step 2 §1.1 schema).
2. **If `phase: step2`:** Step 3 cannot recover from a Step 2 halt. Write an INCIDENT.md entry (`status: deferred`, `trigger: "Step 2 halted — cannot start Step 3"`) and stop. The owner must resolve Step 2 first.
3. **If `phase: step3`:** read `docs/TASKS.md` in full. Reconcile: which tasks are `completed`, which are `in_progress` (never resumed after halt), which are `pending`. Count completed vs. total.
4. **Check Step 3 exit criteria 1–7 (§10).** If all pass except criterion 8, the halt was transient and the work is intact — the owner may delete `RUN_REPORT.md` to resume. The halt-recovery procedure does not delete it autonomously.
5. **If exit criteria 1–7 fail (decomposition is incomplete or corrupt):** the halt was fatal. Do not retry automatically. Append a new INCIDENT.md entry naming the unrecoverable state (`status: deferred`, `detection: agent_self_report`), and stop. The harness is now outside Step 3's responsibility — the next runtime layer (observer, operator, next phase orchestrator) decides whether to re-plan from Step 2, abandon the project, or intervene.
6. **The halt-recovery procedure itself never writes to `docs/TASKS.md` or `docs/TRACEABILITY.md`.** It only reads, writes INCIDENT entries, and optionally appends context to `RUN_REPORT.md`. Structural edits require a fresh Step 3 run triggered by the next runtime layer.

---

## 11. Citations

**Plan-coder gap and mitigation:**
- Understanding and Bridging the Planner-Coder Gap in Multi-Agent Code Generation. arXiv 2510.10460. https://arxiv.org/abs/2510.10460
- Planning In Natural Language Improves LLM Search For Code Generation (PlanSearch). arXiv 2409.03733. https://arxiv.org/abs/2409.03733
- Idea First, Code Later: Disentangling Problem Solving from Code Generation. arXiv 2601.11332. https://arxiv.org/abs/2601.11332
- Architecting Resilient LLM Agents: Secure Plan-to-Execute Patterns. arXiv 2509.08646. https://arxiv.org/abs/2509.08646

**Planning methods (LLM era):**
- Plan-and-Solve Prompting. arXiv 2305.04091. https://arxiv.org/abs/2305.04091
- ReAct. arXiv 2210.03629. https://arxiv.org/abs/2210.03629
- Reflexion. arXiv 2303.11366. https://arxiv.org/abs/2303.11366
- Tree of Thoughts. arXiv 2305.10601. https://arxiv.org/abs/2305.10601
- Graph of Thoughts. arXiv 2308.09687. https://arxiv.org/abs/2308.09687
- LATS. arXiv 2310.04406. https://arxiv.org/abs/2310.04406
- ADaPT (As-Needed Decomposition and Planning). arXiv 2311.05772. https://arxiv.org/abs/2311.05772
- Survey: Understanding the Planning of LLM Agents. arXiv 2402.02716. https://arxiv.org/abs/2402.02716

**Failure-mode evidence:**
- Beyond pass@1: long-horizon reliability. arXiv 2603.29231. https://arxiv.org/abs/2603.29231
- HORIZON benchmark. arXiv 2604.11978. https://arxiv.org/abs/2604.11978
- MASFT: Why Do Multi-Agent LLM Systems Fail? arXiv 2503.13657. https://arxiv.org/abs/2503.13657
- MAST (NeurIPS 2025): multi-agent system traces. Referenced in the MASFT paper.
- Measuring Long-Horizon Execution in LLMs (self-conditioning). arXiv 2509.09677. https://arxiv.org/abs/2509.09677
- Plan compliance study. arXiv 2604.12147. https://arxiv.org/abs/2604.12147
- SWE-bench Verified discriminative subsets analysis. https://jatinganhotra.dev/blog/swe-agents/2025/06/05/swe-bench-verified-discriminative-subsets.html
- OSWorld-G grounding ablation. https://github.com/xlang-ai/OSWorld-G
- Sycophancy in LLMs: Causes and Mitigations. arXiv 2411.15287.
- CONSENSAGENT (multi-agent sycophancy). ACL Findings 2025. https://aclanthology.org/2025.findings-acl.1141/
- Berkeley RDI: Trustworthy Benchmarks (benchmark integrity concerns). https://rdi.berkeley.edu/blog/trustworthy-benchmarks-cont/

**Production systems (primary sources):**
- Cognition Devin 2.0. https://cognition.ai/blog/devin-2
- Claude Code TaskCreate schema. Claude Code issue #21901. https://github.com/anthropics/claude-code/issues/21901
- Claude Code todo tracking docs. https://code.claude.com/docs/en/agent-sdk/todo-tracking
- Claude Code retry / kill-switch bugs. Issues #29944, #35166, #41659, #464. https://github.com/anthropics/claude-code/issues
- GitHub Spec-Kit. https://github.com/github/spec-kit
- Spec-Kit tasks template. https://github.com/github/spec-kit/blob/main/templates/tasks-template.md
- AWS Kiro. https://kiro.dev/docs/specs/
- Cursor agent best practices. https://cursor.com/blog/agent-best-practices
- Cursor 25-tool-call limit. https://forum.cursor.com/t/how-to-continue-when-25-tool-call-limit-is-reached/62836
- GitHub Copilot Workspace user manual. https://github.com/githubnext/copilot-workspace-user-manual/blob/main/overview.md
- OpenHands. arXiv 2407.16741. https://arxiv.org/abs/2407.16741
- SWE-agent. arXiv 2405.15793. https://arxiv.org/abs/2405.15793
- Aider architect/editor mode. https://aider.chat/2024/09/26/architect.html

**Orchestration frameworks:**
- LangGraph persistence and retry. https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph RetryPolicy reference. https://reference.langchain.com/python/langgraph/types/RetryPolicy
- OpenAI Agents SDK. https://openai.github.io/openai-agents-python/
- OpenAI Agents SDK exceptions (`DEFAULT_MAX_TURNS=10`). https://openai.github.io/openai-agents-python/ref/exceptions/
- Anthropic orchestrator-worker pattern. https://www.anthropic.com/research/building-effective-agents
- Anthropic multi-agent research system (artifact handoff). https://www.anthropic.com/engineering/multi-agent-research-system
- MetaGPT. arXiv 2308.00352. https://arxiv.org/abs/2308.00352
- ChatDev. arXiv 2307.07924. https://arxiv.org/abs/2307.07924

**Context handoff and subagent isolation:**
- Claude Code five-layer compaction cascade. arXiv 2604.14228. https://arxiv.org/abs/2604.14228
- Anthropic multi-agent coordination patterns. https://claude.com/blog/multi-agent-coordination-patterns
- MemGPT / Letta. arXiv 2310.08560. https://arxiv.org/abs/2310.08560
- OpenHands SDK. arXiv 2511.03690. https://arxiv.org/abs/2511.03690

**Context length degradation and clear/compact heuristics:**
- Lost in the Middle (Liu et al. TACL 2024). arXiv 2307.03172. https://arxiv.org/abs/2307.03172
- RULER benchmark. arXiv 2404.06654. https://arxiv.org/abs/2404.06654
- Chroma Context Rot report (2025). https://www.trychroma.com/research/context-rot
- Claude Code auto-compact thresholds (community-measured). https://claudefa.st/blog/guide/mechanics/context-buffer-management
- Claude Code best practices — `/clear` and `/compact` behavioral triggers. https://code.claude.com/docs/en/best-practices
- Claude API compaction spec. https://platform.claude.com/docs/en/build-with-claude/compaction
- Cognition Devin session limits (10 ACUs / 2.5h). https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges
- LLM agent hallucinations survey. arXiv 2509.18970. https://arxiv.org/abs/2509.18970
- Self-conditioning on errors (long-horizon execution). arXiv 2509.09677. https://arxiv.org/abs/2509.09677

**Pricing reference (per 1M tokens, used in §8.5 cost model):**
- Anthropic Claude pricing. https://www.anthropic.com/pricing

**Internal:**
- `docs/REQUIREMENTS_GATHERING.md` — Step 1 of this harness; source of Rigor Score, traceability convention (`R<n>`), and reviewer-separation pattern.
- `docs/PROCESS_EVALUATION.md` — prior autonomous-run post-mortem; evidence for the self-conditioning and retry-without-diagnosis failure modes.
