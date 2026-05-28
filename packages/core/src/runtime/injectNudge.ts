/**
 * Thin wrapper that turns a piece of orientation text into a
 * `thread/inject_items` JSON-RPC request against the codex `app-server`.
 * The dispatcher (`daemon/dispatchSubmit.ts`) and the await-side resolver
 * call this after a state transition so the model's next turn opens with
 * the new state's orientation already in its rollout history (see
 * codex-migration design §5.5 step 6e and §5.7).
 *
 * Wire shape — verified against codex-rs at the pinned commit (Task 4 /
 * commit 18cfa697):
 *
 *   - Method literal: `thread/inject_items` (sourced via
 *     `METHOD.threadInjectItems`; declared in
 *     `app-server-protocol/src/protocol/common.rs:575` as
 *     `ThreadInjectItems => "thread/inject_items"`).
 *   - Params shape: `ThreadInjectItemsParams` at
 *     `app-server-protocol/src/protocol/v2.rs:5661-5668` carries
 *     `#[serde(rename_all = "camelCase")]`, so `thread_id` is wire-named
 *     `threadId`. `items` is `Vec<JsonValue>` — raw Responses API items.
 *   - Item shape: `ResponseItem` at `protocol/src/models.rs:741-743` is
 *     `#[serde(tag = "type", rename_all = "snake_case")]`; the `Message`
 *     variant therefore wire-tags as `"message"` with fields `role`
 *     (string) and `content` (Vec<ContentItem>). `ContentItem` at
 *     `protocol/src/models.rs:697-699` is also
 *     `#[serde(tag = "type", rename_all = "snake_case")]`; the
 *     `InputText` variant wire-tags as `"input_text"` with a `text`
 *     field. So the per-item payload below is the literal Responses API
 *     shape codex appends to the rollout (see codex's own integration
 *     test at
 *     `app-server/tests/suite/v2/thread_inject_items.rs:55-69`).
 *
 * `role: 'developer'` is the orientation channel: the aharness writes
 * framework-authored guidance, never user content. The codex thread has
 * no schema-level allowlist for role strings (`role: String` in the Rust
 * struct); we use `developer` to match codex's own conventions for
 * out-of-band system-level injection.
 *
 * Error policy: errors propagate from the underlying `client.request`
 * unchanged. Callers (notably the submit dispatcher; see Task 19 / R6
 * step e) wrap this call in their own try/catch and route failures to a
 * non-fatal log sink — `injectNudge` itself stays a thin transport
 * adapter and does not impose a swallow policy on every consumer.
 */
import type { JsonRpcClient } from '../jsonrpc/client.js';
import { METHOD } from '../protocol/methodNames.js';

export interface CreateInjectNudgeOpts {
  readonly client: Pick<JsonRpcClient, 'request'>;
  readonly threadId: string;
}

export type InjectNudge = (text: string) => Promise<void>;

export function createInjectNudge(o: CreateInjectNudgeOpts): InjectNudge {
  return async (text) => {
    await o.client.request(METHOD.threadInjectItems, {
      threadId: o.threadId,
      items: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text }],
        },
      ],
    });
  };
}
