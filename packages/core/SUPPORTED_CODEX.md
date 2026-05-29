# Supported Codex versions

This package requires the installed `codex` CLI to report version
**`0.130.0`** or newer.

The latest compatibility check in this repository validated
**`codex-cli 0.133.0`** on 2026-05-24. The minimum remains `0.130.0`;
`0.133.0` is an observed-compatible version, not a new floor.

The offline protocol drift checker still targets `codex-rs` commit
**`127434cd8b968ca3d830ea78106dcb1506bcd843`** (short: `127434cd8b96`).

Source-path references and JSON-RPC method names recorded in this package's
code and docs are valid at this commit. Earlier versions may lack
`dynamic_tools` immutability, the `default_mode_request_user_input` feature
flag, the `app-server` JSON-RPC surface this code relies on, or specific
notification field shapes documented below.

The version string written to `scripts/codex-version-min.txt` is `0.130.0`.

---

## Runtime gate and drift pin

The runtime version gate is semver-based because current Codex CLI builds
report `codex-cli <semver>` from `codex --version`. `aharness doctor` and
the foreground CLI compare that output against `scripts/codex-version-min.txt`.

The protocol drift checker remains **git commit addressed**. It verifies
the JSON-RPC method names, request shapes, approval enum spellings, and
`request_user_input` behavior against the pinned source commit without
fetching from the network or trusting a mutable local `HEAD`.

Rationale for the current pair: `0.130.0` is the CLI version used for the
real Codex E2E release checks, and the pinned commit contains the upstream
surfaces this package depends on: `dynamic_tools`, the
`default_mode_request_user_input` feature flag, required
`request_user_input` question options, clear-on-entry model/effort
selection surfaces, and the JSON-RPC methods `item/tool/call`,
`item/tool/requestUserInput`, `thread/inject_items`, `config/read`, and
`model/list`.
The `0.133.0` validation rechecked those runtime surfaces with the installed
CLI, including owner-yield `request_user_input` and app-server command
approval E2E paths.

---

## Offline drift checker

The executable pin check is:

```bash
pnpm --dir packages/core run verify:codex-bump
```

By default it reads the local Codex checkout at `/Users/alfredvc/src/codex`.
Use either form below to point it at another checkout containing the pinned
commit:

```bash
CODEX_CHECKOUT=/path/to/codex pnpm --dir packages/core run verify:codex-bump
pnpm --dir packages/core run verify:codex-bump -- --checkout /path/to/codex
```

The checker is offline and commit-addressed: it uses `git show
127434cd8b968ca3d830ea78106dcb1506bcd843:<path>` and `git cat-file`
against the local checkout. It does not fetch, read a remote branch, or
trust the checkout's mutable worktree `HEAD`.

Current check families:

- Aharness `METHOD` literals versus Codex's pinned app-server request and
  notification macro table.
- `request_user_input` source shape, including the
  `default_mode_request_user_input` feature gate and handler path.
- Approval and permission enum spellings used by Phase 4:
  `on-request`, approval decisions, permission grant scopes, and
  `sandbox_permissions: "require_escalated"`.
- `codex app-server` listen and schema/type generation surfaces, plus
  the absence of an app-server-specific `--approval-policy` flag.
- Clear-on-entry model and reasoning-effort source contract:
  `ThreadStartParams.config`, `config/read`, `model/list`, model-specific
  supported efforts, and lowercase `ReasoningEffort` values.
- The aharness `DAEMON_PROBE_CLIENT_NAME` constant
  `codex_app_server_daemon`.
- Clear-on-entry model and reasoning-effort surfaces:
  `thread/start.config`, `config/read`, `model/list`,
  `ReasoningEffort`, and model-specific supported efforts.

Root `pnpm run verify` and `pnpm run verify:release` run this package-local
check. It requires a local Codex checkout containing the pinned commit, either
at `/Users/alfredvc/src/codex` or at `CODEX_CHECKOUT=/path/to/codex`.

## ClearOnEntry model and effort contract

`clearOnEntry` replacement threads may request a Codex model and reasoning
effort. Aharness relies on the following pinned source surfaces at
`127434cd8b96`:

