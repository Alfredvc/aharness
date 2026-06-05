# Reference

This page documents the current public authoring and CLI surface. The canonical
authoring entry point is `createFsm` from `@aharness/core`.

## Prerequisites

- Node.js `>=20`
- Codex CLI `>=0.136.0`

The latest repository validation is `codex-cli 0.136.0` on 2026-06-02. See
[`packages/core/SUPPORTED_CODEX.md`](../packages/core/SUPPORTED_CODEX.md) for
the compatibility gate and drift-check details.

## Authoring Surface

`createFsm<Data>()` returns the current FSM factory:

- `fsm.machine(config)` declares the machine, optional typed `input`, optional
  run-global `availableSkills`, initial data, initial state, and states map.
- `fsm.state(options)` declares an active Codex state with `prompt`, `on`,
  `entry`, `model`, `clearOnEntry`, visualization-only `main`,
  `guidance`, `skills`, `mode`, and low-level `xstate` escape hatch.
- `fsm.submit<T>(options)` declares a typed model submission exit.
- `fsm.choice(options)` declares a deterministic owner-choice state.
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
- `fsm.skill.path(path, options)` references a skill by `SKILL.md` path.
- `fsm.skill.dir(path)` references a directory of skills for
  `machine.availableSkills`.
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

`on` maps event names to transitions. Unknown keys must use `fsm.submit(...)`,
an event declared with `withEvents(...)`, or a built-in event key.

Use `fsm.choice(...)` for deterministic owner approval/routing/continue gates.
Use `mode: 'open'` states plus typed submit when owner-paced free text must be
interpreted by Codex.

`model` on a state-level declaratively applies model and effort changes for that
state.

Object shape:

```ts
model: {
  name?: 'gpt-5.1-codex',
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
}
```

Valid forms:

```ts
targetModel: fsm.state({
  model: { name: 'gpt-5.1-codex' },
  prompt: 'Review with this model and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});

highEffort: fsm.state({
  model: { effort: 'high' },
  prompt: 'Review with higher reasoning effort.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});

targetedImplementation: fsm.state({
  model: { name: 'gpt-5.1-codex', effort: 'high' },
  prompt: 'Implement in this worktree with the requested model and effort.',
  on: {
    implemented: fsm.submit<{ summary: string }>({ to: 'review' }),
  },
});
```

`model.name` and static `model.effort` values are validated where possible against
Codex `model/list` and `model/list({ includeHidden: true })`.

Sticky behavior:

- A state-level `model` declaration applies for the target state and is used by the
  next aharness-driven turn.
- If a later non-clear state omits `model`, aharness does not clear prior
  settings; the effective model and effort remain in force.

`clearOnEntry` is freshness-only:

- `clearOnEntry: true` creates a replacement thread in the current launch CWD.
- `clearOnEntry: { cwd }` creates a replacement thread in the given absolute
  directory (string or function of machine data).

`clearOnEntry` may be paired with `model`, and both settings are applied on the
clear transition.

```ts
freshWorktreeReview: fsm.state({
  clearOnEntry: { cwd: '/absolute/path/to/worktree' },
  model: { name: 'gpt-5.1-codex', effort: 'high' },
  prompt: 'Review the worktree and submit findings.',
  on: {
    reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
  },
});
```

`model` and `clearOnEntry` settings are scoped by state declaration:

- `clearOnEntry` controls thread replacement and working directory.
- `model` controls model/effort. For non-clear states, omission means "keep the
  current model/effort settings."

`main: true` marks a state, passive state, or final as part of the graph's
primary spine. It is visualization-only metadata and never changes transition
legality, verifier checks, emitted run state, or runtime behavior.

`skills` attaches name-form or `SKILL.md` path-form skill references for the
active state. State skill refs are the only declarations that select structured
Codex skill items for a state turn.

Allowed state skill forms:

- `fsm.skill('reviewing-code')` selects exactly one enabled Codex catalog skill
  by name during startup preflight.
- `fsm.skill.path('../skills/reviewing-code/SKILL.md')` selects the exact
  bundled skill at that path.

`fsm.skill.dir(...)` is invalid in state `skills`.

Top-level `availableSkills` declares run-global skill availability:

