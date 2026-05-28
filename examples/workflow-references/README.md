# Workflow references

Long-form workflow content. **Not framework concerns.** These documents describe processes a user might encode into an `<file>.fsm.ts` against `@aharness/core` — they are reading material for FSM authors, not specifications the framework enforces.

| File | What it describes |
|---|---|
| `REQUIREMENTS_GATHERING.md` | Volere fit criteria, Kano classification, Cynefin rigor scaling, banned-word gating, review gate, exit criteria. |
| `DESIGN_AND_PLANNING.md` | Architecture + project-policy phase. Walking-skeleton, FMEA risk register, fitness-function invariants, MoSCoW drop policy, skill/MCP vetting. |
| `EXECUTION_PLANNING.md` | Task DAG, per-task acceptance criteria, fresh-context-per-task executors, monitor agents, replan cascade. |

No example FSM ships for any of these. If you encode one, it lives at `examples/<name>.fsm.ts` and earns an entry in `examples/DEMOS.md`.

These docs were previously in `docs/` as if they were framework specs. They are not. The framework ships mechanisms (`harness_submit` dynamic-tool dispatch, built-in `request_user_input` owner yield, per-run inspection snapshots, final artifacts, hooks, verifier) and is unopinionated about which workflow you build on top.