- `codex-rs/app-server-protocol/src/protocol/v2.rs` declares
  `ThreadStartParams { model, cwd, config, ... }`; aharness sends the requested
  model through `thread/start.model`.
- The correct effort channel is `thread/start.config.model_reasoning_effort`.
  Codex exposes `ThreadStartParams.config: Option<HashMap<String, JsonValue>>`
  in the same `ThreadStartParams` struct, and its `Config` type declares
  `model_reasoning_effort: Option<ReasoningEffort>`.
- `codex-rs/app-server-protocol/src/protocol/common.rs` declares
  `ConfigRead => "config/read"` with `ConfigReadParams` and
  `ConfigReadResponse`. `ConfigReadParams` has `include_layers` and optional
  `cwd`; `ConfigReadResponse.config` is the effective config source aharness
  uses to resolve the target model when only `reasoningEffort` is declared.
- The same `common.rs` table declares `ModelList => "model/list"` with
  `ModelListParams` and `ModelListResponse`. Aharness calls
  `model/list({ includeHidden: true })` for catalog validation.
- `v2.rs` declares `Model.supported_reasoning_efforts`,
  `Model.default_reasoning_effort`, `Model.is_default`, and
  `ReasoningEffortOption.reasoning_effort`. The supported-efforts list is the
  model-specific signal aharness uses for verify-time and runtime preflight
  validation.
- `codex-rs/protocol/src/openai_models.rs` declares `ReasoningEffort` with
  lowercase serde spellings: `none`, `minimal`, `low`, `medium`, `high`, and
  `xhigh`.

The offline drift checker validates these method literals and source spans at
the pinned commit. Do not weaken the check to rely on mutable Codex `HEAD`; if a
future feature needs a source surface absent from `127434cd8b96`, bump the
documented pin deliberately.

## Aharness hook override shape

Declared `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` hooks are injected
with Codex `-c hooks.<Kind>=...` overrides using Codex's matcher-group array
shape. The aharness wrapper omits `matcher`, so Codex matches every input for the
declared kind and still aggregates user hook config from the normal Codex layers.

```toml
[{ hooks = [{ type = "command", command = "'/abs/run/hooks/pre_tool_use.sh'", timeout = 30, statusMessage = "aharness PreToolUse" }] }]
```

`PermissionRequest` is not a Codex hook-engine kind and is not emitted as a
`hooks.PermissionRequest` override; it is handled inside the aharness approval
dispatcher.

---

## Verification of design-cited paths

`docs/specs/2026-05-01-codex-migration-design.md` references specific
file paths and line ranges in `codex-rs`. Each was checked against the
pinned commit. "verified" means the file exists and the cited region
still contains content matching the design's claim. "moved" means the
file exists but the content has shifted to a different line range
(still locatable). "missing" means the content is no longer present.

