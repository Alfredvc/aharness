# Architecture

aharness is a middle layer for coding-agent workflows. Skills and prompts can
describe a process, but aharness makes the process executable: the FSM owns the
states, gates, typed submissions, approval routing, and final artifacts while
Codex performs the language and coding work.

## Runtime Shape

An FSM author writes a `.fsm.ts` file with `createFsm` from `@aharness/core`.
The file declares states, prompts, typed submit exits, owner-input awaits,
built-in hook events, embedded child machines, inputs, skills, and final
artifacts.

At runtime, `aharness <file.fsm.ts>` runs foreground-only:

1. It verifies and loads the FSM.
2. It starts one Codex `app-server` child process.
3. It connects as the sole WebSocket client for that run.
4. It hosts the XState actor, submit handling, owner input, approval dispatch,
   hook dispatch and canonical JSONL event logging in the same CLI process.
5. It opens a loopback browser UI protected by a per-run token.

For read-only FSM inspection, `aharness visualize <file.fsm.ts>` verifies and
opens the same graph/details UI without starting Codex, hooks, a thread, or the
FSM actor.

Codex writes code, runs tools, and produces natural-language reasoning. aharness
does not ask Codex to remember the workflow. Instead, aharness exposes only the
active state's allowed exits and moves the machine when a typed event satisfies
the state's rules.

The browser run UI defaults to a chronological compact transcript for the whole
run. Selecting a graph state switches the right panel to that state's historical
visits, grouped chronologically by visit id. Pending approvals, owner input, and
open-state prompts remain live-run interaction surfaces rather than raw JSONL
payload views. Owner input is independent of Codex approval review mode:
`fsm.await(...)` prompts still surface through the browser, while pending
browser approval cards appear only when Codex routes a permission prompt to the
user, such as under `--ask`. Default live runs use Codex auto-review, which can
resolve eligible sandbox-boundary prompts without browser interaction.

## Visualization Topology

The topology events sent to the browser stay semantic. Nodes describe FSM states,
embedded child ownership, terminal outcomes, prompt/detail metadata, and the
optional visualization-only `main` marker declared by the FSM author; edges
describe authored transitions and exits. They do not carry renderer-only ranks,
ports, feedback classes, or expansion state.

The browser graph derives visualization details locally from that semantic
topology. It projects collapsed or expanded embedded FSM hierarchy, ranks each
visible scope from its entry state, keeps local sink terminals at the bottom of
their own scope, classifies renderer-local edge roles, and then asks ELK for
concrete coordinates and structural edge routes. aharness supplies semantic model
order, cycle and feedback metadata, fixed center ports for marked main-forward
edges, straightness priority, and styling. This keeps runtime and event
contracts independent from the current graph layout strategy while allowing the
author-marked primary path to read as one vertical spine without rewriting ELK's
returned routes.

The renderer separates semantic visibility from layout influence. Every
currently visible semantic transition remains in the render set, while repeated
recovery fan-in, resume fan-out, feedback, and other auxiliary/control edges may
be rank-neutral so they do not determine primary node order. Rank-neutral edges
are still passed to ELK for concrete edge sections and are rendered as normal
graph edges with titles, styling, and fired state.

Graph inspection state is local to the browser renderer. Edge hover and
clicked-state focus are computed from visible routed endpoints, so projected
embed-host edges highlight what the user sees on the canvas. Edge titles or
tooltips may include original semantic endpoints when they differ from those
visible endpoints. Node clicks still invoke the ActivePanel scope callback; the
graph-local selected state is cleared only by a true blank-canvas click. Edge
click or tap pinning is intentionally outside the current interaction contract.

When a visible scope contains any `main: true` nodes, the renderer uses
transitions between those marked nodes as the scope's primary spine. Unmarked
states remain semantic graph nodes and their transitions remain inspectable, but
they are rank-neutral unless they connect two marked nodes. Acyclic
main-to-main transitions define the dominant top-to-bottom path. Main-to-main
backtracking, loop, and self-loop transitions are classified as main feedback
edges; they remain visible and routed even though not every main edge can point
downward in a cyclic workflow.

