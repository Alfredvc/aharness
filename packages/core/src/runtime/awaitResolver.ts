/**
 * `awaitResolver` — observes `rawResponseItem/completed` notifications to
 * detect when the TUI has resolved a `request_user_input` server-request
 * and commits the corresponding `AWAIT__<state>__<exit>` event into the
 * FSM.
 *
 * # Why `rawResponseItem/completed` and not `item/completed`
 *
 * The original design (§5.7) called for observing `item/completed`. That
 * is wrong against the pinned codex commit (`127434cd8b96`):
 *
 * - `request_user_input` is a built-in `ToolKind::Function`, not a
 *   dynamic tool or MCP tool. Its handler lives at
 *   `/tmp/codex-rs/codex-rs/core/src/tools/handlers/request_user_input.rs`.
 *
 * - `item/completed`'s `ThreadItem` discriminated union (verified at
 *   `/tmp/codex-rs/codex-rs/app-server-protocol/src/protocol/v2.rs:5861-6011`)
 *   contains no `function_call` / `function_call_output` variant — only
 *   richer envelopes for assistant messages, dynamic tool calls,
 *   reasoning, etc. Built-in function calls are not surfaced through
 *   `item/completed`. (Emission site:
 *   `/tmp/codex-rs/codex-rs/core/src/session/mod.rs:1649-1657`.)
 *
 * - Built-in function-call lifecycle IS surfaced on
 *   `rawResponseItem/completed` (declared at
 *   `/tmp/codex-rs/codex-rs/app-server-protocol/src/protocol/common.rs:1398`,
 *   payload at `v2.rs:6948`). Each notification carries one
 *   `ResponseItem` (`protocol/src/models.rs:743`); for our purposes the
 *   relevant variants are `function_call` and `function_call_output`
 *   (`models.rs:778-814`).
 *
 * Therefore the daemon listens on `rawResponseItem/completed`, tracks
 * open `function_call` items by `call_id`, and on the matching
 * `function_call_output` for `request_user_input` parses the answer JSON
 * and commits an `AWAIT__*` event. The original §5.7 prose remains
 * correct in spirit; the wire shape was wrong, and a follow-up will
 * amend the design doc.
 *
 * # Wire shape of the output
 *
 * `request_user_input`'s handler (`request_user_input.rs:66-72`) builds
 * its `FunctionToolOutput` via `FunctionToolOutput::from_text(content,
 * Some(true))`, where `content` is `serde_json::to_string(&response)`
 * for a `ToolRequestUserInputResponse` whose shape is
 * `{ answers: HashMap<questionId, { answers: string[] }> }`
 * (`v2.rs:7862-7864`).
 *
 * That `FunctionToolOutput` is then converted to a
 * `ResponseItem::FunctionCallOutput` via `function_tool_response`
 * (`core/src/tools/context.rs:548-573`). That converter inspects the
 * body and **collapses a single `InputText` item to
 * `FunctionCallOutputBody::Text(string)`**, otherwise produces
 * `FunctionCallOutputBody::ContentItems(...)`. The custom serializer
 * (`protocol/src/models.rs:1454-1463`) emits `Text(s)` as a bare JSON
 * string and `ContentItems(items)` as a bare JSON array — there is no
 * `content_items` wrapper object on the wire.
 *
 * The resolver therefore handles three observed/permitted output shapes:
 *
 *   1. `output: "<JSON-string>"` — the actual current shape for
 *      `request_user_input` (single `InputText` collapsed).
 *   2. `output: [{ type: "input_text", text: "<JSON-string>" }, ...]` —
 *      multi-item form (the codex types permit this; not currently
 *      emitted for `request_user_input` but defensively supported).
 *   3. `output: { content_items: [{ type: "input_text", text: "..." }] }`
 *      — a defensive accommodation in case codex evolves to wrap the
 *      array under a discriminant key. Not present at the pinned
 *      commit; included so an unverified upstream change does not
 *      silently break the resolver.
 *
 * In every case the resolver concatenates the `text` of every
 * `input_text` content item (joined by newlines), parses the result as
 * JSON, and reads `answers`. Malformed JSON is logged and dropped.
 */

/**
 * Closure inputs the resolver needs from the daemon. Kept as accessors
 * so this module does not depend on `ActorHost` directly.
 */
