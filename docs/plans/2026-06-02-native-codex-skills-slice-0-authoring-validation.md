# Native Codex Skills Slice 0 Authoring Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development or agentfiles:executing-plans to implement this plan task-by-task. Keep changes inside the plan boundary.

**Goal:** Add the authoring and static-validation foundation for native Codex skill refs without changing runtime injection behavior.
**Upstream context:** `docs/specs/2026-06-02-native-codex-skills-for-fsm-packages-design.md`; `docs/plans/2026-06-02-native-codex-skills-for-fsm-packages-roadmap.md`
**In scope:**
- Add `SkillRefDir`, `AvailableSkillRef`, `fsm.skill.dir(path)`, and top-level `machine.availableSkills`.
- Validate `availableSkills` shape and placement at construction and static verify time.
- Update static path-form validation so skill paths must point at existing `SKILL.md` files.
- Reject dir-form refs in state-level `skills`.
- Update focused tests and any stale internal comments/fixtures directly affected by this slice.
**Out of scope:**
- Loader origin manifests, sidecar/cache serialization, child-FSM transitive availability, Codex protocol additions, app-server startup calls, native structured turn input, runtime dedupe changes, package metadata, and broad public authoring docs.
**Done when:** Authors can construct and statically verify FSMs with `availableSkills: [fsm.skill.dir("../skills"), fsm.skill.path("../x/SKILL.md")]`, invalid placement/shape cases fail before runtime, and existing runtime skill body injection remains unchanged.

---

## Current reality

`packages/core/src/state/skills.ts` defines only name and path refs. The `createFsm()` skill facade exposes callable name refs plus `.path(...)`; it has no `.dir(...)`.

State-level `skills` are typed in `packages/core/src/state/exits.ts` and in the canonical `fsm.state(...)` surface in `packages/core/src/state/createFsm.ts` as `ReadonlyArray<SkillRef>`. Construction-time `validateSkills()` only checks the opaque sentinel and duplicate name/path keys.

`packages/core/src/state/createFsm.ts` defines `CanonicalMachineConfig` with `input`, `data`, `initial`, and `states`; there is no typed `availableSkills` field. `packages/core/src/state/machine.ts` snapshots the raw config before synthesis via `__aharnessRawConfig`, so top-level authoring metadata survives if it is included in the machine config object.

`packages/core/src/verify/verify.ts` currently validates state-level skills only. It has checks for state placement, name shape, duplicate keys, and filesystem resolution through `resolveSkill(...)` when `skillEnv` is provided. Its check set has no `availableSkills` diagnostics and no dir-specific diagnostic.

`packages/core/src/state/skillResolver.ts` still treats name refs as filesystem lookups under repo/home/Codex roots and path refs as arbitrary existing files relative to one `fsmFileDir`. Runtime code in `packages/core/src/runtime/skillInjection.ts` still reads resolved skill files and appends `<skill>` blocks; this slice must not modify that behavior.

Existing focused tests are in `packages/core/test/state.skills.test.ts`, `packages/core/test/verify.test.ts`, and `packages/core/test/state.machine.snapshot.test.ts`. Several current verifier-covered path-form skill examples still point at arbitrary `.md` files and must be migrated when Slice 0 starts rejecting non-`SKILL.md` paths: `packages/core/test/fixtures/create-fsm/input-skills-passive.fsm.ts`, `packages/core/test/fixtures/skills.fsm.ts`, the inline fixture in `packages/core/test/cli.verifyCli.test.ts`, `examples/pirate-roast.fsm.ts`, and `examples/DEMOS.md`.

The root package scripts verified in `package.json` include `pnpm exec vitest run ...` through Vitest, `pnpm run typecheck`, and the full `pnpm run verify` gate. For this slice, targeted Vitest plus typecheck are the required implementation checks; full verify is optional but appropriate before commit.

## Contracts and invariants

