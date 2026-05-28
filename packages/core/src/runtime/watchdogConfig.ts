/**
 * Code-level watchdog budgets.
 *
 * Deliberately NOT runtime-tunable via env vars: a `HARNESS_*_BUDGET_MS`
 * surface would be a workflow opinion (see CLAUDE.md hard rule 1) and is
 * out of scope for the MVP. Tune by editing this file and shipping a new
 * release.
 *
 * Defaults (design §16 q6):
 *   - SUBMIT_BUDGET_MS = 500   — `tool/dynamicCall` (`submit`) handler.
 *   - RUI_RACE_BUDGET_MS = 100 — `tool/requestUserInput` multicast race.
 */

export const SUBMIT_BUDGET_MS = 500;
export const RUI_RACE_BUDGET_MS = 100;