export interface AwaitResolverInput {
  readonly currentStateId: () => string;
  /**
   * Name of the current leaf state's await-kind exit, or `null` when no
   * such exit is declared. When `null` the resolver drops any
   * `function_call_output` for `request_user_input` — the FSM is in a
   * state that does not observe owner-yields (race-loss path; see
   * §5.7).
   */
  readonly currentAwaitExitName: () => string | null;
  /**
   * Send `AWAIT__<stateId>__<exitName>` with the user's reply text into
   * the live actor. The daemon owns post-commit side-effects (JSONL-backed
   * state event publication, nudge inject); this resolver only commits.
   */
  readonly commitAwait: (
    stateId: string,
    exitName: string,
    messageFromUser: string,
    nextContext?: Record<string, unknown>,
  ) => Promise<void> | void;
  /**
   * Optional pre-commit hook for canonical transitions that need async work
   * before the AWAIT event becomes visible to XState. When supplied, the
   * resolver commits only after the hook succeeds.
   */
  readonly prepareAwaitCommit?: (
    stateId: string,
    exitName: string,
    messageFromUser: string,
  ) =>
    | Promise<
        | { readonly ok: true; readonly nextContext?: Record<string, unknown> }
        | { readonly ok: false; readonly error: string }
      >
    | { readonly ok: true; readonly nextContext?: Record<string, unknown> }
    | { readonly ok: false; readonly error: string };
  /**
   * Hook fired immediately after `commitAwait`. The daemon wires its
   * post-transition pipeline here (state-entry side effects and optional
   * clear-on-entry scheduling). May be sync or async; the resolver awaits it.
   */
  readonly onAfterTransition: (info: {
    readonly from: string;
    readonly to: string;
    readonly oldThreadId?: string;
    readonly oldTurnId?: string;
  }) => Promise<void> | void;
}

/**
 * Public surface. The notification router (Task 31) calls
 * `noteFunctionCall` when it observes a `function_call` `ResponseItem`
 * and `handleFunctionCallOutput` when it observes a
 * `function_call_output` `ResponseItem`.
 */
export interface AwaitResolver {
  /**
   * Record an in-flight `function_call`. Only `request_user_input`
   * calls are retained — other names are dropped so the map stays
   * bounded by the number of concurrent `request_user_input` calls
   * (typically 0 or 1).
   */
  readonly noteFunctionCall: (item: { call_id: string; name: string; arguments: string }) => void;
  /**
   * Process a `function_call_output`. Drops silently when:
   *   - the `call_id` was not previously noted as `request_user_input`,
   *   - the current state has no await exit,
   *   - the wire payload is malformed.
   */
  readonly handleFunctionCallOutput: (
    item: { call_id: string; output: unknown },
    source?: { readonly threadId?: string; readonly turnId?: string },
  ) => Promise<void>;
}

/**
 * Internal record kept per open `request_user_input` call. We retain
 * the `questions` array (when present in the call's `arguments`) to
 * preserve answer ordering when the response answers each question.
 */
interface OpenCall {
  readonly questions: ReadonlyArray<{ id: string }>;
}

/**
 * Build a resolver bound to the given accessors. Stateful: the returned
 * object owns a `Map<callId, OpenCall>` for the lifetime of the run.
 */