| Path                                              | Cited range                             | Status              | Note                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rmcp-client/src/logging_client_handler.rs`       | 83-85                                   | verified            | `on_tool_list_changed` no-op at lines 83-85; matches "notifications/tools/list_changed no-op" claim.                                                                                                                                                                                                                                                                                                |
| `app-server/src/codex_message_processor.rs`       | 4811-4829                               | moved               | `ThreadForkParams` handler `thread_fork` is now at lines 4945-4946 (was 4811-4829). The struct is imported at lines 165-166 and dispatched at 1036-1037.                                                                                                                                                                                                                                            |
| `app-server/src/bespoke_event_handling.rs`        | 852-889                                 | moved               | `EventMsg::DynamicToolCallRequest` arm is at lines 800-836 (was 852-889). `DynamicToolCallParams` import at lines 25-26; `send_request(ServerRequestPayload::DynamicToolCall(params))` at 833.                                                                                                                                                                                                      |
| `app-server/src/outgoing_message.rs`              | 309-315 (broadcast)                     | moved               | `OutgoingEnvelope::Broadcast` send is at line 290 (was 309-315). The cited 309-315 is now the per-connection fan-out completion in `send_request_to_connections`.                                                                                                                                                                                                                                   |
| `app-server/src/outgoing_message.rs`              | 384-386 (loser-drop)                    | moved               | The "loser drops the response" semantics are implemented in `notify_client_response` at lines 350-365 and `take_request_callback` at lines 240-242 — when the callback entry is already taken (consumed by the winner) the responder finds nothing and the response is dropped. The cited 384-386 is now the body of `cancel_request`, which is a different (but related) cleanup path.             |
| `core/src/tools/handlers/dynamic.rs`              | (`request_dynamic_tool`)                | verified            | `request_dynamic_tool` is defined at line 78 and called from line 54.                                                                                                                                                                                                                                                                                                                               |
| `core/src/tools/registry.rs`                      | (`dispatch_any` + PreToolUse gate skip) | verified            | `pub(crate) async fn dispatch_any` at line 265; `pre_tool_use_payload` gate inside dispatch at line 357 (skipped when handler returns `None` from `pre_tool_use_payload`).                                                                                                                                                                                                                          |
| `core/src/tools/handlers/request_user_input.rs`   | (file existence)                        | verified            | `RequestUserInputHandler` defined at line 14, `impl ToolHandler` at line 18, args parse at line 54.                                                                                                                                                                                                                                                                                                 |
| `tools/src/request_user_input_tool.rs`            | 13-21                                   | verified            | `request_user_input_available_modes` at lines 13-21 contains the `DefaultModeRequestUserInput` feature gating logic verbatim.                                                                                                                                                                                                                                                                       |
| `core/src/codex_thread.rs`                        | (`inject_response_items`)               | verified            | `pub async fn inject_response_items` at line 358.                                                                                                                                                                                                                                                                                                                                                   |
| `core/src/client.rs`                              | 831-904                                 | verified            | `build_responses_request` spans lines 831-905.                                                                                                                                                                                                                                                                                                                                                      |
| `core/src/client.rs`                              | 880                                     | verified            | `prompt_cache_key = Some(...)` at line 880.                                                                                                                                                                                                                                                                                                                                                         |
| `core/src/client.rs`                              | 881                                     | verified            | `let request = ResponsesApiRequest { ... }` opens at line 881.                                                                                                                                                                                                                                                                                                                                      |
| `core/src/client.rs`                              | 886                                     | verified            | `tool_choice: "auto".to_string()` at line 886.                                                                                                                                                                                                                                                                                                                                                      |
| `core/src/client.rs`                              | 936-973                                 | verified            | `get_incremental_items` at line 936; the cited region covers its body.                                                                                                                                                                                                                                                                                                                              |
| `core/src/client.rs`                              | 1447-1452                               | moved               | The "websocket prewarm" surface referenced is now `prewarm_websocket` at line 1444; lines 1447-1452 are the parameter list (`prompt`, `model_info`, `session_telemetry`, `effort`, `summary`, `service_tier`, `turn_metadata_header`). Function still present, just shifted within the file.                                                                                                        |
| `core/src/session/turn.rs`                        | 541-545                                 | verified            | `stop_outcome.should_block` Stop-hook handling at lines 535-548; the cited 541-545 covers the `record_conversation_items` call inside the `should_block` branch.                                                                                                                                                                                                                                    |
| `core/src/config/mod.rs`                          | 622-624 (ephemeral)                     | moved               | The cited line range now contains `codex_home` (lines 622-624). The `pub ephemeral: bool` field on the resolved `Config` is at line 650; it also appears as `pub ephemeral: Option<bool>` on `ConfigOverrides` at line 1804 and is consumed at lines 2072 and 2988. The `ephemeral` semantics are present and load-bearing — only the line number has shifted.                                      |
| `cli/src/main.rs`                                 | 664-676                                 | moved               | The `InteractiveRemoteOptions` struct (which carries `--remote` and `--remote-auth-token-env`) is at lines 661-673. The cited range overlaps but starts a few lines later than the actual struct.                                                                                                                                                                                                   |
| `tui/src/app_server_session.rs`                   | 351                                     | verified-by-absence | The cited line is part of `start_thread`'s error-mapper. The "no auto-reconnect" claim of the design is supported by the absence of reconnect logic anywhere in the file: `git grep -n 'reconnect' tui/src/app_server_session.rs` returns no matches.                                                                                                                                               |
| `tui/src/slash_command.rs`                        | 12                                      | verified            | `pub enum SlashCommand` declaration at line 12 with `#[strum(serialize_all = "kebab-case")]` discriminant — closed enum, no `Custom(String)` variant.                                                                                                                                                                                                                                               |
| `app-server-transport/src/transport/websocket.rs` | 176                                     | moved               | The cited region now contains `run_websocket_connection`'s function signature (line 172-180). The "WebSocket disconnect on full" semantics are implemented at lines 366-368, where a `TrySendError::Full(_)` on the writer-control queue logs `"websocket control queue full while replying to ping; closing connection"` and breaks the read loop. The behaviour exists, just at a different line. |
| `protocol/src/request_user_input.rs`              | 32-34                                   | verified            | `RequestUserInputArgs { questions: Vec<RequestUserInputQuestion> }` at lines 31-34.                                                                                                                                                                                                                                                                                                                 |
| `config/src/hook_config.rs`                       | 113-114                                 | verified            | `HookHandlerConfig::Command { ..., timeout_sec: Option<u64>, ... }` at lines 109-119; `timeout_sec` (renamed via `#[serde(rename = "timeout")]`) declared at lines 113-114.                                                                                                                                                                                                                         |

