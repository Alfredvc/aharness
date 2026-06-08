# Advanced Runtime Surfaces

Most aharness FSMs should use the normal authoring path: define states,
submits, choices, hooks, inputs, and final artifacts with `@aharness/core`, then
run them with the CLI. The surfaces in this document are for advanced hosts and
advanced FSMs that need direct runtime control.

Use these APIs only when the workflow genuinely needs one of these capabilities:

- a Node process needs to start and drive an aharness live run directly;
- an FSM entry/effect needs a scoped auxiliary Codex thread whose result is fed
  back into typed FSM events;
- the caller is prepared to handle sensitive canonical run events and runtime
  lifecycle failures.

Regular `.fsm.ts` files normally import from the root `@aharness/core`
authoring SDK. Keep `@aharness/core/runtime` imports in host, fixture, or test
code outside FSM source.

## Programmatic Run API

`startAharnessRun(options)` is exported from `@aharness/core/runtime` for Node
callers that need to start a live run, observe canonical run events, send
browser-reply-equivalent inputs, and await a terminal result from TypeScript.
It is a sibling to `aharness run`, not a separate daemon or server-backed
multi-run UI.

```ts
import {
  startAharnessRun,
  type AharnessRunEvent,
} from '@aharness/core/runtime';

const run = await startAharnessRun({
  target: './workflow.fsm.ts',
  cwd: fixtureRoot,
  input: { ticketId: 'REQ-123' },
  permissionMode: 'ask',
  onEvent(event: AharnessRunEvent) {
    ownerSimulation.observe(event);
  },
});

await run.sendText('Here is the requested context.');
const result = await run.result();
```

Options:

- `target` is required and uses the same target semantics as
  `aharness run <target>`: local `.fsm.ts` files, unique installed bare command
  names, and fully qualified installed command identities.
- `cwd` defaults to `process.cwd()` and is used for local target resolution,
  run metadata, and the launched runtime's repository root.
- `input` defaults to `{}`. Programmatic input is keyed by FSM input property
  names, not kebab-case CLI flag names. It must be a non-null object, not an
  array, and must not contain `undefined` values at any depth. FSM input
  defaults are applied before schema validation. Missing required inputs,
  unknown fields, invalid types, invalid custom schemas, and any provided input
  for an FSM that declares no inputs fail before Codex starts.
- `permissionMode` is optional. When omitted, it keeps the same default Codex
  auto-review behavior as `aharness run` without `--ask` or `--yolo`. The
  explicit values are `'autoReview'`, `'ask'`, and `'yolo'`. Use `'ask'` for
  manual permission review and `'yolo'` only for the same dangerous approval
  bypass exposed by the CLI.
- `ui` defaults to `false`, so no browser UI server is started. `ui: true`
  serves the same run-scoped browser UI without opening a system browser.
  `ui: { open: true }` serves it and uses the CLI browser-launch behavior.
- `onEvent` subscribes to canonical run events. The event object is the exact
  `RunEventEnvelope` appended to `.aharness/runs/<runId>/events.jsonl`.

The returned `AharnessRunHandle` exposes:

- `runId`, `runDir`, and `eventsPath` for the local run artifacts.
- `uiUrl` when a programmatic UI was requested.
- `subscribe(listener)`, which receives future canonical
  `AharnessRunEvent` envelopes and returns an unsubscribe function.
- `sendText(text)` for open-state owner text.
- `chooseOwnerOption({ state, visitCount, label })` for authored
  `fsm.choice(...)` states.
- `answerOwnerInput({ requestId, answers })` for model-originated
  `request_user_input` prompts. Answers are `Record<string, string>`.
- `resolveApproval({ requestId, decision })` for command and file approval
  requests. Decisions are `'accept'`, `'acceptForSession'`, `'decline'`, and
  `'cancel'`.
- `resolvePermission({ requestId, decision })` for permission approval
  requests. Decisions use the same values as approval resolution.
- `resolveElicitation({ requestId, action, values })` for MCP elicitation
  requests. Actions are `'accept'`, `'decline'`, and `'cancel'`. `values` is
  needed only when the accepted elicitation requires form values.
- `cancel(reason?)`, which requests live-run cancellation.
- `result()`, which resolves the terminal `AharnessRunResult`.

Reply helpers return `AharnessRunReplyResult`:

```ts
interface AharnessRunReplyResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}
```