```ts
export default fsm.machine({
  id: 'workflow',
  availableSkills: [
    fsm.skill.dir('../skills'),
    fsm.skill.path('../support/review/SKILL.md'),
  ],
  initial: 'plan',
  states: {
    plan: fsm.state({
      skills: [fsm.skill.path('../skills/writing-plans-v2/SKILL.md')],
      prompt: 'Write the current implementation plan.',
      on: {
        done: fsm.submit<{ summary: string }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

`availableSkills` accepts `fsm.skill.path(...)` and `fsm.skill.dir(...)`.
Path-form availability contributes the containing skill directory to the Codex
startup root set. Dir-form availability contributes that directory as a Codex
skill root. `availableSkills` never injects a skill into a state turn by itself.
Name-form refs are invalid in `availableSkills`, because the field is for
declaring concrete package- or repository-owned roots.

## Submit, Choice, And Events

`fsm.submit<T>({ to, reduce, effect, actions })` moves directly to another
state when Codex submits payload `T`.

`fsm.submit<T>({ route: [...] })` chooses the next state from ordered route
branches. Each branch can have `if`, `to`, `reduce`, `effect`, and `actions`;
the final branch may omit `if` as a catch-all.

`fsm.choice({ question, options })` parks the run until the owner picks one of
the authored labels. Each option is `{ label, to }`; labels are the only public
choice identity and do not mutate FSM data by themselves.

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
aharness [--ask|--yolo] <file.fsm.ts> [--<flag> <value>]...
aharness <file.fsm.ts> --help
aharness run [--ask|--yolo] <file.fsm.ts|command> [--<flag> <value>]...
aharness run <file.fsm.ts> --help
aharness visualize <file.fsm.ts> [--<flag> <value>]...
aharness verify <file.fsm.ts>
aharness doctor
aharness init --dir <path> [--force] [--no-git] [--no-install] [--pm <npm|pnpm|yarn|bun>]
aharness install <source>
aharness list
aharness uninstall <package-name>
aharness verify <package-name>
aharness verify <package-name>/<command-name>
aharness completion install [--shell bash|zsh|fish]
aharness completion uninstall
```

Machine inputs become kebab-case flags for
`aharness run <file.fsm.ts|command>`, compatibility direct runs with
`aharness <file.fsm.ts>`, and `aharness visualize <file.fsm.ts>`. For example,
`fixtureRoot` becomes `--fixture-root`. Default live runs use Codex
auto-review for eligible approval prompts. `--ask` restores manual
user/browser review, and `--yolo` remains a dangerous bypass that disables
approvals and grants full filesystem access.

In compatibility direct-run form, runtime flags such as `--ask` and `--yolo`
may appear before or after the FSM path. On `aharness run`, they must appear
before the run target, while FSM input flags must appear after the target:

```bash
aharness run --ask ./workflow.fsm.ts --fixture-root ./fixture
```

Local FSM input help is available for exactly these forms:

```bash
aharness ./workflow.fsm.ts --help
aharness run ./workflow.fsm.ts --help
```

These commands read declared machine inputs statically and print the invoked
usage form, target path information, and declared input flags grouped into
required and optional sections with each flag's type, default marker, and
author-provided descriptions. Help for installed commands, `visualize`,
top-level `aharness --help`, `aharness help`, and arbitrary-position `--help`
are not part of this slice and return generic usage.

`aharness visualize` does not require runtime input flags; any provided flags
are checked for name/type validity but are not used to start an actor.

`aharness completion install` delegates to `@pnpm/tabtab` and writes the
shell-side completion delegate for bash, zsh, or fish. That delegate invokes
the hidden `aharness completion-server` bridge on every Tab press; bare
`aharness completion` is kept as a compatibility alias for the same bridge. At
the root, completion lists top-level subcommands. Path-like direct-run prefixes
delegate to the shell's native file completion. `aharness run` completes local
directories, local `.fsm.ts` files, and installed command identities. After a
target resolves, completion suggests that FSM's input flags and supported flag
values. Machine input completion is schema-aware for boolean flags, static value
sets, file and directory values, and dynamic completion callbacks declared by the
FSM. Already-used input flags are hidden after their values are consumed.

`aharness verify` checks an FSM without starting a run. Verification issues are
printed as `[error]` or `[warning]` lines, prefixed with `file:line:` when the
loader can identify the source location. Warnings do not block verification, but
their detail lines are printed before the final `verify: ok (...)` summary.
`aharness doctor` checks the Codex CLI version gate and reports active run health
from `.aharness/runs`. `aharness visualize` verifies and opens the browser
graph/details UI in inspection mode without starting Codex, hooks, a thread, or
the FSM actor. Function-form prompts are shown as source so dynamic state
instructions remain inspectable.

During live runs, standard output is an operator status stream rather than the
model transcript. It is limited to the run start line, browser UI availability,
Codex launch/readiness, normalized state transitions, and one final completed or
failed summary with the run directory. Completed summaries include the terminal
outcome. Failed summaries include the current state when available plus a short
single-line reason. Transition lines use the form
`aharness: transition <from> --<cause-or-exit>--> <to>`. Detailed model
messages, tool activity, approvals, diagnostics, and raw event payloads remain
available through the browser UI, sensitive run artifacts, or standard error as
appropriate.

During live runs, the same browser shell also shows the active turn state and a
polished transcript with state transitions, lifecycle rows, markdown assistant
messages, concise tool/MCP/subagent rows, and fresh-clear boundaries. Internal
aharness submit plumbing remains hidden from all transcript views; owner-input
plumbing remains hidden from the default view.
Current live and dev replay transcript rows are driven by API-safe compact rows,
including command display fields such as `data.row.data.displayKind`,
`data.row.data.command`, row `output`, row `elapsedMs`, and summary-only
file-change activity. These compact file-change rows expose safe
status/path/count summaries, not diff bodies; full raw file diffs remain
confined to sensitive run artifacts. Pending browser file approval cards are a
separate approval workflow and can show diffs needed for the approval decision.

