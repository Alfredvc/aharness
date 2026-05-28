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
   hook dispatch, snapshots, and event logging in the same CLI process.
5. It opens a loopback browser UI protected by a per-run token.

For read-only FSM inspection, `aharness visualize <file.fsm.ts>` verifies and
opens the same graph/details UI without starting Codex, hooks, a thread, or the
FSM actor.

Codex writes code, runs tools, and produces natural-language reasoning. aharness
does not ask Codex to remember the workflow. Instead, aharness exposes only the
active state's allowed exits and moves the machine when a typed event satisfies
the state's rules.

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

This is the core boundary: Codex performs the work; aharness constrains the
process around that work.

## Artifacts And Runs

Each invocation creates a fresh run directory under `.aharness/runs/<runId>/`.
Run artifacts include snapshots, event logs, terminal reports, and any final
artifacts declared by the FSM. These files are inspection evidence for the run;
the current public CLI starts a new run and Codex thread for each invocation.

## Package Boundaries

`@aharness/core` provides the authoring SDK and the `aharness` CLI binary.
`@aharness/test-support` provides integration-test fixtures and app-server test
utilities. It has a regular dependency on `@aharness/core`; it is not a peer
dependency.

Reusable FSM packages can be built with `aharness package`. Package authors own
their `fsms/` and bundled `skills/`; aharness owns the generated executable and
delegates package commands back through the same verifier and runtime used for
direct `.fsm.ts` files.