- `availableSkills` is top-level FSM metadata. It makes skills discoverable in later slices; it does not inject a skill into any state turn in Slice 0.
- `availableSkills` accepts only path-form and dir-form refs. Name-form refs are invalid because they do not identify a filesystem root.
- State-level `skills` continues to accept only name-form and path-form refs. Dir-form refs are invalid because a directory is not an injectable skill.
- `fsm.skill.path(path)` must point to a file named exactly `SKILL.md` for static verification. Optional missing path refs remain warnings; non-optional missing or non-`SKILL.md` path refs are errors.
- `fsm.skill.dir(path)` must have a non-empty string path and must resolve to an existing directory during static verification.
- `availableSkills` filesystem failures are errors. The state-level optional skip/warning behavior does not apply to run-global availability declarations in this slice.
- Existing runtime manual skill body injection, `resolveAndReadSkills(...)`, nudge composition, and once-per-live-thread key tracking must remain unchanged in this slice.
- No package-level skill-root metadata, install-store metadata, Codex protocol methods, sidecar origin manifest, or cache version changes are introduced in Slice 0.
- Do not add FSM behavior tests. Use focused framework tests and direct static verification surfaces only.

## Verification plan

Required targeted commands:

```bash
pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts packages/core/test/state.machine.snapshot.test.ts
pnpm run typecheck
```

Required broader fixture/example checks after the `SKILL.md` path migration:

```bash
pnpm exec vitest run packages/core/test/loader.inputSchema.test.ts packages/core/test/cli.verifyCli.test.ts packages/core/test/example.publicLoadVerify.test.ts
```

Optional final gate before commit:

```bash
pnpm run verify
```

## Tasks

### Task 1: Extend Skill Ref Types

**Purpose:** Add the dir-form skill ref type and public exports while preserving existing name/path behavior.

**Files:**
- Modify: `packages/core/src/state/skills.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/state.skills.test.ts`

**Acceptance criteria:**
- `SkillRefDir` exists with the same sentinel, `source: "dir"`, and non-empty `path`.
- `AvailableSkillRef = SkillRefPath | SkillRefDir` exists and is exported from the public barrel.
- Existing `SkillRef` remains the state-injection union: `SkillRefName | SkillRefPath`.
- A focused construction helper or factory branch exists for `createFsm()` to produce `SkillRefDir`; it does not need to make low-level `skill(...)` accept dir refs unless required by the implementation.
- Existing `skill("name")`, `skill({ path })`, `skillKey(...)`, and `isSkillRef(...)` behavior remains compatible.

**Implementation notes:**
- Keep the opaque sentinel as the single brand mechanism, but use separate type guards when the state-level `SkillRef` union and top-level `AvailableSkillRef` union need different narrowing.
- If a key helper is added for availability refs, use stable `path:<path>` and `dir:<path>` keys. Do not use dir keys for runtime injection in this slice.
- Update comments in `skills.ts` that describe only two ref shapes; keep them accurate for Slice 0 without documenting later runtime behavior as complete.

**Verification:**
- `pnpm exec vitest run packages/core/test/state.skills.test.ts`
- Expected: new dir factory tests pass and all existing name/path/runtime injection tests continue to pass.

### Task 2: Add Canonical `fsm.skill.dir(...)` and Machine `availableSkills`

**Purpose:** Expose the new authoring surface in `createFsm()` and carry top-level availability metadata through raw machine snapshots.

**Depends on:** Task 1

**Files:**
- Modify: `packages/core/src/state/createFsm.ts`
- Modify: `packages/core/src/state/machine.ts`
- Test: `packages/core/test/state.machine.snapshot.test.ts`

**Acceptance criteria:**
- `CanonicalSkillFacade` includes `.dir(path)`.
- `makeSkillFacade()` wires `.dir(...)` to the underlying skill factory.
- `CanonicalMachineConfig` accepts optional `availableSkills?: ReadonlyArray<AvailableSkillRef>`.
- `fsm.machine({ availableSkills: [...] })` preserves that top-level field in `__aharnessRawConfig`.
- `aharness.machine(...)` also validates top-level `availableSkills` when callers bypass `createFsm()`.

**Implementation notes:**
- Do not lower `availableSkills` into state meta and do not attach it to runtime state nodes.
- Validate only authoring shape here: array, each item is a skill ref, no name refs, no duplicate path/dir entries. Filesystem existence belongs in `verify(...)`.
- Keep `cloneConfigPreservingFns(...)` as the snapshot mechanism; no new clone behavior should be needed.

**Verification:**
- `pnpm exec vitest run packages/core/test/state.machine.snapshot.test.ts`
- Expected: raw snapshot includes `availableSkills`, remains top-level frozen, and existing snapshot assertions still pass.