Net summary: every cited path **exists and contains the cited
content**, but several have **moved within their file**. Where line
numbers shifted, this table records the current line of the same
content. No cited content is missing. Downstream tasks should treat
this table as the authoritative line-number source rather than the
design doc.

---

## Historical Phase 1 sentinel (2026-05-12)

During the early headless cutover, Phase 1 (this historical commit
range) shipped:

- `aharness_submit` declared via `dynamic_tools` (no MCP child).
- Sole-WS-client topology; the aharness CLI is the only subscriber.
- Self-loop + terminal submit transitions only. Cross-state submits,
  `awaitsOwnerText`, `await` exits, `ops.clear()`, per-state hook
  dispatch, and approvals are NOT wired and will throw at runtime.

Resume cutover-detection: snapshots written by pre-Phase-1 builds
abort with exit 2 (`snapshot from incompatible build`). Terminate any
in-flight pre-Phase-1 run cleanly before upgrading. See spec §4.4.

---

## R18: JSON-RPC method name verification

Verified by `git grep -nE '"(thread|tool|turn|item|hook|response|user_input|userInput)/[a-zA-Z_/]+"' app-server-protocol/src protocol/src` at the pinned commit. The canonical declarations live in `app-server-protocol/src/protocol/common.rs` as `LHS => "wire/method/name" { params: ..., response: ... }` macro entries.

Methods that downstream tasks care about (R18's table from
`docs/plans/2026-05-02-codex-migration.md` lines 360-381), checked one
by one against the actual wire literals at this commit:

