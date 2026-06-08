# Run Event Visibility

This document is the browser transcript event visibility policy reference for
run-scoped events. Keep it in sync with the implementation whenever
event-to-transcript projection or default transcript filtering changes.

The run event envelope accepts an open string `type`, but the browser client has
a fixed allowlist of event types that it subscribes to from the run-scoped SSE
stream. Transcript rendering is then decided mostly by `data.row.kind`, not by
the event type alone.

Visibility columns:

- **Normal** means the default live `aharness run` transcript with dev mode off.
- **Dev** means the same UI with the `Dev` toggle on. The toggle is available in
  both run and view sessions.
- **View** means the default recorded `aharness view` transcript with dev mode
  off. It uses the same transcript filtering as normal mode, but hides
  live-only interaction surfaces.

Legend:

- **Shown** means a transcript row is visible.
- **Filtered** means a transcript row exists but is hidden by the default
  transcript filter.
- **No row** means the event normally updates state, stats, or diagnostics
  without creating a transcript item unless it carries a valid `data.row`.
- **Control** means the message controls streaming/resync behavior rather than
  representing a canonical run event.

## Event Type Visibility

| Event type | Normal | Dev | View | Notes |
| --- | --- | --- | --- | --- |
| `run.started` | Shown | Shown | Shown | Usually projects `data.row.kind: "run_lifecycle"`. |
| `run.completed` | Shown | Shown | Shown | Usually projects `data.row.kind: "run_lifecycle"` and opens the terminal overview. |
| `run.failed` | Shown | Shown | Shown | Usually projects `data.row.kind: "run_lifecycle"` and opens the terminal overview. |
| `run.cancelled` | Shown | Shown | Shown | Usually projects `data.row.kind: "run_lifecycle"` and records cancellation as terminal lifecycle evidence. |
| `state.changed` | Shown | Shown | Shown | Projects `data.row.kind: "state_change"` and updates graph/history/current state. |
| `context.initialized` | No row | No row | No row | Updates context for the dev inspector when present. |
| `context.changed` | No row | No row | No row | Updates context for the dev inspector when present. |
| `posture.changed` | No row | No row | No row | Updates terminal/awaiting/submitted/open posture; row visibility depends on optional `data.row`. |
| `turn.started` | No row | No row | No row | Tracks active turn/count; row visibility depends on optional `data.row`. |
| `turn.completed` | No row | No row | No row | Finishes active streaming rows and records the turn; row visibility depends on optional `data.row`. |
| `model.delta` | Shown | Shown | Shown | Streams assistant text or reasoning text directly. Empty reasoning is always filtered. |
| `item.started` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Usually tool/message/file rows; see row-kind table. |
| `item.completed` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Usually tool/message/file rows; see row-kind table. |
| `raw_response_item.completed` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Usually message/reasoning/tool rows derived from raw response items. |
| `request.created` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Creates pending cards for owner input/choice/approval/elicitation when `pendingCard` is present. Workflow-visible request summaries are shown in normal/view; reserved/internal protocol plumbing is filtered outside dev. |
| `request.updated` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Updates pending cards. Workflow-visible request summaries are shown in normal/view; reserved/internal protocol plumbing is filtered outside dev. |
| `request.resolved` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Resolves pending cards. Workflow-visible request summaries are shown in normal/view; reserved/internal protocol plumbing is filtered outside dev. |
| `reply.submitted` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Workflow-visible reply summaries are shown in normal/view; reserved/internal protocol plumbing is filtered outside dev. |
| `reply.resolved` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Workflow-visible reply summaries are shown in normal/view; reserved/internal protocol plumbing is filtered outside dev. |
| `framework.note` | Usually filtered | Shown | Usually filtered | `warn` notes are shown; `info` and `orientation` notes are filtered by default. |
| `fresh_clear.boundary` | Shown | Shown | Shown | Projects `fresh_clear_boundary`; also clears active live transcript surfaces during a live run. |
| `diagnostic.abandoned_thread` | Shown | Shown | Shown | Usually projects a diagnostic row and also records a dev diagnostic entry. |
| `token.updated` | No row | No row | No row | Updates aggregate token stats. |
| `git.snapshot.recorded` | No row | No row | No row | Used for completion stats and run evidence; not a transcript row. |
| `git.diff.recorded` | No row | No row | No row | Used for committed-work stats; not a transcript row. |
| `subthread.turn.started` | No row | No row | No row | Used for completion stats; row visibility depends on optional `data.row`. |
| `subthread.turn.completed` | No row | No row | No row | Used for completion stats; row visibility depends on optional `data.row`. |
| `subthread.item.started` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Usually tool rows when a row is present. |
| `subthread.item.completed` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Usually tool rows when a row is present. |
| `subthread.token.updated` | No row | No row | No row | Updates subthread token stats. |
| `sidecar.thread.started` | Shown | Shown | Shown | Projects compact `sidecar` lifecycle evidence for an author-created sidecar thread. |
| `sidecar.thread.closed` | Shown | Shown | Shown | Projects compact `sidecar` lifecycle evidence for sidecar shutdown. |
| `sidecar.turn.started` | Shown | Shown | Shown | Projects compact `sidecar` turn status without making the sidecar a parent transcript turn. |
| `sidecar.turn.completed` | Shown | Shown | Shown | Projects compact `sidecar` turn completion evidence. |
| `sidecar.turn.timeout` | Shown | Shown | Shown | Projects compact `sidecar` timeout evidence. |
| `sidecar.item.started` | Shown | Shown | Shown | Projects compact `sidecar` tool/item activity; raw item payloads stay in canonical JSONL raw evidence. |
| `sidecar.item.completed` | Shown | Shown | Shown | Projects compact `sidecar` tool/item completion; raw item payloads stay in canonical JSONL raw evidence. |
| `sidecar.item.fileChange.patchUpdated` | Shown | Shown | Shown | Projects compact sidecar file-change progress; raw patch payloads stay in canonical JSONL raw evidence. |
| `sidecar.agentMessage.delta` | No row | No row | No row | Records raw sidecar model delta evidence without projecting it as parent-thread transcript text. |
| `sidecar.rawResponseItem.completed` | No row | No row | No row | Records raw sidecar response-item evidence without creating a transcript row. |
| `sidecar.input_request.created` | Shown | Shown | Shown | Sidecar `request_user_input` evidence only; does not create owner-reply controls or pending-card routing. |
| `sidecar.input_request.resolved` | Shown | Shown | Shown | Sidecar `request_user_input` answer evidence only; does not use the browser owner-reply route. |
| `sidecar.token.updated` | Shown | Shown | Shown | Projects compact `sidecar` token evidence and updates sidecar token stats separately from parent/subthread totals. |
| `sidecar.notification.ignored` | Shown | Shown | Shown | Diagnostic evidence for late sidecar notifications that no longer affect an operation. |
| `sidecar.thread.close.warning` | Shown | Shown | Shown | Diagnostic evidence for best-effort sidecar close failures. |
| `sidecar.turn.interrupt.warning` | Shown | Shown | Shown | Diagnostic evidence for best-effort sidecar interrupt failures. |
| `artifact.written` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Visibility depends on optional `data.row`. |
| `submit.recorded` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Visibility depends on optional `data.row`; submit-tool rows are always hidden. |
| `transition.recorded` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Visibility depends on optional `data.row`; transition failure rows are shown. |
| `hook.observed` | Row-kind dependent | Row-kind dependent | Row-kind dependent | Visibility depends on optional `data.row`. |
| `runEvent` | Control | Control | Control | SSE wrapper event name used to deliver canonical run events. |
| `runEvent.resyncRequired` | Control | Control | Control | SSE control message that tells the browser to refetch bootstrap. |
| Unknown future event type | Row-kind dependent | Row-kind dependent | Row-kind dependent | The JSONL envelope type is open; current UI can only render it if it carries a known `data.row.kind`. |