### Task 3: Reject Dir Refs in State-Level Skills

**Purpose:** Keep state `skills` as injectable skill selections, not skill-root declarations.

**Depends on:** Task 1

**Files:**
- Modify: `packages/core/src/state/exits.ts`
- Modify: `packages/core/src/state/createFsm.ts`
- Test: `packages/core/test/state.skills.test.ts`
- Test: `packages/core/test/verify.test.ts`

**Acceptance criteria:**
- `state({ skills: [skill.dir(...)] })` throws a construction-time `TypeError` with a clear message.
- `fsm.state({ skills: [fsm.skill.dir(...)] })` is rejected by TypeScript if the state skill type stays narrow, and is also rejected at runtime if a caller circumvents the type system.
- Static verification reports a blocking issue if a dir ref reaches state-level `meta.aharness.skills` through an untyped or synthetic config.
- Duplicate validation still catches duplicate name/path entries on a state.

**Implementation notes:**
- Prefer a specific verify check id for invalid skill placement rather than overloading name-shape. Update `VerifyIssueCheck` and check ordering comments when adding it.
- Keep existing `skills-only-on-stateful-states` semantics unchanged.

**Verification:**
- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts`
- Expected: dir-in-state cases fail at construction/static verify; existing state skill cases continue to pass.

### Task 4: Validate `availableSkills` in Static Verify

**Purpose:** Make top-level availability declarations fail before runtime when their shape or filesystem target is invalid.

**Depends on:** Tasks 1 and 2

**Files:**
- Modify: `packages/core/src/verify/verify.ts`
- Modify as needed: `packages/core/src/state/skillResolver.ts`
- Test: `packages/core/test/verify.test.ts`
- Test: `packages/core/test/state.skills.test.ts`

**Acceptance criteria:**
- Verify rejects name-form refs in `availableSkills`.
- Verify resolves path-form `availableSkills` refs against `skillEnv.fsmFileDir` and requires an existing file named `SKILL.md`; misses are errors even if the reused path ref carries `optional: true`.
- Verify resolves dir-form `availableSkills` refs against `skillEnv.fsmFileDir` and requires an existing directory.
- Verify rejects duplicate `availableSkills` entries by resolved kind/path.
- When `skillEnv` is omitted, non-filesystem structural checks still run and filesystem checks are skipped, matching existing verifier behavior.
- Existing state path refs are also updated to require `SKILL.md` at static verify time only.
- `resolveAndReadSkills(...)` keeps its current Slice 0 runtime/manual injection behavior: an existing non-`SKILL.md` path-form ref can still be resolved and read at runtime until the later native-runtime slice intentionally replaces manual body injection.

**Implementation notes:**
- Prefer a verifier-specific helper or an explicit resolver option used only by `verify(...)` for the `SKILL.md` filename rule. Do not globally tighten `resolveSkill(...)` in a way that changes `packages/core/src/runtime/skillInjection.ts` behavior in Slice 0.
- The verifier should read root-level `availableSkills` from the raw machine snapshot (`machine.__aharnessRawConfig`) because XState does not expose arbitrary top-level authoring metadata through state-node metadata. Update verifier comments/invariants that currently say the verifier never reads raw config.
- Extend the resolver or add a focused helper so path refs can distinguish "exists but not named `SKILL.md`" from missing paths in diagnostics.
- Add a test seam for directory existence; do not rely on real home/Codex roots.
- Do not remove the old name-form filesystem resolution in this slice because runtime injection still depends on it until later slices.
- Add a regression test in `packages/core/test/state.skills.test.ts` proving runtime/manual injection still reads an existing non-`SKILL.md` path-form skill in Slice 0.

**Verification:**
- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts`
- Expected: all new `availableSkills` and `SKILL.md` static validation cases pass with clear error/warning severity.

### Task 5: Align Focused Fixtures and Internal Documentation

**Purpose:** Keep the repository’s current tests and internal comments consistent with the new static authoring contract without publishing the full user-facing docs early.

**Depends on:** Tasks 1-4

