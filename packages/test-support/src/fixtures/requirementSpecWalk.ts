/**
 * SSE-turn fixtures that walk the `requirement-spec-codex` example FSM
 * along its shortest viable success path (`askGoal` → `finalize`).
 *
 * Used by `phase9.realtui.e2e.test.ts` to drive a real `codex --remote`
 * TUI through every authored state via mock-model turns + scripted
 * owner replies. The total fixture set is 7 model turns + 3 owner-typed
 * replies; state 6 (`presentDraft`) is `passive` and auto-transitions
 * with no model turn; state 9 (`finalize`) is terminal.
 *
 * Iterate / revise loops (multiple `done:false` rounds) and the
 * `verdict:'rework'` branch are intentionally out of scope here; this
 * fixture proves the topology terminates cleanly, not exhaustive
 * coverage. See plan `2026-05-04-phase9-realtui-e2e-fix.md`.
 */

import { sseAssistantText, sseFunctionCall, sseTurnComplete, type SseEvent } from '../sse.js';

export type WalkStep =
  | {
      readonly kind: 'submit';
      readonly stateId: string;
      readonly exitName: string;
      readonly data: unknown;
    }
  | {
      readonly kind: 'requestUserInput';
      readonly messageToUser: string;
      readonly ownerReply: string;
    };

export const REQUIREMENT_SPEC_SHORTEST_WALK: ReadonlyArray<WalkStep> = [
  {
    kind: 'requestUserInput',
    messageToUser: 'What is your goal?',
    ownerReply: 'ship the prototype',
  },
  {
    kind: 'submit',
    stateId: 'askGoal',
    exitName: 'submit',
    data: { goal: 'ship the prototype' },
  },
  {
    kind: 'submit',
    stateId: 'iterateRequirements',
    exitName: 'submit',
    data: { next: { done: true } },
  },
  {
    kind: 'submit',
    stateId: 'research',
    exitName: 'submit',
    data: { findings: [] },
  },
  {
    kind: 'submit',
    stateId: 'flagIncompatibilities',
    exitName: 'submit',
    data: { conflicts: [] },
  },
  { kind: 'requestUserInput', messageToUser: 'Any gaps?', ownerReply: 'no' },
  {
    kind: 'submit',
    stateId: 'probeMissingRequirements',
    exitName: 'submit',
    data: { additions: [] },
  },
  { kind: 'requestUserInput', messageToUser: 'Any edits?', ownerReply: 'looks good' },
  {
    kind: 'submit',
    stateId: 'reviseWithOwner',
    exitName: 'submit',
    data: { next: { done: true } },
  },
  {
    kind: 'submit',
    stateId: 'reviewerPass',
    exitName: 'submit',
    data: { verdict: 'pass', notes: 'ok' },
  },
];

/**
 * Build an assistant turn that primes an owner-yield via codex's
 * built-in `request_user_input` tool. The plain assistant text mirrors
 * `messageToUser` so the test's PTY scraper has a stable substring to
 * wait on before typing the owner reply.
 *
 * The function_call carries no namespace because `request_user_input`
 * is a built-in `ToolKind::Function` (see codex-rs
 * `core/src/tools/handlers/request_user_input.rs`), not an MCP-routed
 * tool. The args shape follows `RequestUserInputArgs`
 * (`protocol/src/request_user_input.rs:32-34`) with one owner-answer
 * question whose `question` field is the verbatim owner prompt. Current
 * Codex requires each question to include non-empty options and then
 * marks it as accepting "other" text before emitting the server request.
 *
 * Why built-in instead of an MCP tool: the prior design routed the
 * owner-yield through a harness-owned `request_owner_text` MCP tool, but
 * that deadlocked codex's turn loop — the daemon had to observe the
 * user's reply mid-tool-call, but `userMessage` thread items are only
 * emitted after the turn loop drains pending input, which doesn't
 * happen until the in-flight tool call returns. Built-in
 * `request_user_input` returns the user's text directly as the tool
 * result, bypassing the userMessage path.
 */
export function buildAssistantTurnForOwnerText(messageToUser: string): SseEvent[] {
  return [
    sseAssistantText(messageToUser),
    sseFunctionCall('request_user_input', {
      questions: [
        {
          id: 'owner',
          header: '',
          question: messageToUser,
          options: [
            {
              label: 'Custom answer (Recommended)',
              description: 'Type the requested owner reply.',
            },
          ],
        },
      ],
    }),
    sseTurnComplete(),
  ];
}

/**
 * Build a turn whose sole tool call is the discriminated `submit`
 * dispatch (single dynamic tool; the daemon routes on `state` + `exit`).
 *
 * The function_call output_item is split as
 * `{name: "submit", namespace: "mcp__harness_fsm__"}` per codex's
 * namespace-tool registration shape — the MCP child registers `submit`
 * under server `harness_fsm`, codex namespaces it model-side, and
 * `connection_manager.resolve_tool_info()` does strict equality on
 * `ToolName{name, namespace}` (`codex-mcp/src/connection_manager.rs:616-621`).
 * A flat `name="mcp__harness_fsm__submit"` would silently miss the
 * lookup and route to a non-existent function handler.
 */
export function buildSubmitTurn(stateId: string, exitName: string, data: unknown): SseEvent[] {
  return [
    sseFunctionCall(
      'submit',
      { state: stateId, exit: exitName, data },
      undefined,
      'mcp__harness_fsm__',
    ),
    sseTurnComplete(),
  ];
}
