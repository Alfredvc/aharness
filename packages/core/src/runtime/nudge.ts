/**
 * Per-state orientation message composer used at every state entry. The
 * dispatcher (and the await-side resolver, transitively) feeds the
 * resulting string into `thread/inject_items` so the model's next turn
 * starts with a deterministic, schema-rich description of the active
 * leaf — see design doc §5.5 step 5 and §5.7 for the two injection
 * sites.
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

const OWNER_TEXT_OPTION = {
  label: 'Custom answer (Recommended)',
  description: 'Type the requested owner reply.',
} as const;

/** A single exit declared on the active leaf. */
export type ExitSpec =
  | { kind: 'submit'; name: string; schema: JSONSchema7 }
  | { kind: 'await'; name: string; ask?: string };

export interface NudgeInput {
  readonly stateId: string;
  readonly exits: ReadonlyArray<ExitSpec>;
  /**
   * Fully-resolved text from the state's `entryPrompt`. Empty
   * string means "no prompt section"; the composer emits exits only.
   */
  readonly entryPromptText: string;
  /**
   * Free-text owner-yield declaration (resolved messageToUser). When
   * present, the composer prepends a "call `request_user_input` first"
   * preamble so the model knows to yield to the user before submitting.
   *
   * Implementation note: `awaitsOwnerText` is implemented on top of
   * codex's built-in `request_user_input` tool, NOT an aharness MCP tool.
   * The earlier MCP-based `request_owner_text` design deadlocked: the
   * daemon needed to observe the user's reply mid-tool-call, but codex
   * only emits the `userMessage` thread item after the turn loop iterates
   * past the in-flight tool call. Built-in `request_user_input` returns
   * the user's text directly as the tool result, bypassing the
   * userMessage path entirely.
   */
  readonly awaitsOwnerText?: { readonly messageToUser: string };
  /**
   * Pre-resolved skill blocks (each already wrapped in `<skill …>…</skill>`)
   * to append after `entryPromptText`. Empty array = no skill section.
   * The composer is pure; resolution + file reads happen in the caller
   * (`daemon/skillInjection.ts`) so the composer stays deterministic.
   */
  readonly skillBlocks?: ReadonlyArray<string>;
}

/**
 * Compose the orientation string for a state entry. The format is:
 *
 *   [aharness] Now in state "<id>".
 *   Valid exits:
 *     - "<exit>" → call aharness_submit({state: "<id>", exit: "<exit>", data: <compact-schema>})
 *     - "<exit>" → call request_user_input (await exit, no submit data)
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
  if (i.awaitsOwnerText) {
    // Preamble for free-text owner-yield: model must call codex's
    // built-in `request_user_input` BEFORE emitting any submit, with a
    // single owner-answer question whose `question` field is the
    // verbatim owner prompt. Codex requires non-empty options and
    // normalizes this to accept a free-form "other" answer before
    // emitting the server request. Codex returns the user's reply as the
    // tool result; use it to populate the submit data for the chosen
    // exit.
    lines.push(
      `Before submitting, call request_user_input(${requestUserInputArgsText(i.awaitsOwnerText.messageToUser)}) and use the user's reply when constructing the submit data.`,
    );
  }
  lines.push('Valid exits:');
  for (const e of i.exits) {
    if (e.kind === 'submit') {
      lines.push(
        `  - "${e.name}" → call ${SUBMIT_TOOL_NAME}({state: "${i.stateId}", exit: "${e.name}", data: ${compactSchemaForOrientation(e.schema)}})`,
      );
    } else {
      if (e.ask !== undefined) {
        lines.push(
          `  - "${e.name}" → call request_user_input(${requestUserInputArgsText(e.ask)}) (await exit, no submit data)`,
        );
      } else {
        lines.push(`  - "${e.name}" → call request_user_input (await exit, no submit data)`);
      }
    }
  }
  if (i.entryPromptText.trim().length > 0) {
    lines.push('');
    lines.push(i.entryPromptText);
  }
  if (i.skillBlocks && i.skillBlocks.length > 0) {
    for (const block of i.skillBlocks) {
      lines.push('');
      lines.push(block);
    }
  }
  return lines.join('\n');
}

function requestUserInputArgsText(question: string): string {
  return JSON.stringify({
    questions: [
      {
        id: 'owner',
        header: '',
        question,
        options: [OWNER_TEXT_OPTION],
      },
    ],
  });
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
