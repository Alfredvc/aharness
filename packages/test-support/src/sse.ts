/**
 * OpenAI Responses-API SSE encoders.
 *
 * Codex consumes the SSE stream emitted by the Responses API. To run end-to-end
 * tests without OpenAI we override codex's model base URL and replay canned SSE
 * turns from a local HTTP server (see `mockModel.ts`).
 *
 * Event-name verification (against pinned codex commit
 * `127434cd8b968ca3d830ea78106dcb1506bcd843`):
 *
 *   - `codex-rs/codex-api/src/sse/responses.rs` is the SSE parser. It dispatches
 *     on `event.kind` (deserialized from each data payload's `type` field) and
 *     understands at minimum:
 *       - `response.created`                          (line 341)
 *       - `response.output_item.added`                (line 410)
 *       - `response.output_item.done`                 (line 301)
 *       - `response.output_text.delta`                (line 309)
 *       - `response.function_call_arguments.delta`    (consumed by tests, line 806)
 *       - `response.completed`                        (line 392)
 *       - `response.failed` / `response.incomplete`   (lines 346, 381)
 *
 *   - The `data` JSON's `type` field MUST equal the SSE `event:` line —
 *     `ResponsesStreamEvent` deserializes `kind` from `type` (line 181-182),
 *     and the dispatcher matches on that, not on the SSE event header.
 *
 *   - `response.completed` requires `response.id: string` (parsed by
 *     `ResponseCompleted` at line 134-140; `id` has no `default`, so omitting
 *     it returns `Err` and the run is treated as a stream failure).
 *
 *   - Function-call dispatch happens in
 *     `codex-rs/core/src/stream_events_utils.rs::handle_output_item_done`
 *     (line 220), which is called from `core/src/session/turn.rs` line 1965 on
 *     `ResponseEvent::OutputItemDone`. `OutputItemAdded` (turn.rs line 1987)
 *     only seeds streaming state — it does NOT execute function calls or
 *     finalize assistant messages. Therefore the `done` variant is the
 *     authoritative carrier for the helpers below.
 *
 *   - The canonical fixture `codex-rs/core/tests/cli_responses_fixture.sse`
 *     also uses `response.output_item.done` for assistant messages — so the
 *     task-plan draft of these helpers using `response.output_item.added` was
 *     verified against the source and corrected to `.done`.
 */

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

export function sseAssistantText(text: string): SseEvent {
  return {
    event: 'response.output_item.done',
    data: {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    },
  };
}

/**
 * Build an SSE `response.output_item.done` event whose item is a
 * function_call. For MCP-namespaced tools, pass the optional `namespace`
 * parameter so codex's wire-side `ToolName::new(namespace, name)`
 * (`core/src/tools/router.rs:188`) constructs the canonical form
 * `ToolName{name=<bare>, namespace=Some(<prefix>)}` and the
 * `connection_manager.resolve_tool_info()` strict-equality lookup
 * matches the registered MCP tool.
 *
 * Without a namespace, codex deserializes the call as a flat-name tool
 * (built-ins) — pass `name` only.
 *
 * Example for `mcp__aharness_fsm__submit`:
 *
 *   sseFunctionCall('submit', {state, exit, data}, undefined,
 *                   'mcp__aharness_fsm__')
 *
 * Wire shape verified at `protocol/src/models.rs:2090-2110`
 * (`function_call_deserializes_optional_namespace` test).
 */
export function sseFunctionCall(
  name: string,
  args: unknown,
  callId?: string,
  namespace?: string,
): SseEvent {
  const id = callId ?? `call_${Math.random().toString(36).slice(2, 10)}`;
  const baseItem = {
    type: 'function_call',
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  };
  const item = namespace !== undefined ? { ...baseItem, namespace } : baseItem;
  return {
    event: 'response.output_item.done',
    data: {
      type: 'response.output_item.done',
      item,
    },
  };
}

export function sseTurnComplete(responseId?: string): SseEvent {
  const id = responseId ?? `resp_${Math.random().toString(36).slice(2, 10)}`;
  return {
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: { id, output: [] },
    },
  };
}

/**
 * SSE `response.created` event. Codex's parser
 * (`codex-rs/codex-api/src/sse/responses.rs` line 341-345) requires
 * `event.response.is_some()` for this event variant to deserialize; a
 * minimal `{id}` body satisfies that check.
 */
export function sseResponseCreated(responseId?: string): SseEvent {
  const id = responseId ?? `resp_${Math.random().toString(36).slice(2, 10)}`;
  return {
    event: 'response.created',
    data: {
      type: 'response.created',
      response: { id },
    },
  };
}

export function encodeTurn(events: ReadonlyArray<SseEvent>): Buffer {
  const chunks = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  return Buffer.from(chunks.join(''), 'utf8');
}

/**
 * Encodes a single-function-call turn (`response.created` → `function_call`
 * `response.output_item.done` → `response.completed`) to wire SSE bytes.
 *
 * The `arguments` field is the already-JSON-stringified tool-arguments
 * payload as the model would emit it on the wire (e.g.
 * `JSON.stringify({state, exit, data})`). It is parsed once and re-stringified
 * canonically by `sseFunctionCall` so the SSE payload matches codex's wire
 * expectations exactly.
 *
 * Consumed by phase-1b headless tests (see plan
 * `docs/plans/2026-05-12-headless-phase-1b-cli-wiring-and-cleanup.md`,
 * Tasks 17 and 18) — those tasks adapt the mock-model wiring to accept raw
 * SSE bytes alongside the existing `SseEvent[]` queue.
 */
export function encodeFunctionCallTurn(args: {
  name: string;
  arguments: string;
  callId?: string;
}): Buffer {
  const callId = args.callId ?? `call_${Math.random().toString(36).slice(2, 10)}`;
  const parsedArguments: unknown = JSON.parse(args.arguments);
  return encodeTurn([
    sseResponseCreated(),
    sseFunctionCall(args.name, parsedArguments, callId),
    sseTurnComplete(),
  ]);
}