Run artifacts are written under `.aharness/runs/<runId>/`. For new runs,
`events.jsonl` is a canonical event transcript and includes full raw runtime
payloads by default: secret-marked owner input, browser replies, tool
arguments/results, command output, file diffs, approval/permission/elicitation
data, token usage payloads, and parent-visible sub-thread notifications. It can
also contain public workflow context snapshots recorded as `context.initialized`
and `context.changed` events. Treat run directories as sensitive even when the
browser transcript does not display those context values by default.

The local UI server accepts a per-run token and exposes run-scoped APIs for the
active run:

- `GET /api/runs/:runId/bootstrap`
- `GET /api/runs/:runId/visits/:visitId/rows?cursor=...&limit=...`
- `GET /api/runs/:runId/rows/recent?cursor=...&limit=...`
- `GET /api/runs/:runId/events?after=...&limit=...`
- `GET /api/runs/:runId/summary`
- `GET /api/runs/:runId/stream?after=...`
- `POST /api/runs/:runId/reply`

These routes return compact JSONL-backed projections and canonical run-event
SSE frames for bootstrap, row, diagnostic event, stream, and reply workflows.
API and SSE responses omit raw payloads; use the sensitive `events.jsonl` file
only when raw runtime evidence is needed. The browser does not provide raw JSONL
inspection or compatibility backfill for old compact-row shapes. The React
browser now uses the
run-scoped bootstrap, row, stream, and reply surface. Compact rows include
durable run lifecycle status, safe transition-failure summaries for failed
internal submit attempts, and summary-only file-change transcript rows.
File-change rows do not expose full diffs; API/SSE projections omit those raw
payloads, and full file diffs remain only in sensitive
`events.jsonl` raw evidence. Pending file approval cards are separate
interaction cards and may show approval diffs while a permission decision is
outstanding. Run-scoped bootstrap and SSE projections reconstruct
`currentState.context` from ordered `context.initialized` / `context.changed`
events when those events exist. Context snapshot events are visible through
`/api/runs/:runId/events` and `/api/runs/:runId/stream`, but they do not create
compact rows and therefore do not appear in the default transcript. It renders
compact rows and aggregate running-time/token/context stats in the header and
bottom status bar instead of a top turn count or bottom turn ribbon. The old
flat `/api/state`, `/api/stream`, and `/api/reply` browser routes are no longer
served for new runs. Production live runs do not write `snapshot.json`; retained
snapshot helper exports are legacy/internal compatibility only.

`GET /api/runs/:runId/summary` returns `{ completionStats }` for the active
run. `completionStats` is `null` while the run is active and becomes the
API-safe terminal projection after success or failure. It follows the same
run-scoped token authentication and unavailable-log error shape as the other
run APIs.

When a run reaches a terminal state, the browser shows a poster-style final
overview dashboard with completion outcome, total time, completion status, token
burn, cache-hit rate, main/subthread token split, transition and turn tiles,
four compact tiles for transitions, turns, files changed, and lines changed, and
"Where the time went" bars for top state buckets. Live terminal completion and
terminal inspect/replay bootstrap can auto-open this overview once per page
load. After dismissal, the terminal-only header `Summary` action reopens it.
Active non-terminal runs do not show the action or modal.

Committed work-delta values come only from git facts recorded during the run.
When those facts are unavailable, the overview renders work-delta values as
`N/A`; aharness does not infer file or line deltas from the current checkout at
summary time.

Terminal success and failure overviews can open a share-card preview with
browser-native `Download PNG` and `Copy PNG` actions. The exported image is a
fixed `1320 x 2868` poster-style PNG rendered from a self-contained SVG. Share
cards use a screenshot-matched dark-poster palette: dark navy backgrounds,
near-ivory primary type, blue-gray secondary labels, teal success accents,
coral/orange token-burn gradients, and restrained amber highlights. Failure
cards keep the same layout but use failure-toned accents.

Share cards use display-safe summary fields only: sanitized FSM display name,
outcome, duration, derived turn totals, transition and fresh-clear counts,
derived token percentages, token totals, committed-work counts or `N/A`, top
time buckets plus `Other states`, and neutral aharness branding. When committed
work-delta facts are unavailable, file and line cells render `N/A` and the
poster shows an unavailable committed-delta note instead of inferring checkout
changes. Share cards do not include raw run metadata, transcript text, command
output, owner input, repo paths, git object ids, branch names, or Codex pins.
Partial summaries with `outcome: 'unknown'` are not shareable.

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
`aharness verify <package-name>/<command-name>`. Installed command warnings are
printed as diagnostic lines while the successful command summary remains on
standard output.

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
FSM source remains the source of truth for bundled skill availability: declare
supporting skill directories or paths in `fsm.machine({ availableSkills })`, and
declare immediate per-state skill selections in state `skills`.
Packages are installed and run through the global CLI:

```bash
aharness install @scope/tools
aharness run @scope/tools/build [--<flag> <value>]...
```

Command names such as `list`, `verify`, `help`, and `version` are valid package
commands because they run below `aharness run`. Package-specific binaries are
not part of installed package execution; the stable command identity is
`<package-name>/<command-name>`.