`status` and `body` mirror the existing browser reply controller result without
requiring HTTP in the caller. `ok` is derived as `status >= 200 && status < 300`.
Invalid request ids, stale state visits, unavailable reply kinds, invalid answer
maps, and closed runs are returned as non-OK reply results rather than thrown
exceptions when the reply controller can handle the request.

`startAharnessRun(...)` rejects before returning a handle when startup cannot
create a valid live run, such as target resolution, verification, installed
target trust, input validation, Codex auth, or Codex version-gate failures.
After a handle exists, terminal state is reported through `run.result()`:

```ts
type AharnessRunStatus = 'completed' | 'failed' | 'cancelled';

interface AharnessRunResult {
  readonly status: AharnessRunStatus;
  readonly exitCode: number;
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly terminalState?: string;
  readonly terminalOutcome?: string;
  readonly reason?: string;
}
```

`cancel(reason?)` is idempotent from the caller's perspective. Where the live
engine has canonical logging available, cancellation publishes `run.cancelled`,
sets the terminal result status to `'cancelled'`, uses exit code `130`, and
preserves the optional reason. Later reply helper calls resolve with a closed
run reply result.

## Codex Sidecar Threads

Sidecar threads are for advanced FSM author code that needs scoped auxiliary
Codex work without making that work the active parent FSM thread or graph
topology. They reuse the run's single Codex app-server and WebSocket
connection. They do not receive `aharness_submit`; they return typed boundaries
to author code, which can feed results back into declared FSM events.

### Thread Skills

Top-level `threadSkills` declares keyed skill refs for managed Codex sidecar
threads:

```ts
export default fsm.machine({
  id: 'workflow',
  threadSkills: {
    requirementsDriver: fsm.skill.path('../skills/requirements-driver/SKILL.md'),
    reviewer: fsm.skill('reviewing-code'),
  },
  initial: 'plan',
  states: {
    plan: fsm.state({
      prompt: 'Write the current implementation plan.',
      on: {
        done: fsm.submit<{ summary: string }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

`threadSkills` must be an object with non-empty keys. Values accept the same
name-form and path-form refs as state `skills`; dir-form refs are invalid.
Every entry participates in startup skill catalog preflight. Path-form refs
resolve relative to the FSM source file that declared them, including embedded
FSM sources, and duplicate transitive keys are verifier errors because sidecar
turns address skills by key.

### Sidecar Ops

Entry and effect callbacks receive `ops: AharnessOps`. In live runs,
`ops.codex` creates and retrieves managed Codex sidecar threads, and
`ops.emit(...)` routes typed custom events through the same canonical event
dispatcher used by browser and owner inputs. In preflight and dry-run contexts
the properties still exist, but using them throws because no live app-server or
event dispatcher is bound.

```ts
interface AharnessOps {
  readonly codex: CodexSidecarOps;
  emit<Payload>(eventName: string, payload: Payload): Promise<AharnessEmitResult>;
}

interface AharnessEmitResult {
  readonly handled: boolean;
  readonly stateChanged: boolean;
  readonly returnValue: unknown;
}

interface CodexSidecarOps {
  createThread<Data = unknown>(
    key: string,
    options?: CodexSidecarThreadOptions<Data>,
  ): Promise<CodexSidecarThread>;
  thread(key: string): CodexSidecarThread;
}
```

`createThread(key, options)` uses an author-defined key such as `"subject"` or
`subject:${areaId}`. `ops.codex.thread(key)` returns the current live sidecar
handle for that key and throws when the key is unknown, closed, or not owned by
the run. Sidecar keys are not Codex thread ids; the handle exposes `threadId`
only for diagnostics and run evidence.

```ts
interface CodexSidecarThreadOptions<Data = unknown> {
  readonly cwd?: string | ((data: Readonly<Data>) => string);
  readonly initialSkills?: readonly string[];
  readonly defaultTurnTimeoutMs?: number; // defaults to 120_000
  readonly model?: {
    readonly name?: string;
    readonly effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
  readonly instructions?: {
    readonly base?: string;
    readonly developer?: string;
  };
  readonly label?: string;
}
```

Relative `cwd` values resolve against the FSM source file that declared the
sidecar operation. Function-form `cwd` receives readonly active state data and
then follows the same relative-path rule. `initialSkills` entries reference
machine-level `threadSkills` keys and are injected only into the sidecar's first
turn. The default sidecar boundary timeout is `120_000ms`; per-turn
`timeoutMs` overrides it for one `send()` or `answer()` operation.

```ts
interface CodexSidecarThread {
  readonly key: string;
  readonly threadId: string;
  readonly label?: string;

