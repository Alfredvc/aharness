# Reference

This page documents the current public authoring and CLI surface. The canonical
authoring entry point is `createFsm` from `@aharness/core`.

## Prerequisites

- Node.js `>=20`
- Codex CLI `>=0.130.0`

The latest repository validation is `codex-cli 0.133.0` on 2026-05-24. See
[`packages/core/SUPPORTED_CODEX.md`](../packages/core/SUPPORTED_CODEX.md) for
the compatibility gate and drift-check details.

## Authoring Surface

`createFsm<Data>()` returns the current FSM factory:

- `fsm.machine(config)` declares the machine, optional typed `input`, initial
  data, initial state, and states map.
- `fsm.state(options)` declares an active Codex state with `prompt`, optional
  `ask`, `on`, `entry`, `clearOnEntry`, visualization-only `main`, `guidance`,
  `skills`, `mode`, and low-level `xstate` escape hatch.
- `fsm.submit<T>(options)` declares a typed model submission exit.
- `fsm.await(options)` declares an owner-input exit.
- `fsm.final(options)` declares a terminal state with `outcome`, optional
  visualization-only `main`, optional `output`, and optional final artifacts.
- `fsm.passive(config)` declares a passive state for lower-level XState flows,
  with optional visualization-only `main`.
- `fsm.embed(child, options)` embeds a child FSM and handles its typed final
  outputs.
- `fsm.input.string(...)`, `fsm.input.number(...)`, `fsm.input.path(...)`, and
  `fsm.input.custom<T>(...)` declare machine inputs.
- `fsm.input.values([...])` declares a static completion set.
- `fsm.skill(name, options)` references an installed skill by name.
- `fsm.skill.path(path, options)` references a skill by path.
- `fsm.event<T>()` declares a signal event for `withEvents`.
- `fsm.event<T, R>({ defaultReturn })` declares a request event for
  `withEvents`.
- `fsm.withEvents(events)` returns a factory that can handle those custom event
  keys in state `on` maps.

The lower-level compatibility exports remain available from `@aharness/core`:
`aharness.machine`, `state`, `exit`, `final`, `terminal`, `passive`, `arg`,
`embed`, and `skill`. New examples should prefer `createFsm`.

## Package Assets

Installable FSM packages can reference package-contained assets through the
`aharness` namespace:

- `aharness.getAssetUrl(relativePath)` returns a `file://` `URL`.
- `aharness.getAssetText(relativePath, encoding?)` reads text synchronously and
  defaults to UTF-8.

For installable packages, `relativePath` must be a string-literal
package-relative path such as `prompts/brainstorming.md`. The package-aware
loader validates these references before importing the compiled FSM. Asset
paths are resolved relative to the npm package containing the source module
that made the call, so dependency package modules read their own package assets.

Dynamic paths, absolute paths, parent-directory escapes, missing files,
directories, symlinks, and realpath escapes are rejected for installable
packages. Direct-file FSM loading does not add package-relative asset semantics;
uncompiled calls to these helpers fail with an error telling the author that
package asset calls must be compiled and validated by the package-aware loader.

## State Options

`prompt` is the instruction for Codex while the state is active. It may be a
string or a function of readonly machine data.

`on` maps event names to transitions. Unknown keys must use `fsm.submit(...)`
or `fsm.await(...)`. Plain object handlers are accepted for events declared
with `withEvents(...)` and for the built-in event keys.

`ask` declares owner-facing text for states that need owner input. Use it with
an await or with a later submit that interprets the owner reply.

`clearOnEntry: true` starts a fresh Codex thread after a committed non-self
transition enters that state. Machine data and run artifacts remain live.

`main: true` marks a state, passive state, or final as part of the graph's
primary spine. It is visualization-only metadata and never changes transition
legality, verifier checks, emitted run state, or runtime behavior.

`skills` attaches skill references for the active state.

## Submit, Await, And Events

`fsm.submit<T>({ to, reduce, effect, actions })` moves directly to another
state when Codex submits payload `T`.

`fsm.submit<T>({ route: [...] })` chooses the next state from ordered route
branches. Each branch can have `if`, `to`, `reduce`, `effect`, and `actions`;
the final branch may omit `if` as a catch-all.

