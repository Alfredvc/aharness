# Requirements Gathering — Step 1 of Autonomous Agent Harness

Dynamic, risk-scaled requirements elicitation for an LLM agent working with a human product owner. Designed for projects where the agent will execute autonomously after this phase closes — meaning gaps here become unrecoverable downstream cost.

---

## 0. Operating Principles

1. **Scale rigor to risk, not to convention.** Signals (not tradition) decide depth [Boehm & Turner 2004; Cockburn 2004; Snowden 2007].
2. **Requirements defects are the most expensive class of defect.** Directional consensus: fixing in maintenance is ~20–40× requirements-phase cost on large projects, ~4× on small ones [Boehm 1981; NASA NTRS 20100036670]. Precise multipliers are disputed [Bossavit 2012; The Register 2021]; direction is not.
3. **Every requirement must be testable.** A Volere **fit criterion** — a measurable condition that decides whether the delivered system satisfies it — is mandatory [Robertson & Robertson, *Mastering the Requirements Process* 3rd ed.].
4. **Done = user-visible walkthrough, not artifact presence.** Typecheck-green and unit-tests-green are weak signals of fitness for use.
5. **The agent is not the end user, and neither is the product owner if the real user is someone else.** Cooper's "elastic user" and "proxy user" anti-patterns apply double for LLMs [Cooper, *The Inmates Are Running the Asylum*, 1999; Mind the Product 2018].
6. **LLMs are sycophantic by default (58% rate across GPT-4o / Claude Sonnet / Gemini 1.5 Pro).** They fabricate confirmatory evidence for loaded questions [arXiv 2411.15287]. Counter-patterns are mandatory, not optional.

---

## 1. Inputs and Outputs

**Inputs:** an initial brief from the product owner (free text, any length), plus any reference artifacts they attach (code, screenshots, existing product, environment constraints, budget cap).

**Outputs (committed to repo):**

| File | Purpose |
|---|---|
| `docs/REQUIREMENTS.md` | Stakeholder + system requirements, each with a Volere fit criterion |
| `docs/CONTEXT.md` | Product-owner profile, real-user profile, taste references, success definition |
| `docs/SCOPE.md` | In-scope slice for this build (size is whatever the owner asked for — from a minimum viable subset up to a full-product release), explicit non-goals, risk register, `budgets:` list (see §8.4) |
| `docs/SMOKE.md` | End-to-end acceptance walkthrough (runnable script or step list) that defines "done" |
| `docs/OPEN_QUESTIONS.md` | Unresolved items, with the blast radius of each if left unresolved |

All five are prerequisites for Step 2 (design/planning) of the harness.

---

## 2. Phase 0 — Triage (always runs, ≤5% of requirements budget)

Cheap classification drives every branch below. **Do not skip even on obviously small projects** — the signal cost is low, the miss cost is high.

### 2.1 Score the project on five factors

Based on Boehm & Turner's home-ground model [*Balancing Agility and Discipline*, 2004, ch. 2; also IEEE Computer 36(6) 2003]:

| Factor | Low (1) | Medium (2) | High (3) |
|---|---|---|---|
| **Size** (LOC, team, stakeholders) | Script / one user / one repo | Service / small team / multi-repo | Platform / many users / many repos |
| **Criticality** [Cockburn scale] | Loss of comfort | Discretionary money | Essential money or life |
| **Novelty** (to this codebase & agent) | Well-trodden pattern | Some new tech | Closed-source, undocumented, or research-grade dep |
| **End-user gap** | Owner = user | Owner ≈ user (same segment) | Owner ≠ user (e.g., building for one's mother) |
| **Change rate** (how fast reqs will move) | Stable | Some drift | Rapidly changing / unknown |

Sum = 5–15. This is the **Rigor Score**.

### 2.2 Branch on Rigor Score

- **5–7 → LIGHT path** (§3)
- **8–11 → STANDARD path** (§4)
- **12–15 → HEAVY path** (§5)

Override rules (any one forces HEAVY regardless of score):
- Any life-critical criticality (Cockburn L).
- Any regulatory constraint (FDA, GDPR data processor, PCI, HIPAA).
- Any closed-source or undocumented runtime dependency (e.g., a binary with no public protocol spec).

### 2.3 Classify domain

Apply Cynefin [Snowden & Boone, HBR 2007; InfoQ interview with Snowden]:

- **Clear / Complicated** → continue on branch selected above.
- **Complex** → do **not** do big upfront requirements. Instead, run a small continuous-discovery loop [Torres, *Continuous Discovery Habits*, 2021]: one narrow deliverable, observe, expand. Record this choice in `SCOPE.md`.

### 2.4 Elicit budgets

Before the path-specific elicitation begins, ask the owner what budget constraints exist. Project budgets are project-dependent — commercial runs cap dollars and wall time; API-bound runs cap tokens; hobby runs may have no cap at all. Use one `AskUserQuestion` call with the options `dollars`, `tokens`, `hours`, `no cap`, `multiple` (multiSelect acceptable). For each selected unit, follow up with a numeric cap question. Write the results into `SCOPE.md` using the §8.4 schema (`budgets: [...]` list; empty list for "no cap" declarations).

A budget entry must declare its `scope` field: `total` (whole harness), `step1`, `step2`, or `step3`. If the owner only states a total cap, record one entry with `scope: total`; per-phase allocation is Step 2's concern (Step 2 apportions the total across phases during its pre-flight).
- **Chaotic** → stop. Escalate to human. Requirements gathering is not the right first move.

---

## 3. LIGHT Path (~30 min of agent time, single interview round)

**Use when:** Rigor Score 5–7, owner is also the user, requirements are functional and cleanly scoped.

### 3.1 Steps

1. **Restate the brief in one paragraph.** Send it back. Wait for explicit "yes" or corrections.
2. **Ask 5–8 clarifying questions in one batch** using `AskUserQuestion`. One question per tool call slot, not stacked inline. Force a choice where possible (multiple-choice) — free-text answers are lower quality [Pacheco 2018, IET Software].
3. **Extract hard requirements from the brief into a checklist.** Re-read the source text; do not paraphrase from memory. Every noun and verb with a constraint becomes a requirement line.
4. **Write a Volere fit criterion for each.** If you cannot write one, the requirement is not yet a requirement — go back and clarify.
5. **Define the smoke walkthrough** in `SMOKE.md`: the user-visible sequence that proves the thing works. Minimum: one golden path + one failure path.
6. **Run the review gate** (§6).
7. **Confirm with owner.** One message, bullet list of requirements + smoke steps. Wait for "yes."

Time-box: if this takes longer than 60 minutes of wall time or ≥3 rounds of clarification, **upgrade to STANDARD**.

---

## 4. STANDARD Path (~2–4 hours, multi-round)

**Use when:** Rigor Score 8–11, or owner ≠ user but by a narrow margin (same segment), or some novel tech.

### 4.1 Steps

1. **Profile the product owner** (`CONTEXT.md` section 1). Questions:
   - Technical background? What do they build themselves?
   - Taste references — 3 existing products they admire, 3 they dislike, and **why specifically** for each.
   - Prior art they have built toward this problem. Ask for links / paths.
   - Success definition: "What would a perfect outcome look like to you six months from now?"
2. **Profile the real end user** (`CONTEXT.md` section 2) — separately from the owner. If owner ≠ user, also ask:
   - Who specifically (not a category — a named person or a concrete persona per Cooper 1999).
   - What devices do they use? What apps do they use daily?
   - Known accessibility constraints (age, vision, motor) — map to WCAG 2.1/2.2 criteria if relevant [W3C WAI: Older Users].
   - Do **not** accept proxy descriptions as ground truth. Flag them as assumptions to validate [Mind the Product on proxy users].
3. **Elicit requirements** via structured interview, one question at a time [LLMREI, arXiv 2507.02564 — long-prompt 5-step protocol outperformed zero-shot, 64% vs 59% error reduction]. Use `AskUserQuestion` in batches of 3–5 per round, 2–4 rounds total.
4. **Apply Kano classification** to each requirement [Kano 1984]: Must-have / Performance / Delighter / Indifferent / Reverse. This exposes hidden must-haves the owner takes for granted.
5. **Write user stories in INVEST-compliant form** [Wake 2003, Cohn 2004] OR job stories [Klement 2013] if personas are weak. Default to job stories when the owner is not the user.
6. **Write Volere fit criteria** for every requirement. No fit criterion ⇒ not a requirement yet.
7. **Story-map the release slice** [Patton 2014]: backbone of user activities left-to-right, priorities top-to-bottom. The slice size depends on what the owner asked for — a minimum viable subset if the brief framed it that way, a fuller set if the owner explicitly asked for a full product. Do not default to "minimum" when the owner's brief does not ask for minimum. Slice the first horizontal band as the in-scope set for this build. Everything below the line goes to `SCOPE.md` non-goals (or a "future releases" section if the owner plans iteration).
8. **Define smoke walkthrough** (`SMOKE.md`): golden path + 2–3 failure paths + acceptance criteria in Given-When-Then form [North 2003; Adzic 2011].
9. **Run the review gate** (§6).
10. **Restate and confirm.** Structured bullet summary of all artifacts. Wait for explicit approval.

---

## 5. HEAVY Path (≥1 day, formal artifacts)

**Use when:** Rigor Score 12–15, regulated, life-critical, closed-source dependency, or any override in §2.2 triggered.

### 5.1 Steps

1. **All STANDARD steps.**
2. **Dependency reverse-engineering spike before writing requirements against undocumented deps** [process-eval lesson: skipping this cost $25 of $66 burn on prior run]. Spawn a read-only research subagent to extract the protocol / API / behavior into a notes file. Requirements that depend on the dep are blocked until notes exist.
3. **Formal requirements specification** using Volere template [Robertson & Robertson, *Mastering the Requirements Process* 3rd ed., 21 sections]. Functional, non-functional, and constraints separated.
4. **Hazard / threat analysis.** FMEA-lite for safety; threat model for security. Agile lightweight techniques explicitly do not cover this [Nuseibeh & Easterbrook 2000; Perforce/DA on safety-critical agile].
5. **Traceability matrix.** Every requirement → design element → test. Required for regulated work; cheap insurance otherwise.
6. **Fagan-style inspection of the requirements doc** [Fagan 1976; NASA SWE-087]. Empirically 60–90% defect removal on requirements artifacts [IBM/NASA data]. For an agent harness: spawn a dedicated review subagent with "find contradictions, missing NFRs, untestable requirements" as the single instruction.
7. **Two rounds of user confirmation.** First round: requirements + scope. Second round: after `SMOKE.md` is drafted, walk through it with the owner before lock-in.

---

## 6. Review Gate (all paths)

Run before claiming requirements are complete. Every check must pass.

### 6.1 Content checks

- [ ] Each requirement has a Volere fit criterion [Robertson & Robertson].
- [ ] No requirement contains "fast," "easy," "intuitive," or similar unmeasurable words without a fit criterion that quantifies it.
- [ ] Hard requirements from the original brief are all present in the checklist (re-read source, do not rely on memory).
- [ ] Non-functional requirements (performance, security, accessibility, privacy) are present — not only functional. Absence of NFRs is the most common agile-lightweight failure [Nuseibeh & Easterbrook 2000].
- [ ] Each requirement is traceable back to a quoted sentence from the owner or a documented design decision.

### 6.2 Agent-specific checks (LLM failure modes)

- [ ] **Sycophancy audit.** Re-read the conversation. Count places the agent agreed without pushback. Flag any "reasonable-sounding" requirement that came from the agent, not the owner, and mark it for owner re-confirmation [arXiv 2411.15287 — 58% baseline sycophancy rate].
- [ ] **Hallucination audit.** Every claimed external fact (pricing, API capability, dep behavior) cites a URL or file path [LLMREI paper: fabricated price estimates]. Lookups via Context7 for library docs must actually call `query-docs`, not only `resolve-library-id` [process-eval: 22 abandoned resolve calls on prior run].
- [ ] **Scope audit.** Re-read the brief. Anything in requirements that is NOT in the brief is a scope creep candidate and must be justified in writing.
- [ ] **Ambiguity audit.** For every noun and verb in a requirement: is there exactly one reasonable interpretation? If two interpretations differ in effort by >2×, it is ambiguous.
- [ ] **Devil's Advocate pass** [Chuniversiteit prompt patterns catalogue]: the agent role-plays "skeptical reviewer" and attacks the requirements set for 1 pass. Any surviving objections go to `OPEN_QUESTIONS.md` or back to the owner.
- [ ] **Repeat-correction detector.** Scan the conversation for user corrections repeated more than once ("no, I said X"). Each repeat is a signal the agent is not integrating feedback — re-read the original turn verbatim.

### 6.3 Fitness-to-close checks

- [ ] `SMOKE.md` describes a user-visible walkthrough that can be run end-to-end, not only a code-level test plan [process-eval lesson: unit tests green ≠ works].
- [ ] Budget allocation per downstream phase is in `SCOPE.md` with risk factors that would trigger re-planning.
- [ ] `OPEN_QUESTIONS.md` exists and every item has a blast radius ("if unresolved: small / medium / large, and why").

---

## 7. Asking Questions (conversational protocol)

These rules apply across all paths.

1. **One question per turn** is an empirical winner for LLM interviewers [LLMREI, arXiv 2507.02564]. Inline stacking ("also, and, plus…") degrades response quality.
2. **Prefer `AskUserQuestion` over inline prose questions.** Multiple-choice reduces ambiguity and owner cognitive load. Include 3–5 options with "other" as an escape hatch.
3. **Batch related questions in one call** to avoid round-trip tax — but each question remains a separate item with its own options.
4. **Persona priming** improves interviewer behavior: "You are conducting a requirements elicitation interview" [arXiv 2507.02858].
5. **Mistake-guided generation:** before asking, check the interviewer-mistake taxonomy (leading questions, stacked questions, solution-prescription) and rewrite [arXiv 2507.02858].
6. **No solutionizing** during elicitation. Questions probe problems and constraints, not implementation [XY problem anti-pattern, Van Bossuyt 2023].
7. **Restate before confirming.** End each major round with "here is what I heard, correct me" — never assume silent agreement.

---

## 8. Artifact Formats

### 8.1 Requirement line format (Volere-lite)

```
R<n>. <Short name>
Description: <one sentence>
Rationale: <why, traceable to owner quote or design note>
Fit criterion: <measurable condition that decides pass/fail>
Priority: <Must / Should / Could / Won't>  [MoSCoW]
Kano: <Must-have / Performance / Delighter / Indifferent>
Source: <quote or owner-turn ref>
```

### 8.2 `SMOKE.md` format

Every step is assigned a stable identifier so downstream steps (design, execution planning) can link to specific walkthrough steps without quoting prose.

- **Preconditions** (env, data, accounts) listed in a preamble block — not part of the numbered sequence.
- **Golden path:** numbered steps, each prefixed with an identifier. Format:
  ```
  S1. <action by the user> — <observable result>
  S2. ...
  ```
  One observable per step (a screen, a file, a CLI output, a log line). Identifiers are monotonically increasing integers starting at 1; they are stable for the lifetime of the project (a renumber breaks downstream traceability).
- **Failure paths:** each introduced by its parent step's id plus a suffix. Format:
  ```
  S2.err1. <what goes wrong> — <expected recovery behavior>
  S2.err2. ...
  ```
  LIGHT allows one failure path per run; STANDARD and HEAVY require ≥2 per run across the golden path.
- **Artifacts captured on success** (screenshot path, curl log reference, expected file contents) listed after the paths, keyed to the `S<k>` they validate.

Downstream consumers (`docs/TRACEABILITY.md`, Step 3's task schema `Smoke step: S<k>` field) resolve `S<k>` against this file. Any `S<k>` reference that doesn't match an id here is a dangling reference — reviewers flag it.

### 8.3 `OPEN_QUESTIONS.md` format

```
Q<n>. <Question>
Why unresolved: <owner unavailable / needs external research / conflicting signals>
Blast radius if left unresolved: <small | medium | large> — <one-sentence reason>
Proposed resolution path: <ask owner | research step | prototype test>
```

This is the **canonical** OPEN_QUESTIONS.md schema. Step 2 and Step 3 append to this file using the same shape — they do not invent alternate schemas. Step 2 findings map to the schema thus: the plan-critique concern becomes the `Q<n>` text; `Why unresolved` is the finding's source (e.g., "surfaced by plan-critique"); `Blast radius` derives from severity (Must-address → large; Should-address → medium); `Proposed resolution path` carries the reviewer's suggestion verbatim.

### 8.4 `SCOPE.md` budget block

Projects vary in what constraints exist — commercial runs cap dollars and wall time, API-bound runs cap tokens, hobby runs have no cap at all. `SCOPE.md` therefore carries a **list** of 0 or more budget blocks, elicited from the owner. Empty list is a valid state: the autonomous run is not gated by any budget condition.

```yaml
budgets:
  - unit: "dollars" | "tokens" | "hours"
    cap: <positive number>           # in the chosen unit
    warn_at: <percentage, e.g. 70>   # soft trigger; escalate to replan cascade
    abort_at: <percentage, e.g. 130> # hard trigger; §8.6 abort in Step 2, kill switch in Step 3
    scope: "total" | "step1" | "step2" | "step3"   # which phase(s) this budget applies to
```

Rules:
- Zero entries (`budgets: []`) → no budget-based abort. Non-budget abort conditions (e.g., walking-skeleton triple-fail in Step 2 §8.6) still fire.
- Multiple entries allowed. A commercial run might declare a dollar cap for the whole project AND a wall-time cap for Step 3. Any one entry hitting its `abort_at` triggers the abort.
- `scope: "total"` applies to the full harness lifetime. Phase-scoped entries apply only to that phase's agent time.
- Units are tracked separately per entry — the harness does not convert between them. If the owner wants a dollar-denominated cap, the orchestrator measures dollars spent; if tokens, tokens consumed.

Elicitation: Step 1 asks the owner "what are your limits?" using `AskUserQuestion` with the unit as the question's decision point, and the cap as the numeric follow-up. If the owner declines all three (no dollar cap, no token cap, no wall-time cap), record an empty list and note the acceptance in `CONTEXT.md`.

---

## 9. Anti-Patterns (must not do)

Direct evidence from literature and from the prior-run process evaluation:

| Anti-pattern | Source |
|---|---|
| "As a user, I want…" stories where persona is undifferentiated | INVEST: failing the "V" (Valuable) [Wake 2003] |
| Requirements stated as solutions (XY problem) | Van Bossuyt 2023 on stakeholder bias |
| Missing NFRs — performance, security, accessibility, privacy | Nuseibeh & Easterbrook 2000 |
| Proxy owner speaks for real user without validation | Cooper 1999; Mind the Product 2018 |
| Self-score against file presence and passing tests | Process eval §6 — 33/45 self-score on "unusable" delivery |
| Skip protocol discovery for undocumented deps | Process eval — $25 of $66 burn on protocol reverse-eng in deploy phase |
| Single-question JAD workshop with 3 stacked questions | LLMREI paper; Pacheco 2018 |
| Agreeing with every owner suggestion | Sycophancy, 58% baseline [arXiv 2411.15287] |
| Gold plating / scope creep during elicitation | minware.com; classical PM literature |
| Accepting a "pragmatic" shortcut without surfacing it to owner | Global CLAUDE.md rule |

---

## 10. When to Stop

Exit criteria (all must hold):

1. All five output files exist and pass §6.
2. Owner has explicitly confirmed requirements + smoke walkthrough in a single statement.
3. `OPEN_QUESTIONS.md` has no items with "large" blast radius unresolved.
4. Rigor Score was applied — not skipped — and recorded in `SCOPE.md`.
5. `SCOPE.md` contains a `budgets:` list per §8.4 (zero or more entries); if non-empty, every entry has `unit`, `cap`, `warn_at`, `abort_at`, and `scope` fields filled.
6. `SMOKE.md` every step carries a `S<k>` identifier per §8.2; failure paths use the `S<k>.errN` form.

If any criterion fails, the step is not done. Do not proceed to Step 2 of the harness.

---

## 11. Citations

Requirements standards and textbooks:
- ISO/IEC/IEEE 29148:2018 — *Systems and software engineering — Life cycle processes — Requirements engineering.* https://www.iso.org/standard/72089.html
- SWEBOK v3, Ch. 1 *Software Requirements.* http://swebokwiki.org/Chapter_1:_Software_Requirements
- Robertson, J. & Robertson, S. *Mastering the Requirements Process*, 3rd ed. https://www.volere.org/
- Wiegers, K. *Software Requirements*, 3rd ed. https://www.karlwiegers.com/
- Sommerville, I. *Software Engineering*, 10th ed.

Elicitation evidence:
- Pacheco et al. (2018). Requirements elicitation techniques: SLR. *IET Software*. https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-sen.2017.0144

Lightweight / agile:
- Wake, B. (2003). INVEST in Good Stories. https://agilealliance.org/glossary/invest/
- Cohn, M. (2004). *User Stories Applied.*
- Klement, A. (2013). Replacing the User Story with the Job Story. https://jtbd.info/replacing-the-user-story-with-the-job-story-af7cdee10c27
- Patton, J. (2014). *User Story Mapping.* O'Reilly.
- Adzic, G. (2011). *Specification by Example.* Manning. 2020 retrospective: https://gojko.net/2020/03/17/sbe-10-years.html
- North, D. (2006). Introducing BDD. https://dannorth.net/introducing-bdd/
- Gothelf, J. & Seiden, J. (2013, 3rd ed. 2021). *Lean UX.* O'Reilly.
- Ries, E. (2011). *The Lean Startup.*

Tailoring and risk:
- Boehm, B. (1986). A Spiral Model. https://www.cse.msu.edu/~cse435/Homework/HW3/boehm.pdf
- Boehm, B. & Turner, R. (2004). *Balancing Agility and Discipline.* Addison-Wesley.
- Boehm & Turner (2003). Using Risk to Balance Agile and Plan-Driven Methods. *IEEE Computer* 36(6). https://www.fritz.tips/wp-content/uploads/2016/09/BeohmAndTurner_UsingRiskToBalanceAgileAndPlan-DrivenMethods.pdf
- Cockburn, A. (2004). *Crystal Clear.* Addison-Wesley.
- Snowden, D. & Boone, M. (2007). A Leader's Framework for Decision Making. *HBR.*
- Snowden on Cynefin and requirements (InfoQ). https://www.infoq.com/articles/dave-snowden-leadership-cynefin-requirements/

Failure modes and cost-of-change:
- Boehm, B. (1981). *Software Engineering Economics.*
- NASA NTRS 20100036670. Error Cost Escalation Through the Project Life Cycle. https://ntrs.nasa.gov/api/citations/20100036670/downloads/20100036670.pdf
- Fagan, M. (1976). Design and code inspections. *IBM Systems Journal.*
- NASA SWE-087. https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695472/
- Bossavit, L. (2012). *The Leprechauns of Software Engineering.*
- The Register (2021). Bugs-are-100x claim analysis. https://www.theregister.com/2021/07/22/bugs_expense_bs/
- Standish CHAOS Report 1994. https://personal.utdallas.edu/~chung/SYSM6309/chaos_report.pdf
- Nuseibeh, B. & Easterbrook, S. (2000). Requirements Engineering: A Roadmap. *ICSE 2000 FoSE.* https://www.cs.toronto.edu/~sme/papers/2000/ICSE2000.pdf
- Van Bossuyt et al. (2023). Biases in Stakeholder Elicitation. *Systems* 11:499.

User research / proxy-user problem:
- Cooper, A. (1999). *The Inmates Are Running the Asylum.*
- Beyer, H. & Holtzblatt, K. (1997). *Contextual Design.*
- NN/g: Contextual Inquiry. https://www.nngroup.com/articles/contextual-inquiry/
- NN/g: UX for Senior Citizens. https://www.nngroup.com/reports/senior-citizens-on-the-web/
- W3C WAI: Older Users. https://www.w3.org/WAI/older-users/
- Mind the Product: Proxy Users. https://www.mindtheproduct.com/whats-the-problem-with-proxy-users/
- Torres, T. (2021). *Continuous Discovery Habits.* Opportunity Solution Trees: https://www.producttalk.org/opportunity-solution-trees/
- Kano, N. (1984). Attractive quality and must-be quality. https://en.wikipedia.org/wiki/Kano_model

LLM-driven elicitation (2024–2026):
- LLMREI. arXiv 2507.02564. https://arxiv.org/html/2507.02564v1
- Follow-up question generation. arXiv 2507.02858. https://arxiv.org/abs/2507.02858
- Stakeholder requirements expression with LLM revisions. arXiv 2601.16699.
- Prompt engineering guidelines for RE. arXiv 2507.03405.
- LLMs for RE: SLR. arXiv 2509.11446.
- GenAI for RE: SLR. arXiv 2409.06741.
- Sycophancy in LLMs: Causes and Mitigations. arXiv 2411.15287. https://arxiv.org/html/2411.15287v1
- Marques et al. (2024). Using ChatGPT in SRE. *MDPI Future Internet.* https://www.mdpi.com/1999-5903/16/6/180
- Prompt patterns for software design (Chuniversiteit). https://chuniversiteit.nl/papers/prompt-patterns-for-software-design

Spec-driven tooling:
- GitHub Copilot Workspace. https://githubnext.com/projects/copilot-workspace
- GitHub Spec-Kit. https://github.com/github/spec-kit
- Fowler, M. Understanding Spec-Driven Development. https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html

Internal:
- `docs/PROCESS_EVALUATION.md` — root-cause analysis of prior autonomous run; source for process-eval citations in this document.