**Files:**
- Modify as needed: `packages/core/test/fixtures/create-fsm/input-skills-passive.fsm.ts`
- Modify as needed: `packages/core/test/fixtures/skills.fsm.ts`
- Modify as needed: `packages/core/test/cli.verifyCli.test.ts`
- Modify as needed: `examples/pirate-roast.fsm.ts`
- Move/rename as needed: `examples/skills/pirate-mode.md` to a Codex skill path such as `examples/skills/pirate-mode/SKILL.md`
- Modify as needed: `examples/DEMOS.md`
- Modify narrowly if wording would otherwise become false: `docs/authoring.md`
- Modify narrowly if wording would otherwise become false: `docs/reference.md`
- Modify as needed: `packages/core/src/state/skills.ts`
- Modify as needed: `packages/core/src/state/skillResolver.ts`
- Modify as needed: `packages/core/src/runtime/skillInjection.ts`
- Do not broadly update: `docs/architecture.md`, `README.md`

**Acceptance criteria:**
- Any fixture path-form skill used under static verification points to a real or intentionally optional `SKILL.md` path according to the test intent.
- The known stale refs are migrated or intentionally rewritten in tests: `input-skills-passive.fsm.ts`, `skills.fsm.ts`, the inline `cli.verifyCli.test.ts` fixture and assertions, and `pirate-roast.fsm.ts`/its example skill asset.
- Internal comments no longer claim path refs can be arbitrary markdown when Slice 0 verification says they must be Codex `SKILL.md` files.
- Public docs remain deferred to Slice 4 unless a doc line would become actively false for a user running the code after Slice 0. If docs are touched now, limit them to the `SKILL.md` path-form rule and do not document `availableSkills` as runtime-usable.
- Runtime manual `<skill>` injection comments may continue to describe current runtime behavior; do not rewrite them to native structured skill semantics.

**Implementation notes:**
- Keep fixture changes minimal and avoid adding new FSM behavior tests.
- Convert example paths to real Codex skill files, for example `./skills/local/SKILL.md` and `./skills/pirate-mode/SKILL.md`, and update assertions or prose that still expects `local.md` or `pirate-mode.md`.
- If public docs must be touched to avoid false instructions, limit the change to the path-form `SKILL.md` rule and do not document `availableSkills` as fully usable at runtime yet.

**Verification:**
- `pnpm exec vitest run packages/core/test/loader.inputSchema.test.ts packages/core/test/cli.verifyCli.test.ts packages/core/test/example.publicLoadVerify.test.ts`
- Expected: existing fixture-driven tests still pass and no docs imply later-slice runtime behavior is already available.

### Task 6: Final Targeted Verification and Boundary Review

**Purpose:** Prove Slice 0 is complete and has not leaked into runtime or loader behavior.

**Depends on:** Tasks 1-5

**Files:**
- Inspect only: `packages/core/src/runtime/skillInjection.ts`
- Inspect only: `packages/core/src/runtime/nudge.ts`
- Inspect only: `packages/core/src/loader/sidecar.ts`
- Inspect only: `packages/core/src/protocol/types.ts`
- Inspect only: `packages/core/src/protocol/methods.ts`

**Acceptance criteria:**
- No Codex `skills/extraRoots/set`, `skills/list`, or structured `UserInputSkill` protocol changes are present.
- No sidecar/cache origin manifest fields are introduced.
- `resolveAndReadSkills(...)` still returns manual `<skill>` text blocks and existing runtime tests remain unaffected.
- Targeted tests and typecheck pass.

**Implementation notes:**
- If implementation work discovers a real need to touch loader/runtime/protocol files, stop and ask for guidance because that crosses the Slice 0 boundary.
- Record any follow-up observation in the recipe only if it affects the next slice’s durable handoff.

**Verification:**
- `pnpm exec vitest run packages/core/test/state.skills.test.ts packages/core/test/verify.test.ts packages/core/test/state.machine.snapshot.test.ts`
- `pnpm run typecheck`
- Expected: all pass.

## Self-review

- Boundary check: The plan covers only authoring types, construction-time validation, static verification, focused tests, and directly stale internal comments/fixtures.
- Upstream alignment: Tasks map to the roadmap Slice 0 include/exclude list and the spec’s authoring/static-validation requirements.
- Current reality check: All cited existing files and commands were inspected before writing this plan.
- Contract check: The plan explicitly preserves state-level injection semantics and defers loader/runtime/protocol behavior to later slices.
- Verification check: Each task has acceptance criteria and concrete targeted commands.
- Placeholder check: No `TBD` or future implementation placeholders remain.
