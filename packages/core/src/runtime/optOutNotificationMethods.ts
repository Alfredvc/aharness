/**
 * Notification methods the headless harness opts out of via the
 * `optOutNotificationMethods` capability at `initialize`. Spec §5.7.
 *
 * Codex's `OutgoingMessageSender` honours this list for both parent and
 * auto-attached sub-thread notifications (CF-17). The harness CLI
 * receives only the methods NOT in this list — the router only needs to
 * subscribe to the parent-thread variants of `turn/started`,
 * `turn/completed`, `item/started`, `item/completed` plus the
 * `item/agentMessage/delta` stream for the stdout UI.
 *
 * Created as part of Task 17 (Phase 1b) — Task 15 will dedupe its own
 * use of this constant by re-exporting from here.
 *
 * Phase 2b: the raw response-item completion notification (see
 * `METHOD.rawResponseItemCompleted` in `protocol/methodNames.ts`) is no
 * longer in the opt-out list; `awaitResolver` subscribes via
 * `runCli.ts` to observe `request_user_input` `function_call_output`
 * items and fire `AWAIT__<state>__<exit>` transitions.
 *
 * Phase 4c audit against pinned Codex commit `127434cd8b96`,
 * `app-server-protocol/src/protocol/common.rs:1394-1409`:
 * approval lifecycle notifications must stay subscribed. In particular,
 * do not add `item/fileChange/patchUpdated`, `serverRequest/resolved`,
 * `item/autoApprovalReview/started`, or
 * `item/autoApprovalReview/completed` to this list.
 */
export const PHASE1_OPT_OUT_METHODS: ReadonlyArray<string> = Object.freeze([
  'app/list/updated',
  'fs/changed',
  'fuzzyFileSearch/textSearch/match',
  'fuzzyFileSearch/textSearch/done',
  'mcpToolCall/progress',
  'thread/compacted',
  'thread/realtime/audio/chunk',
  'thread/realtime/audio/start',
  'thread/realtime/audio/end',
  'thread/realtime/audio/error',
  'process/started',
  'process/stopped',
  'windows/visibilityUpdated',
  'windowsSandbox/installAvailable',
  'windowsSandbox/installNeeded',
]);