export function createAwaitResolver(i: AwaitResolverInput): AwaitResolver {
  const open = new Map<string, OpenCall>();

  return {
    noteFunctionCall: (item) => {
      if (item.name !== 'request_user_input') return;
      let questions: ReadonlyArray<{ id: string }> = [];
      try {
        const parsed = JSON.parse(item.arguments) as unknown;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { questions?: unknown }).questions)
        ) {
          // Best-effort: only keep `id` since that is all the resolver
          // needs for ordering. Other fields (header, options, ...) are
          // discarded to keep the in-memory record tiny.
          const raw = (parsed as { questions: ReadonlyArray<unknown> }).questions;
          questions = raw
            .filter(
              (q): q is { id: string } =>
                q !== null &&
                typeof q === 'object' &&
                typeof (q as { id?: unknown }).id === 'string',
            )
            .map((q) => ({ id: q.id }));
        }
      } catch {
        // Malformed `arguments` JSON: keep the call open with no
        // ordering hint; the response side will fall back to lexical
        // ordering of question ids.
      }
      open.set(item.call_id, { questions });
    },

    handleFunctionCallOutput: async (item, source) => {
      const record = open.get(item.call_id);
      if (!record) return; // Not a tracked `request_user_input` call.

      const exitName = i.currentAwaitExitName();
      if (exitName === null) {
        // Race-loss path: state has no await exit. Drop without
        // committing; clean up the map regardless so it does not leak.
        open.delete(item.call_id);
        return;
      }

      const text = extractOutputText(item.output);
      if (text === null) {
        // Malformed wire payload — no `input_text` content found and no
        // string output. Log and drop.
        console.warn(
          `awaitResolver: dropping function_call_output(call_id=${item.call_id}) — no readable text in output`,
        );
        open.delete(item.call_id);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        console.warn(
          `awaitResolver: dropping function_call_output(call_id=${item.call_id}) — text is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        open.delete(item.call_id);
        return;
      }

      const messageFromUser = flattenAnswers(parsed, record.questions);
      if (messageFromUser === null) {
        console.warn(
          `awaitResolver: dropping function_call_output(call_id=${item.call_id}) — answers payload missing or malformed`,
        );
        open.delete(item.call_id);
        return;
      }

      open.delete(item.call_id);
      const stateId = i.currentStateId();
      const prepared =
        i.prepareAwaitCommit === undefined
          ? ({ ok: true } as const)
          : await i.prepareAwaitCommit(stateId, exitName, messageFromUser);
      if (!prepared.ok) {
        return;
      }
      if (prepared.nextContext === undefined) {
        await i.commitAwait(stateId, exitName, messageFromUser);
      } else {
        await i.commitAwait(stateId, exitName, messageFromUser, prepared.nextContext);
      }
      await i.onAfterTransition({
        from: stateId,
        to: i.currentStateId(),
        ...(source?.threadId !== undefined ? { oldThreadId: source.threadId } : {}),
        ...(source?.turnId !== undefined ? { oldTurnId: source.turnId } : {}),
      });
    },
  };
}

/**
 * Read the user-facing text from a `ResponseItem::FunctionCallOutput`'s
 * `output` field. Codex's `FunctionCallOutputPayload` serializes either
 * as a bare string or as a bare array of content items
 * (`models.rs:1454-1463`); a defensive third shape (object with
 * `content_items` key) is also tolerated. Returns `null` on any
 * unexpected shape.
 */
function extractOutputText(output: unknown): string | null {
  // Shape 1: plain string.
  if (typeof output === 'string') return output;

  // Shape 2: bare array of content items.
  if (Array.isArray(output)) {
    return joinInputText(output);
  }

  // Shape 3 (defensive): object wrapping `content_items`.
  if (
    output !== null &&
    typeof output === 'object' &&
    Array.isArray((output as { content_items?: unknown }).content_items)
  ) {
    return joinInputText((output as { content_items: ReadonlyArray<unknown> }).content_items);
  }

  return null;
}

/**
 * Join the `text` of every `{ type: "input_text", text: string }`
 * entry, preserving order. Returns `null` when no readable text was
 * found.
 */
function joinInputText(items: ReadonlyArray<unknown>): string | null {
  const out: string[] = [];
  for (const it of items) {
    if (
      it !== null &&
      typeof it === 'object' &&
      (it as { type?: unknown }).type === 'input_text' &&
      typeof (it as { text?: unknown }).text === 'string'
    ) {
      out.push((it as { text: string }).text);
    }
  }
  if (out.length === 0) return null;
  return out.join('\n');
}

/**
 * Flatten a parsed `ToolRequestUserInputResponse` into a single string.
 *
 * The wire shape is `{ answers: { [qid]: { answers: string[] } } }`.
 * Question order is preserved per the originating `function_call`'s
 * `arguments.questions` array when available; missing question ids are
 * appended in lexical order as a tie-breaker. All answer strings (across
 * all questions) are joined with `"\n"`.
 *
 * Returns `null` when `answers` is missing or non-object.
 */
function flattenAnswers(parsed: unknown, questions: ReadonlyArray<{ id: string }>): string | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const answersField = (parsed as { answers?: unknown }).answers;
  if (answersField === null || typeof answersField !== 'object' || Array.isArray(answersField)) {
    return null;
  }
  const map = answersField as Record<string, unknown>;

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    if (q.id in map && !seen.has(q.id)) {
      orderedIds.push(q.id);
      seen.add(q.id);
    }
  }
  // Lexical fallback for ids present in the response but not in the
  // saved questions array (e.g. malformed `arguments` on the original
  // call, or codex synthesizing extra ids).
  const remaining = Object.keys(map)
    .filter((id) => !seen.has(id))
    .sort();
  for (const id of remaining) orderedIds.push(id);

  const flat: string[] = [];
  for (const id of orderedIds) {
    const entry = map[id];
    if (entry === null || typeof entry !== 'object') continue;
    const arr = (entry as { answers?: unknown }).answers;
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      if (typeof a === 'string') flat.push(a);
    }
  }

  return flat.join('\n');
}