## Row Kind Visibility

Rows are compact transcript projections stored under `event.data.row`. If an
event has no valid row, it can still update run state, graph state, stats, or
pending cards, but it does not create a transcript item.

| `data.row.kind` | Transcript item | Normal | Dev | View | Notes |
| --- | --- | --- | --- | --- | --- |
| `message` with assistant/agent label | `agent_message` | Shown | Shown | Shown | Also used for non-streamed message rows during replay/bootstrap. |
| `message` with user label | `user_message` | Shown unless synthetic | Shown unless always hidden | Shown unless synthetic | Synthetic framework orientation user messages are always hidden. |
| `reasoning` | `reasoning` | Shown unless empty | Shown unless empty | Shown unless empty | Empty reasoning rows are always hidden. |
| `tool` | `tool_call` | Shown unless reserved/internal | Shown unless always hidden | Shown unless reserved/internal | Successful output is removed in normal/view display; dev keeps full output. |
| `tool` for reserved tools | `tool_call` | Filtered | Shown | Filtered | Reserved/internal tools are visible in dev unless they are submit-tool rows. |
| `tool` for `aharness_submit` | `tool_call` | Filtered | Filtered | Filtered | Submit-tool calls/results are always hidden. |
| `request`, workflow-visible and not reserved/internal | `compact_status` / `request` | Shown | Shown | Shown | Includes owner input/choice, approval, permission, and elicitation request summaries when the row carries a user-facing label or summary. Pending cards may also render as live interaction surfaces in normal run mode, but not in view. |
| `request`, reserved/internal | `compact_status` / `request` | Filtered | Shown | Filtered | Covers request protocol plumbing marked with `reserved: true` or compact row data such as `internal: true`. |
| `reply`, workflow-visible and not reserved/internal | `compact_status` / `reply` | Shown | Shown | Shown | Includes owner-choice, owner-input, approval, permission, and elicitation reply summaries. Secret answers must remain redacted by the row summary or pending-card rendering that produced the event. |
| `reply`, reserved/internal | `compact_status` / `reply` | Filtered | Shown | Filtered | Covers reply protocol plumbing marked with `reserved: true` or compact row data such as `internal: true`. |
| `framework_note` with `status: "warn"` | `framework_note` | Shown | Shown | Shown | Warning notes are user-visible. |
| `framework_note` with `status: "info"` | `framework_note` | Filtered | Shown | Filtered | Informational framework notes are dev-only. |
| `framework_note` with `status: "orientation"` | `framework_note` | Filtered | Shown | Filtered | Orientation notes are dev-only. |
| `diagnostic` | `compact_status` / `diagnostic` | Shown | Shown | Shown | Diagnostics are visible by default. |
| `run_lifecycle` | `compact_status` / `lifecycle` | Shown | Shown | Shown | Covers run started/completed/failed/cancelled lifecycle rows. |
| `sidecar` | `compact_status` / `sidecar` | Shown | Shown | Shown | Covers compact sidecar lifecycle, turn, tool/request-user-input, and token evidence. It is evidence only; pending cards still come only from `request.*` events with `pendingCard`. |
| `state_change` | `state_change` | Shown | Shown | Shown | Covers boot and transition markers in the chronological run transcript. Scoped state views may still suppress duplicate transition rows inside visit groups. |
| `transition_failure` | `transition_failure` | Shown | Shown | Shown | Failed submit/transition rows are visible. |
| `fileChange` | `file_change` | Shown | Shown | Shown | Compact file-change summaries only; diff bodies are not exposed as transcript rows. |
| `fresh_clear` | `fresh_clear_boundary` | Shown | Shown | Shown | Marks replacement-thread boundaries. |
| `dynamicToolCall` | none | No row | No row | No row | Known row kind that is intentionally ignored. |
| Unknown row kind | none | No row | No row | No row | The UI records a bounded diagnostic for unsupported row kinds. |

## Live-Only Surfaces

Normal live sessions can show surfaces that are not transcript rows:

- owner-choice cards
- owner-input prompts
- file, command, permission, and MCP elicitation approval cards
- sidecar file, command, permission, and MCP elicitation approval cards when
  recorded through `request.*` events with sidecar metadata
- open-state composer
- pending/thinking/submitted activity indicators

Recorded `view` sessions hide or disable those surfaces because the reply route
always rejects writes. View mode hides live interaction controls, not historical
evidence: lifecycle rows, state changes, and workflow-visible request/reply
summaries can still appear as transcript rows when the recorded log contains
those rows.

Sidecar `request_user_input` is deliberately different from browser owner input.
It is recorded and projected only through `sidecar.input_request.*` evidence.
Those events must not create owner-input controls, owner replies, or pending
cards in live or recorded views.