`fsm.await({ ask, to, reduce, effect })` asks the owner for text and moves to
the configured state after the reply.

Custom events declared with `withEvents` can either be signal events or request
events with a `defaultReturn`. Request events return their default if the
active state has no matching handler or a selected handler fails before
returning.

Built-in event keys are reserved:

- `permissionRequest`
- `preToolUse`
- `postToolUse`
- `userPromptSubmit`

`permissionRequest`, `preToolUse`, and `postToolUse` handlers may include a
`match` delivery prefilter. Branch predicates remain workflow logic.

## CLI

```bash
aharness <file.fsm.ts> [--<flag> <value>]...
aharness visualize <file.fsm.ts> [--<flag> <value>]...
aharness verify <file.fsm.ts>
aharness doctor
aharness init --dir <path> [--force] [--no-git] [--no-install] [--pm <npm|pnpm|yarn|bun>]
aharness install <source>
aharness run <command> [--<flag> <value>]...
aharness list
aharness uninstall <package-name>
aharness verify <package-name>
aharness verify <package-name>/<command-name>
aharness completion install [--shell bash|zsh|fish]
aharness completion uninstall
```

Machine inputs become kebab-case flags for `aharness <file.fsm.ts>` and
`aharness visualize <file.fsm.ts>`. For example, `fixtureRoot` becomes
`--fixture-root`. `aharness visualize` does not require runtime input flags; any
provided flags are checked for name/type validity but are not used to start an
actor.

`aharness verify` checks an FSM without starting a run. `aharness doctor` checks
the Codex CLI version gate and reports active run health from `.aharness/runs`.
`aharness visualize` verifies and opens the browser graph/details UI in
inspection mode without starting Codex, hooks, a thread, or the FSM actor.
Function-form prompts are shown as source so dynamic state instructions remain
inspectable.

During live runs, the same browser shell also shows the active turn state and
user-relevant tool/MCP calls in the transcript. Internal aharness submit and
owner-input plumbing remains hidden from the default view.

`aharness install <source>` delegates package-spec handling to npm inside the
aharness managed npm project. The source may be any package spec npm accepts.
Install may run npm lifecycle scripts, and v1 does not provide an aharness
`--ignore-scripts` flag. aharness writes trusted install and command-index
records only after the installed package metadata, assets, loader, and verifier
checks succeed. If validation fails after npm mutates the managed project, npm
files may remain changed, but unverified commands are not indexed.

Installed package identity is the installed package's own `package.json` name.
For npm aliases, the alias remains the npm dependency key used for uninstall,
but aharness command identity and collision checks use the installed package
name. Source refresh checks normalize npm package specs by stable source:
registry origin plus package name, alias target package, canonical Git/GitHub
repository, local directory realpath, local tarball realpath, or remote tarball
URL with transient auth material removed. Versions, dist-tags, semver ranges,
Git refs, Git commits, and local snapshot contents do not make a different
source by themselves.

Re-running `aharness install <same-source>` refreshes a package only after the
new installed package validates and all commands verify. Local directory and
local tarball installs are snapshots; changing the source contents requires
running install again. If a different source resolves to a package name that is
already installed, aharness rejects it and tells you to uninstall the existing
package before replacing it.

`aharness run <command> [--<flag> <value>]...` runs an installed package
command. Fully qualified command names, such as `@scope/tools/build` or
`tools/build`, are stable. Bare command names are accepted only when exactly one
installed package provides that command; bare-name collisions require a fully
qualified command. Package commands named `list` or `verify` are invoked through
`aharness run list` and `aharness run verify`, not as top-level verbs.

`aharness list` prints installed packages, their commands, and any bare-command
collisions.

`aharness uninstall <package-name>` removes an installed package by its exact
package identity, including scoped names such as `@scope/tools`. It delegates
the package removal to npm inside the aharness managed npm project, removes the
trusted install record, and regenerates the command index from the remaining
trusted installs. The command target is a package name, not a command name or
bare command alias.

`aharness verify <file.fsm.ts>` still verifies a direct FSM file. Installed
packages can be checked with `aharness verify <package-name>`, and a single
installed command can be checked with
`aharness verify <package-name>/<command-name>`.