| R18 plan name          | Verified wire method                                | Source                                                                                            | Status                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`           | `initialize`                                        | (standard JSON-RPC, not in this grep)                                                             | verified — declared via the JSON-RPC initialise handshake; not part of the Codex-namespaced method set.                                                                                                                                                                                                                  |
| `threadStart`          | `thread/start`                                      | `app-server-protocol/src/protocol/common.rs:434`                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `threadResume`         | `thread/resume`                                     | `common.rs:440`                                                                                   | verified                                                                                                                                                                                                                                                                                                                 |
| `threadInjectItems`    | `thread/inject_items`                               | `common.rs:575`                                                                                   | verified                                                                                                                                                                                                                                                                                                                 |
| `threadNameSet`        | `thread/name/set`                                   | `common.rs:481`                                                                                   | verified                                                                                                                                                                                                                                                                                                                 |
| `threadSubscribe`      | **does not exist**                                  | (only `thread/unsubscribe` exists at `common.rs:457`)                                             | **CORRECTION** — there is no `thread/subscribe` request. Subscriptions are established as a side effect of `thread/start` and `thread/resume`; only an explicit `thread/unsubscribe` request is provided to detach. Downstream code that planned to call `thread/subscribe` must instead model subscription as implicit. |
| `turnStart`            | `turn/start`                                        | `common.rs:717`                                                                                   | verified                                                                                                                                                                                                                                                                                                                 |
| `toolDynamicCall`      | **`item/tool/call`**                                | `common.rs:1265` (`DynamicToolCall => "item/tool/call"`)                                          | **CORRECTION** — wire name is `item/tool/call`, not `tool/dynamicCall`. The Rust enum variant is still `DynamicToolCall`, but it serialises to `item/tool/call`.                                                                                                                                                         |
| `toolRequestUserInput` | **`item/tool/requestUserInput`**                    | `common.rs:1247`                                                                                  | **CORRECTION** — wire name is `item/tool/requestUserInput`, not `tool/requestUserInput`.                                                                                                                                                                                                                                 |
| `turnStarted`          | `turn/started`                                      | `common.rs:1387`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `turnCompleted`        | `turn/completed`                                    | `common.rs:1389`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `itemStarted`          | `item/started`                                      | `common.rs:1393`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `itemCompleted`        | `item/completed`                                    | `common.rs:1396`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `hookStarted`          | `hook/started`                                      | `common.rs:1388`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `hookCompleted`        | `hook/completed`                                    | `common.rs:1390`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `agentMessageDelta`    | `item/agentMessage/delta`                           | `common.rs:1399`                                                                                  | verified                                                                                                                                                                                                                                                                                                                 |
| `error`                | (per-message error envelope; not a discrete method) | (JSON-RPC error response carries the original method's id; there is no separate `"error"` method) | verified                                                                                                                                                                                                                                                                                                                 |

**Three corrections that must propagate to Task 4's
`packages/core/src/protocol/methodNames.ts`:**

1. Drop `threadSubscribe`. Subscription is implicit via
   `thread/start` / `thread/resume`; only `thread/unsubscribe`
   exists as an explicit method. If the daemon needs to disconnect a
   subscription, it sends `thread/unsubscribe` (`common.rs:457`).
2. `toolDynamicCall` literal is `'item/tool/call'`.
3. `toolRequestUserInput` literal is `'item/tool/requestUserInput'`.

Other notable methods discovered during the grep that downstream tasks
may want to reference:

- `thread/fork` — `common.rs:446`
- `thread/archive`, `thread/unarchive` — `common.rs:452`, `521`
- `thread/list`, `thread/loaded/list`, `thread/read` — `common.rs:552`,
  `557`, `562`
- `turn/steer`, `turn/interrupt` — `common.rs:723`, `729`
- `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`,
  `item/permissions/requestApproval` — `common.rs:1234`, `1241`, `1259`
- `thread/started`, `thread/closed`, `thread/status/changed`,
  `thread/name/updated`, `thread/tokenUsage/updated`,
  `thread/compacted` — `common.rs:1375-1423`
- `turn/diff/updated`, `turn/plan/updated` — `common.rs:1391`, `1392`

The complete grep output (truncated to relevant rows) is preserved at
the head of this section. Task 4's implementer should re-run
`git grep` if they need additional methods, but the corrections above
must land verbatim.

---

## Phase 4c approval policy and notifications

The headless aharness forces Codex app-server runs to use the explicit
config override `approval_policy = "on-request"` by passing
`-c approval_policy="on-request"` on every spawn. This is an internal
runtime default, not a public aharness CLI flag.

Source verification at pinned Codex commit `127434cd8b96`:

- `cli/src/main.rs:833-850` passes root `CliConfigOverrides` into
  `codex_app_server::run_main_with_transport(...)` for
  `codex app-server`.
- `utils/cli/src/config_override.rs` defines the root/global `-c` /
  `--config key=value` override syntax and parses values as TOML.
- `config/src/config_toml.rs:109`,
  `core/src/config/mod.rs:1785`, and
  `core/src/config/mod.rs:2428-2465` confirm the config key is
  `approval_policy`, the value type is `AskForApproval`, and default
  resolution can otherwise vary with project trust.
- `protocol/src/protocol.rs:936-966` confirms
  `AskForApproval::OnRequest` serializes as `"on-request"`.
- `cli/src/main.rs:411-438` confirms the `app-server` subcommand exposes
  listen, analytics, and websocket auth flags, but no
  app-server-specific `--approval-policy` flag. The aharness does not
  mirror root interactive/resume approval-policy aliases, does not
  reserve `approval-policy`, and does not document a public
  `aharness --approval-policy` surface in v1.

Approval notification audit:

- `app-server-protocol/src/protocol/common.rs:1394-1409` declares
  approval-adjacent notification methods including
  `item/autoApprovalReview/started`,
  `item/autoApprovalReview/completed`,
  `item/commandExecution/outputDelta`,
  `item/commandExecution/terminalInteraction`,
  `item/fileChange/patchUpdated`, and `serverRequest/resolved`.
- `item/fileChange/patchUpdated` must stay subscribed because file
  approval cards use Codex-sourced patch updates for diff display.
- `serverRequest/resolved` must stay subscribed because pending browser
  approval cards must clear when Codex resolves or discards parked
  ServerRequests.
- `item/autoApprovalReview/started` and
  `item/autoApprovalReview/completed` must also stay subscribed as
  approval lifecycle notifications, even though the v1 aharness does not
  render them.
- `item/commandExecution/outputDelta` and
  `item/commandExecution/terminalInteraction` are not required for
  approval-card lifecycle in Phase 4c; this package does not add new
  rendering behavior for those notifications in this chunk.

---

## Clear-on-entry model and reasoning-effort contract

The clear-on-entry model/effort feature depends on Codex app-server
surfaces that are present at the pinned commit `127434cd8b96`.

Source verification at the pinned commit:

- `app-server-protocol/src/protocol/v2.rs:3548-3618` declares
  `ThreadStartParams`. The aharness sends explicit clear replacement
  model selection through `thread/start.model`, and effort selection
  through `thread/start.config.model_reasoning_effort`; the required
  generic config channel is
  `pub config: Option<HashMap<String, JsonValue>>`.
- `app-server-protocol/src/protocol/common.rs:904-907` declares
  `ConfigRead => "config/read"` with `params: v2::ConfigReadParams`
  and `response: v2::ConfigReadResponse`.
- `app-server-protocol/src/protocol/v2.rs:926-934` declares
  `ConfigReadParams`, including optional `cwd`, so the aharness can
  ask Codex for the effective config from a clear replacement working
  directory.
- `app-server-protocol/src/protocol/v2.rs:939-945` declares
  `ConfigReadResponse { config: Config, ... }`. The effective config
  includes `model` and `model_reasoning_effort`; the aharness reads
  `model` for effort-only declarations and writes
  `model_reasoning_effort` under `thread/start.config` for replacement
  startup.
- `app-server-protocol/src/protocol/common.rs:770-773` declares
  `ModelList => "model/list"` with `params: v2::ModelListParams` and
  `response: v2::ModelListResponse`.
- `app-server-protocol/src/protocol/v2.rs:2485-2495` declares
  `ModelListParams`, including `include_hidden`. The aharness uses
  `includeHidden: true` so explicit model declarations are checked
  against the full catalog.
- `app-server-protocol/src/protocol/v2.rs:2515-2534` declares the
  model catalog entry. The aharness relies on `model`,
  `supported_reasoning_efforts`, `default_reasoning_effort`, and
  `is_default`.
- `app-server-protocol/src/protocol/v2.rs:2549-2552` declares
  `ReasoningEffortOption { reasoning_effort, description }`.
- `app-server-protocol/src/protocol/v2.rs:2557-2562` declares
  `ModelListResponse { data, next_cursor }`; the aharness follows
  pagination until `nextCursor` is absent.
- `protocol/src/openai_models.rs:43-51` declares `ReasoningEffort`
  with values `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`
  via lowercase serde serialization.

The offline drift checker verifies these snippets and spans with the
`clear-on-entry-model-contract` check. If any required source surface is
missing at a future pin, do not keep this feature by relying on mutable
local Codex `HEAD`; either bump the documented pin to a commit that
contains the contract or revise the aharness implementation and docs.

---

## R19: `turn/started` originator field

The `TurnStartedNotification` payload at the pinned commit carries
**no** `originator_connection_id` or equivalent field.

Source: `app-server-protocol/src/protocol/v2.rs:6774-6780`:

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct TurnStartedNotification {
    pub thread_id: String,
    pub turn: Turn,
}
```

