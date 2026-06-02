/**
 * Notification methods the headless aharness opts out of via the
 * `optOutNotificationMethods` capability at `initialize`. Spec §5.7.
 *
 * Codex's `OutgoingMessageSender` honours this list for both parent and
 * auto-attached sub-thread notifications (CF-17). The aharness CLI
 * receives only the methods NOT in this list. Runtime capture depends on
 * staying subscribed to parent-thread `turn/started`, `turn/completed`,
 * `item/started`, and `item/completed`; `item/agentMessage/delta` for stdout
 * streaming; `rawResponseItem/completed` for raw function-tool transcript/UI
 * publication; `item/fileChange/patchUpdated` and `serverRequest/resolved`
 * for approval lifecycles; and `thread/tokenUsage/updated` for canonical
 * token usage JSONL events.
 *
 * Created as part of Task 17 (Phase 1b) — Task 15 will dedupe its own
 * use of this constant by re-exporting from here.
 *
 * The raw response-item completion notification (see
 * `METHOD.rawResponseItemCompleted` in `protocol/methodNames.ts`) stays out
 * of this opt-out list so built-in function-tool lifecycle items remain
 * available for transcript/UI publication.
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