Installed `run` and installed `verify` recompute the current managed npm
project lock fingerprint before loading a package command. If the managed tree
no longer matches the verified install record, reinstall or uninstall the
package before running or verifying it.

`commands.json` is a derived index from `installs.json`. If aharness detects a
missing, malformed, or stale command index after a crash or interrupted trusted
write, it regenerates the index from a valid `installs.json` after confirming
the recorded package lock fingerprints still match the managed npm project.
Malformed `installs.json` remains a hard trust-boundary failure because there is
no trusted source of truth to regenerate from.

### Browser Graph

The graph is laid out top-to-bottom from the FSM's semantic entry state. Reachable
terminal states that end the visible local flow are kept at the bottom of their
scope, including terminal states inside an expanded embedded FSM.

If any visible states in a scope are marked `main: true`, those marked states
define the rank-defining spine for that scope. Transitions between marked states
drive the primary top-to-bottom layout for acyclic portions of that spine.
Unmarked repair, recovery, resume, and failure paths stay visible but do not
determine the primary ordering. The renderer encodes selected main-forward
edges with shared fixed center ports so ELK can keep that path on one
scope-local centerline while it routes the rest of the graph.

Loops among marked states are still main-spine information. Main-to-main
backtracking, loop, and self-loop transitions are rendered as main feedback
edges, so they stay visible and routed, but not every main edge can point
downward in a cyclic workflow.

ELK owns the base node placement, crossing minimization, and structural edge
routing. aharness supplies semantic model order, cycle and feedback metadata,
fixed center ports and straightness priority for marked main-forward paths, and
CSS styling.

The visualizer renders every currently visible semantic transition. Layout may
classify transitions as primary flow, branch, feedback, auxiliary/control,
resume, or terminal flow, but those roles are renderer-local presentation
metadata. Auxiliary and control-flow transitions can be rank-neutral and routed
by ELK as normal graph edges, so repeated recovery or resume edges remain
visible without dominating the renderer's primary node order.

Hovering a visible edge highlights the edge and its visible source and target
states. The edge title or tooltip shows its transition kind, exit, visible
endpoints, and original semantic endpoints only when hierarchy projection makes
them differ. Edge click or tap pinning is not part of the current graph
interaction contract.

Embedded FSM states are collapsed by default so the parent workflow remains
readable. Internal transitions hidden by a collapsed embed become visible when
the embed is expanded. Use the dedicated `Expand <state>` and `Collapse <state>`
controls to show or hide an embedded FSM without changing the selected semantic
state; clicking the node body still selects that visible node. Expanded embeds
render as labeled regions whose child states have their own local entry and
terminal ordering.

Clicking a visible state also applies graph-local connected-edge highlighting
using the visible routed endpoints on the canvas. This local graph selection is
separate from ActivePanel scope selection, which is still invoked through the
node click callback. Clicking the same state keeps it selected; only a true
blank-canvas click clears it.

Retry and backtracking paths use feedback-edge styling. When multiple parallel
transitions share the same source and target, the current run history can identify
the possible fired edges but not the exact branch, so the graph highlights those
edges with lower-emphasis candidate-fired styling. Repeated low-information
edge labels may be summarized or shown on hover/focus, but the underlying edge
paths remain inspectable.

The legend is contextual. Rows describe graph-specific user-facing signals such
as current state, selected state, last transition, hidden child activity, and
loop/back edge; they do not expose renderer-local taxonomy names.

## FSM Packages

Reusable FSM packages are npm-shaped packages with explicit command metadata in
`package.json`:

```json
{
  "name": "@scope/tools",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@aharness/core": "^0.1.0"
  },
  "aharness": {
    "package": {
      "commands": {
        "build": {
          "entry": "fsms/build.fsm.ts",
          "description": "Build project artifacts"
        }
      }
    }
  }
}
```

Each command entry must be a package-root-relative `.fsm.ts` file. aharness
validates entries, package-relative asset calls, and `@aharness/core`
compatibility during install before writing trusted command-index records.
Packages are installed and run through the global CLI:

```bash
aharness install @scope/tools
aharness run @scope/tools/build [--<flag> <value>]...
```

Command names such as `list`, `verify`, `help`, and `version` are valid package
commands because they run below `aharness run`.
