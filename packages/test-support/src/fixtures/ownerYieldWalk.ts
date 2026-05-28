/**
 * Owner-yield walk fixture for the Phase 2b end-to-end integration test.
 *
 * Topology:
 *
 *   a (stateful) ──next→ b (stateful, awaitsOwnerText) ──done→ c (terminal:'success')
 *
 * Exercises cross-state-into-`awaitsOwnerText`: state `a` submits to
 * state `b`; `b` declares `awaitsOwnerText` (lowered to codex's built-in
 * `request_user_input` tool) AND a SUBMIT exit `done`. Distinct from
 * `awaitExitWalk` (which uses an `await`-kind exit) — here state `b`'s
 * orientation nudge instructs the model to call `request_user_input`
 * BEFORE emitting its `harness_submit({state:'b', exit:'done', ...})`.
 *
 * Companion integration test
 * `packages/core/test/integration.ownerYieldWalk.test.ts` queues
 * three mock-model turns:
 *
 *   1. `harness_submit({state: "a", exit: "next", data: {note: "go"}})`
 *      — cross-state dance fires; codex re-POSTs after the dance's
 *      `turn/start({input: <state b nudge>})` lands.
 *   2. `request_user_input({questions: [{id:"owner", header:"",
 *      question:"what is your name?", options:[...]}]})`
 *      — CLI parks the ServerRequest; `MockOwnerInputProvider` resolves
 *      with `{answers: {owner: {answers: ["alice"]}}}`; codex returns
 *      the answer to the model on its next turn.
 *   3. `harness_submit({state: "b", exit: "done", data: {greeting:
 *      "hello alice"}})` — terminal transition; run exits 0.
 *
 * Per `docs/plans/2026-05-13-headless-phase-2b-owner-yield.md` §Task 7.
 */
import { harness, state, exit, terminal, type HarnessMachine } from '@aharness/core';
import { sseFunctionCall, sseResponseCreated, sseTurnComplete, type SseEvent } from '../sse.js';

interface NextPayload {
  readonly note: string;
}

interface DonePayload {
  readonly greeting: string;
}

/**
 * In-process machine matching `OWNER_YIELD_WALK_FSM_SOURCE` for callers
 * that want to introspect the topology without going through `loadFsm`.
 * The integration test still writes the source string to disk and lets
 * `loadFsm` esbuild + dynamic-import it.
 */
export const ownerYieldWalkMachine: HarnessMachine<
  unknown,
  unknown,
  Record<string, unknown>
> = harness.machine({
  id: 'owner-yield-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'state a active',
      exits: {
        next: exit<NextPayload>({ to: 'b' }),
      },
    }),
    b: state({
      entryPrompt: 'state b active — waiting for name',
      awaitsOwnerText: { messageToUser: 'what is your name?' },
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});

/**
 * FSM source for the owner-yield walk. Two stateful states + one
 * terminal. State `b` declares `awaitsOwnerText: {messageToUser: "what
 * is your name?"}` — the lowercase / no-apostrophe spelling matches
 * every downstream assertion in the integration test verbatim.
 *
 * Written to disk in the integration test's synthetic `repoRoot` so
 * `loadFsm` can esbuild + dynamic-import it (the loader's compile step
 * externalises bare `@aharness/core` / `xstate` imports to absolute
 * install paths — see `packages/core/src/loader/compile.ts`).
 * Kept in sync with `ownerYieldWalkMachine` above.
 */
export const OWNER_YIELD_WALK_FSM_SOURCE = `import { harness, state, exit, terminal } from '@aharness/core';

interface NextPayload {
  note: string;
}

interface DonePayload {
  greeting: string;
}

export default harness.machine({
  id: 'owner-yield-walk',
  initial: 'a',
  states: {
    a: state({
      entryPrompt: 'state a active',
      exits: {
        next: exit<NextPayload>({ to: 'b' }),
      },
    }),
    b: state({
      entryPrompt: 'state b active — waiting for name',
      awaitsOwnerText: { messageToUser: 'what is your name?' },
      exits: {
        done: exit<DonePayload>({ to: 'c' }),
      },
    }),
    c: terminal('success'),
  },
});
`;

/**
 * Build a single-turn SSE stream that emits ONE `request_user_input`
 * `function_call`. `request_user_input` is codex's built-in tool (not
 * MCP-namespaced), so the function-call name is bare. The arguments
 * payload wraps the questions array per
 * `protocol/types.ts:ToolRequestUserInputParams` (`questions: [...]`);
 * codex's built-in handler parses this on the wire side and emits the
 * `item/tool/requestUserInput` ServerRequest the CLI parks.
 *
 * `callId` is the model-assigned tool-call id; the integration test
 * does not need to match against it (the provider observes the
 * ServerRequest itself) but a stable id keeps the SSE wire shape
 * predictable.
 */
export function buildRequestUserInputTurn(
  callId: string,
  questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
  }>,
): SseEvent[] {
  const fullQuestions = questions.map((q) => ({
    id: q.id,
    header: q.header,
    question: q.question,
    options: [
      {
        label: 'Custom answer (Recommended)',
        description: 'Type the requested owner reply.',
      },
    ],
  }));
  return [
    sseResponseCreated(),
    sseFunctionCall('request_user_input', { questions: fullQuestions }, callId),
    sseTurnComplete(),
  ];
}
