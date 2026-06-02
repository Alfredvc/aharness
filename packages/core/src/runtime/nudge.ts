/**
 * Per-state orientation message composer used at every state entry. The
 * dispatcher and drive-forward path feed the resulting string into the
 * model's next `turn/start` so the turn begins with a deterministic,
 * schema-rich description of the active leaf.
 *
 * Pure / deterministic: no I/O, no clocks, no randomness. Same input →
 * identical bytes. The dispatcher relies on this for the dry-run /
 * commit / inject sequence to be safely re-runnable on resume.
 *
 * The text format is the framework's contract with the model. Any
 * change here is a behaviour change observable in production runs.
 */
import type { JSONSchema7 } from 'json-schema';

import { SUBMIT_TOOL_NAME } from '../protocol/submitTool.js';

/** A single exit declared on the active leaf. */
export type ExitSpec = { kind: 'submit'; name: string; schema: JSONSchema7 };

export interface NudgeInput {
  readonly stateId: string;
  readonly exits: ReadonlyArray<ExitSpec>;
  /**
   * Fully-resolved text from the state's `entryPrompt`. Empty
   * string means "no prompt section"; the composer emits exits only.
   */
  readonly entryPromptText: string;
}

/**
 * Compose the orientation string for a state entry. The format is:
 *
 *   [aharness] Now in state "<id>".
 *   Valid exits:
 *     - "<exit>" → call aharness_submit({state: "<id>", exit: "<exit>", data: <compact-schema>})
 *
 *   <entryPromptText>     // omitted entirely if empty
 *
 * The submit-form orientation is shown verbatim because it matches the
 * `aharness_submit` tool the CLI registers via codex's `dynamic_tools`
 * channel (per spec §4.3.1) — its parameter shape (state, exit, data) is
 * declared by `SUBMIT_TOOL` (see §10's prompt-cache invariant — the
 * tool itself is frozen; per-state guidance lives here). The tool name
 * is sourced from `SUBMIT_TOOL_NAME` so this file and the registration
 * stay byte-identical.
 *
 * Schema rendering: the per-(state, exit) `data` schema is emitted on a
 * single line via `compactSchemaForOrientation` — `$schema` and empty
 * `definitions` are stripped (they carry no shape information for the
 * model), and the remainder is `JSON.stringify`'d without indent. This
 * is load-bearing context: the static `inputSchema` for `aharness_submit`
 * (`protocol/submitTool.ts`) declares `data` as an open object
 * (`type: object`, `additionalProperties: true`) — enough to keep the
 * model from JSON-stringifying the value, but no per-state shape — so
 * the per-state schema travels here or nowhere.
 */
export function composeStateNudge(i: NudgeInput): string {
  const lines: string[] = [];
  lines.push(`[aharness] Now in state "${i.stateId}".`);
  lines.push('Valid exits:');
  for (const e of i.exits) {
    lines.push(
      `  - "${e.name}" → call ${SUBMIT_TOOL_NAME}({state: "${i.stateId}", exit: "${e.name}", data: ${compactSchemaForOrientation(e.schema)}})`,
    );
  }
  if (i.entryPromptText.trim().length > 0) {
    lines.push('');
    lines.push(i.entryPromptText);
  }
  return lines.join('\n');
}

/**
 * Strip schema metadata that carries no shape information for the model
 * and serialize the result on a single line. Drops:
 *
 *   - `$schema` — version URI, irrelevant to instance shape.
 *   - `definitions` when empty — Ajv emits `{}` even for schemas with no
 *     `$ref` refs; the empty map is noise.
 *
 * Kept as-is when populated (`definitions` with entries IS load-bearing
 * for `$ref` resolution). All other fields pass through unchanged.
 */
function compactSchemaForOrientation(schema: JSONSchema7): string {
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete cloned['$schema'];
  const defs = cloned['definitions'];
  if (defs !== null && typeof defs === 'object' && Object.keys(defs).length === 0) {
    delete cloned['definitions'];
  }
  return JSON.stringify(cloned);
}