  send(
    input: string | readonly CodexSidecarInput[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<CodexSidecarBoundaryResult>;

  sendOrThrow(
    input: string | readonly CodexSidecarInput[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<CodexSidecarBoundary>;

  answer(
    requestId: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<CodexSidecarBoundaryResult>;

  close(): Promise<void>;
}
```

`close()` is idempotent. Closing an active sidecar prevents further lookup
through `ops.codex.thread(key)` until a later live sidecar reuses that key.

Sidecar turn input is intentionally closed:

```ts
type CodexSidecarInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string; readonly detail?: ImageDetail }
  | { readonly type: 'localImage'; readonly path: string; readonly detail?: ImageDetail }
  | { readonly type: 'mention'; readonly name: string; readonly path: string };

type ImageDetail = 'auto' | 'low' | 'high' | 'original';
```

Raw skill input items are not part of the public sidecar input union. Declare
sidecar skill aliases with machine-level `threadSkills`, then pass those aliases
through `initialSkills` so aharness can resolve and inject them on the first
sidecar turn.

Result values are recoverable by default:

```ts
type CodexSidecarBoundaryResult =
  | { readonly ok: true; readonly kind: 'completed'; readonly turn: CodexSidecarTurn }
  | {
      readonly ok: true;
      readonly kind: 'needsInput';
      readonly request: CodexSidecarInputRequest;
      readonly events: readonly CodexSidecarEvent[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'timeout'
        | 'interrupted'
        | 'thread_closed'
        | 'app_server_closed'
        | 'error';
      readonly message: string;
      readonly threadId: string;
      readonly turnId?: string;
      readonly events: readonly CodexSidecarEvent[];
    };

type CodexSidecarBoundary = Extract<CodexSidecarBoundaryResult, { readonly ok: true }>;
```

`{ ok: true, kind: 'needsInput' }` means the sidecar parked on Codex
`request_user_input`. It is sidecar evidence, not owner input for the parent
state. Resume it with `thread.answer(request.id, answers)`.

Failure statuses are stable boundary values:

- `timeout` means the configured boundary timeout elapsed. Aharness interrupts
  the sidecar turn when Codex has accepted a turn id.
- `interrupted` means the run or sidecar operation was cancelled or interrupted.
- `thread_closed` means the sidecar was already closed or was closed while the
  operation was active.
- `app_server_closed` means the shared Codex app-server connection closed before
  the boundary completed.
- `error` means aharness or Codex reported an unexpected sidecar failure. The
  result carries a message and may carry a `cause`.

Sidecar command, file-change, permission, and MCP elicitation requests follow
the run approval mode and can appear as browser pending cards through the
existing `request.*` lifecycle with sidecar metadata. They do not invoke FSM
`permissionRequest` hooks, because those hooks are policy for the active parent
state. Sidecar `request_user_input` is different: it returns `needsInput` to
author code and never creates owner-reply controls.

Use `ops.emit(eventName, payload)` from entry/effect code to send typed events
declared with `withEvents(...)`. The dispatch uses the normal canonical event
path, including serialization, custom event recording, reducers/effects, final
artifact capture, and terminal handling.

### Sidecar Troubleshooting

If startup preflight fails before the first sidecar turn, check that each
`threadSkills` value names one enabled catalog skill or a valid `SKILL.md` path,
and that every `initialSkills` entry references one of those keys. Dir-form
skill refs are valid for `availableSkills`, not `threadSkills`.

If author code receives `{ ok: true, kind: "needsInput" }`, the sidecar is
parked on Codex `request_user_input`. That prompt is recorded as sidecar
evidence, but it does not create owner-input controls in the browser. Resume it
from author code with `ops.codex.thread(key).answer(request.id, answers)`.

Sidecar command, file-change, permission, and MCP elicitation approvals still
use the normal browser approval cards when the run approval mode routes them to
the user. If you expected a sidecar approval card and none appeared, confirm the
run was started with the intended approval mode, such as `--ask`, and inspect
`.aharness/runs/<runId>/events.jsonl` for `request.*` events with sidecar
metadata.

## Canonical Event Sensitivity

Both surfaces expose or record canonical runtime evidence. Programmatic
subscribers can see raw runtime evidence that browser projections hide or
summarize, including secret-marked owner input, browser replies, tool arguments
and results, command output, file diffs, approval, permission, MCP elicitation
data, token usage, cancellation reasons, sidecar activity, and workflow context
snapshots.

Treat `eventsPath`, `runDir`, sidecar event arrays, and in-memory canonical
event streams as sensitive.