Collapsed embeds project their internal transitions onto the visible embed host
only when that projection crosses the current visible boundary. Transitions
inside the embedded FSM are hidden while the host is collapsed and become visible
inside the labeled compound region after expansion, with local ranking applied
inside that region.

The contextual legend is also derived locally from current visible graph signals
and graph-local selection. It presents user-facing labels rather than
renderer-local role names.

## Process Control

The model submits structured payloads through aharness-controlled tools. aharness
validates the payload against the active state's generated sidecar schema,
executes the configured reducer or effect, and emits the transition into the
FSM. If the active state does not expose an exit, the model cannot take it.

Owner input has two paths:

- `fsm.await(...)` asks the owner for free text through Codex
  `request_user_input` and advances on the configured await exit.
- Built-in approval and hook events route Codex permission, pre-tool,
  post-tool, and prompt-submission events through the active state's `on` map.

Approval review mode controls where Codex permission prompts go. Default live
runs start Codex with auto-review so eligible sandbox-boundary prompts can be
handled by Codex. Runs started with `--ask` use manual user review and surface
pending approval cards in the browser; `--yolo` bypasses approval prompts.

This is the core boundary: Codex performs the work; aharness constrains the
process around that work.

## Artifacts And Runs

Each invocation creates a fresh run directory under `.aharness/runs/<runId>/`.
Run artifacts include the canonical `events.jsonl` transcript, terminal
reports, and any final artifacts declared by the FSM. These files are
inspection evidence for the run; the current public CLI starts a new run and
Codex thread for each invocation.

For new runs, `events.jsonl` is a canonical `aharness.event.v1` transcript. It
stores compact normalized event data plus full raw runtime payloads inline,
including secret-marked owner input, browser replies, tool arguments/results,
command output, file diffs, approval/permission/elicitation payloads, and token
usage notifications, plus parent-visible sub-thread notifications. Run
directories should therefore be handled as sensitive material.

Run-scoped routes under `/api/runs/:runId/` serve compact JSONL-backed
projections for bootstrap state, visit rows, recent rows, diagnostic event
pages, canonical run-event SSE, and replies. These HTTP/SSE responses omit raw
payloads; raw evidence remains in `events.jsonl`. Compact rows include durable
run lifecycle status and normalized transition-failure summaries for failed
internal submit attempts without exposing submitted payloads. The React browser
uses the run-scoped bootstrap, row, stream, and reply routes after the CLI hands
it `token` and `runId` query params. Its shell defaults to compact JSONL-backed
chronological run rows, supports selected-state visit grouping, and shows
aggregate running-time, token, and context-window stats; the old top turn count
and bottom turn ribbon are no longer user-facing chrome. The old flat
`/api/state`, `/api/stream`, and `/api/reply` browser routes are no longer
served for new runs. Production live runs do not write `snapshot.json`; retained
snapshot helper exports are legacy/internal compatibility only.

## Package Boundaries

`@aharness/core` provides the authoring SDK and the `aharness` CLI binary.
`@aharness/test-support` provides integration-test fixtures and app-server test
utilities. It has a regular dependency on `@aharness/core`; it is not a peer
dependency.

Reusable FSM packages are npm-shaped packages with explicit
`aharness.package.commands.<command>.entry` metadata. Package authors own their
`fsms/`, bundled `skills/`, helper modules, and package-relative assets; the
global `aharness install` / `aharness run` surface indexes and executes verified
commands from the installed package tree.

The installed package tree remains npm-managed. aharness trusts only
`installs.json` and the derived `commands.json` after command verification, and
installed `run` / installed `verify` recompute lock fingerprints before loading
a command. A malformed command index can be regenerated from valid install
records, but malformed install records are not recoverable because they are the
source of truth.