The nested `Turn` struct (`v2.rs:5193-5211`) has only:

```rust
pub struct Turn {
    pub id: String,
    pub items: Vec<ThreadItem>,
    pub status: TurnStatus,
    pub error: Option<TurnError>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
}
```

Neither shape exposes the originating client's connection id.

**R19 strategy: fall back to the heuristic.** Per R19 of the migration
plan: "If the field does not exist, the router falls back to the
current heuristic — `turn/started` after a `turn/completed` whose Stop
hook returned `decision: block` is drive-forward; otherwise
user-driven — and §8.1 row 1 of the design must be amended to
acknowledge the fallback." Task 31 implements this fallback and
documents it inline in `notificationRouter.ts`. A separate one-line
follow-up is required to amend
`docs/specs/2026-05-01-codex-migration-design.md` §8.1 row 1.

---

## R20: `thread/resume` × `ephemeral=true` interaction

`thread/resume` does **not** work on an ephemeral thread, even when
the in-memory thread state is still alive. The reason is the
implementation reads from the persistent `thread_store` regardless of
whether the thread is also live in memory.

Evidence trace (file:line at the pinned commit):

1. `app-server/src/codex_message_processor.rs:4334` — `thread_resume`
   first calls `self.resume_running_thread(...)`. If that returns
   `Ok(true)` the request is satisfied; otherwise control falls
   through to `resume_thread_from_history` / `resume_thread_from_rollout`.
