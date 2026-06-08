# Advanced Runtime Surfaces

Use this reference only when the user explicitly asks for programmatic aharness
runs, Codex sidecar threads, advanced runtime embedding, or typed auxiliary
Codex work. Most FSMs should ignore these APIs and use ordinary states,
submits, choices, hooks, inputs, and final artifacts.

Regular `.fsm.ts` files normally import from `@aharness/core`. Keep
`@aharness/core/runtime` imports in host, fixture, or integration code outside
FSM source.

## Programmatic Runs

`startAharnessRun(options)` is exported from `@aharness/core/runtime` for Node
callers that need to start the same live runtime as `aharness run`.

```ts
import { startAharnessRun } from '@aharness/core/runtime';

const run = await startAharnessRun({
  target: './workflow.fsm.ts',
  cwd: fixtureRoot,
  input: { ticketId: 'REQ-123' },
  permissionMode: 'ask',
  ui: false,
  onEvent(event) {
    observed.push(event);
  },
});

const result = await run.result();
```

Options:

- `target`: required; same target forms as `aharness run <target>`.
- `cwd`: defaults to `process.cwd()`.
- `input`: object keyed by FSM input property names, not CLI flag names.
- `permissionMode`: `'autoReview'`, `'ask'`, or `'yolo'`.
- `ui`: defaults to `false`; `true` serves the UI without opening a browser;
  `{ open: true }` serves the UI and uses the browser launcher.
- `onEvent`: observes canonical `RunEventEnvelope` values written to
  `events.jsonl`.

The handle exposes `runId`, `runDir`, `eventsPath`, optional `uiUrl`,
`subscribe(listener)`, browser-equivalent reply helpers, `cancel(reason?)`, and
`result()`.

Reply helpers:

- `sendText(text)`
- `chooseOwnerOption({ state, visitCount, label })`
- `answerOwnerInput({ requestId, answers })`
- `resolveApproval({ requestId, decision })`
- `resolvePermission({ requestId, decision })`
- `resolveElicitation({ requestId, action, values })`

Reply helpers resolve `{ ok, status, body }`. Startup failures reject
`startAharnessRun(...)`; failures after the handle exists resolve through
`run.result()`. Terminal result status is `'completed'`, `'failed'`, or
`'cancelled'`.

## Codex Sidecar Threads

Use sidecar threads only when an FSM entry/effect needs scoped auxiliary Codex
work that should not become the active parent thread or change the FSM graph.
Sidecars reuse the same live app-server and WebSocket client. They do not
receive `aharness_submit`; author code feeds their typed boundary results back
into declared FSM events with `ops.emit(...)`.

Declare first-turn sidecar skill aliases with machine-level `threadSkills`:

```ts
export default fsm.machine({
  id: 'workflow',
  threadSkills: {
    reviewer: fsm.skill.path('../skills/reviewer/SKILL.md'),
  },
  initial: 'review',
  states: {
    review: fsm.state({
      prompt: 'Start the sidecar reviewer.',
      entry: async (_data, ops) => {
        const thread = await ops.codex.createThread('reviewer', {
          initialSkills: ['reviewer'],
          defaultTurnTimeoutMs: 120_000,
        });
        const result = await thread.send('Review the target and report findings.');
        await ops.emit('reviewed', { result });
        if (!result.ok || result.kind === 'completed') {
          await thread.close();
        }
      },
      on: {
        reviewed: { to: 'done' },
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

Sidecar API:

```ts
interface CodexSidecarOps {
  createThread<Data = unknown>(
    key: string,
    options?: CodexSidecarThreadOptions<Data>,
  ): Promise<CodexSidecarThread>;
  thread(key: string): CodexSidecarThread;
}
```

Thread options include `cwd`, `initialSkills`, `defaultTurnTimeoutMs`, `model`,
`instructions`, and `label`. `initialSkills` values reference `threadSkills`
keys.

Thread methods:

- `send(input, opts?)`
- `sendOrThrow(input, opts?)`
- `answer(requestId, answers, opts?)`
- `close()`

`send()` and `answer()` return a recoverable boundary:

- `{ ok: true, kind: 'completed', turn }`
- `{ ok: true, kind: 'needsInput', request, events }`
- `{ ok: false, reason, message, threadId, turnId?, events }`

Failure reasons are `timeout`, `interrupted`, `thread_closed`,
`app_server_closed`, and `error`. `needsInput` is sidecar
`request_user_input` evidence only; it does not create browser owner-input
controls. Resume it with `thread.answer(request.id, answers)`.

## Sensitivity

Programmatic events and sidecar event arrays are canonical runtime evidence.
They can include owner input, browser replies, tool arguments/results, command
output, file diffs, approvals, permissions, MCP elicitation payloads, token
usage, sidecar activity, cancellation reasons, and context snapshots. Treat
`runDir`, `eventsPath`, and in-memory event streams as sensitive.