2. `app-server/src/codex_message_processor.rs:4571-4633` —
   `resume_running_thread` _requires_ a stored thread payload. In every
   branch where the in-memory thread is alive, it calls
   `self.read_stored_thread_for_resume(...)` (lines 4591, 4617) to
   produce the `source_thread`. The handler then synthesises the
   resume by combining the live thread with the stored history
   (lines 4636-4644: `let history_items = source_thread.history…`).
3. `core/src/session/session.rs:384-438` — when
   `config.ephemeral == true`, the session-init future returns
   `Ok::<_, anyhow::Error>(None)` for `thread_persistence_fut` and
   skips both `LiveThread::create` and `LiveThread::resume`. No
   `thread_store` registration occurs.
4. The same file at line 446: `if config.ephemeral { None }` — the
   `state_db_fut` is also skipped for ephemeral threads.

Net effect: an ephemeral thread is never written to `thread_store`,
so `read_stored_thread_for_resume` finds nothing, and
`resume_running_thread` cannot complete the resume even though the
in-memory thread is alive.

**R20 strategy: drop the `thread/resume` call from Task 48's TUI
reconnect path.** The TUI must re-attach to the in-memory thread by
some other mechanism. Since `thread/subscribe` does not exist
(see R18), and `thread/resume` cannot be used on ephemeral threads,
the only remaining option is for the TUI to attach by `thread_id` via
the implicit subscription that `thread/start` would establish for a
new thread — but that path is not "resume" semantics, it's
"start a fresh thread with this id". Task 48's implementer needs to
either:

- accept that ephemeral threads cannot be reconnected from a fresh
  TUI process at all (the daemon's existing connection retains the
  thread, and a second connection cannot piggyback), and document
  this limitation in `runCli.ts`;
- or stop using `ephemeral=true` and let the rollout get written so
  `thread/resume` works.

Task 48 must pick one. The design (§9.2) currently assumes
`thread/resume` works on ephemeral threads; that assumption is
**incorrect** and must be amended in a follow-up PR.

---

## TOML model-provider key shape (Task 0 item 10)

The Codex TOML configuration uses two keys for model-provider
selection and definition:

1. **`model_provider`** (top-level, optional) — selects a provider id
   from the `model_providers` map. Declared at
   `config/src/config_toml.rs:99-100`:

   ```rust
   /// Provider to use from the model_providers map.
   pub model_provider: Option<String>,
   ```

   Resolution at `core/src/config/mod.rs:2505-2509`: `model_provider`
   from CLI overrides → `config_profile.model_provider` →
   `cfg.model_provider` (TOML) → looked up in the merged providers
   map.

2. **`[model_providers.<id>]`** (table, repeatable) — defines a
   provider entry whose key is the provider id. Declared at
   `config/src/config_toml.rs:222-225`:

   ```rust
   /// User-defined provider entries that extend the built-in list. Built-in
   /// IDs cannot be overridden.
   #[serde(default, deserialize_with = "deserialize_model_providers")]
   pub model_providers: HashMap<String, ModelProviderInfo>,
   ```

   Built-in provider ids cannot be overridden
   (validation at `config_toml.rs:889-906`).

A minimal TOML override looks like:

```toml
model_provider = "my_provider"

[model_providers.my_provider]
# ModelProviderInfo fields…
```

Both keys are stable on this commit. Task 14 reads this section as
the source-of-truth for the keys and must not independently
re-verify.

---

## R21: `turn/interrupt` params shape and `turn/aborted` absence

### `turn/interrupt` wire literal and params struct

Verified at pinned commit `127434cd8b96`:

- Wire literal: `"turn/interrupt"` at
  `app-server-protocol/src/protocol/common.rs:729`
  (`TurnInterrupt => "turn/interrupt" { params: v2::TurnInterruptParams, … }`).

- `TurnInterruptParams` struct at
  `app-server-protocol/src/protocol/v2.rs:5702-5706`:

  ```rust
  #[serde(rename_all = "camelCase")]
  pub struct TurnInterruptParams {
      pub thread_id: String,
      pub turn_id: String,
  }
  ```

  Wire fields are camelCase: `threadId`, `turnId`. The TypeScript type
  `TurnInterruptParams` in `src/protocol/types.ts` mirrors these names
  verbatim.

- `TurnInterruptResponse` struct at
  `app-server-protocol/src/protocol/v2.rs:5710`:

  ```rust
  pub struct TurnInterruptResponse {}
  ```

  Modelled as `Record<string, never>` in TypeScript.

### `turn/aborted` is NOT in the v2 `ServerNotification` enum

The grep

```bash
git -C /path/to/codex grep '"turn/aborted"\|TurnAborted' \
  codex-rs/app-server-protocol/src/protocol/common.rs \
  codex-rs/app-server-protocol/src/protocol/v2.rs
```

returns no matches at the pinned commit. `TurnAborted` is an internal
`EventMsg` variant consumed in-process by codex
(`app-server/src/bespoke_event_handling.rs:1117-1134`); codex translates
it into a `turn/completed` notification with
`params.turn.status === 'interrupted'` on the v2 wire. There is no
`turn/aborted` notification discriminant in the v2 `ServerNotification`
enum. The cross-state design's reliance on `turn/interrupt` response
resolution (rather than a `turn/aborted` notification subscription) is
correct for this codex version.

Verification: `protocol.methodNames.test.ts` includes a canary test
asserting that `METHOD.turnAborted` is `undefined`; a future codex
version that adds the notification literal would need to update the spec
and this table before removing that canary.

---

## Bump procedure

When bumping the pinned codex commit:

1. Re-run the verification table above against the new commit. For
   each path: confirm the file exists and the cited content is still
   findable (same line range or moved). Update the "Status" and
   "Note" columns. If content is missing, the bump fails — do not
   update the pin until the design or the codex commit is reconciled.
2. Re-run the R18 method-name `git grep` against the new commit.
   Compare each method literal to `packages/core/src/protocol/methodNames.ts`.
   Wire-name changes are breaking and must update both
   `methodNames.ts` and every call site.
3. Re-inspect `TurnStartedNotification` (`app-server-protocol/src/protocol/v2.rs`,
   search for the type) — if the originator-id field appears,
   amend Task 31's notification router to use the exact field instead
   of the heuristic; otherwise, re-confirm absence.
4. Re-inspect `thread_resume` and `resume_running_thread` (in
   `app-server/src/codex_message_processor.rs`) plus the
   `if config.ephemeral` branches in `core/src/session/session.rs`.
   If the ephemeral path now registers with `thread_store` so that
   `thread/resume` works, amend Task 48 accordingly.
5. Re-inspect `model_provider` / `model_providers` declarations in
   `config/src/config_toml.rs` and the resolution chain in
   `core/src/config/mod.rs`. Update the TOML section above if any
   key name or `serde` rename changes.
6. Re-run the `clear-on-entry-model-contract` drift check. Re-inspect
   `ThreadStartParams.config`, `config/read`, `model/list`,
   `Model.supported_reasoning_efforts`, and `ReasoningEffort` before
   changing the pin.
7. Update the commit hash header at the top of this file and the
   `git-<short-hash>` line in `scripts/codex-version-min.txt`.
8. Re-run integration tests against the new commit.
