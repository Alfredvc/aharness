/**
 * `MockOwnerInputProvider` — test-support implementation of the
 * `OwnerInputProvider` interface (Phase 2b owner-yield path).
 *
 * The CLI's `item/tool/requestUserInput` ServerRequest handler (in
 * `runCli.ts`) calls `provideAnswers(params)` to satisfy each parked
 * request. Integration tests pre-load this mock with the answers they
 * expect to send, then run the CLI: each ServerRequest dequeues one
 * queued response in FIFO order.
 *
 * Lives in `@aharness/test-support` (not in `@aharness/core/src/cli`)
 * so the production CLI does not pull test-only code into its tree. The
 * `@aharness/core` package ships only the bare interface + the stdin
 * implementation; the richer fixture is here.
 *
 * Per `docs/plans/2026-05-13-headless-phase-2b-owner-yield.md` §Task 2.
 */
import type { OwnerInputProvider } from '@aharness/core';
import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '@aharness/core/runtime';

/**
 * Function-form queue entry. The CLI hands the request params verbatim;
 * the function returns the full response (sync or async). Used by tests
 * that need to assert against the request shape before answering.
 */
export type MockOwnerInputResponder = (
  params: ToolRequestUserInputParams,
) => ToolRequestUserInputResponse | Promise<ToolRequestUserInputResponse>;

/**
 * Static-map queue entry. Convenience for the common case where the
 * test knows the answer per question id without needing to inspect the
 * incoming request. Single-string entries are wrapped into a one-element
 * `answers` array; multi-string entries pass through verbatim.
 *
 * The map is converted to the double-nested wire shape
 * `{answers: {<qid>: {answers: [<text>...]}}}` at dequeue time
 * (CF-3; see `protocol/types.ts:ToolRequestUserInputResponse`).
 */
export type MockOwnerInputStaticAnswers = Record<string, ReadonlyArray<string>>;

/**
 * Read-back surface for tests that need to observe the CLI's call
 * pattern after the run terminates. `getReceivedRequests()` returns
 * every `provideAnswers(params)` call's params in order; `closeCallCount`
 * exposes how many times `close()` was invoked (the integration test
 * for the CLI's shutdown path asserts this equals 1 on a clean run).
 *
 * Implements `OwnerInputProvider` so the mock can be passed directly to
 * `runCliForTest`'s `ownerInputProvider` opt.
 */
export interface MockOwnerInputProvider extends OwnerInputProvider {
  /**
   * Enqueue a static `{qid -> answer strings}` map. The mock converts
   * it to `{answers: {<qid>: {answers: [...]}}}` at dequeue time.
   */
  queueAnswers(answers: MockOwnerInputStaticAnswers): void;
  /**
   * Enqueue a function that receives the request params and produces
   * the response. Useful when the test wants to assert against the
   * question shape (e.g. that a specific marker is in `question.question`).
   */
  queueResponder(fn: MockOwnerInputResponder): void;
  /**
   * Every `provideAnswers(params)` call's params, in invocation order.
   * Returned as `ReadonlyArray` to discourage mutation; tests assert
   * `.length`, individual entries, and the questions inside.
   */
  getReceivedRequests(): ReadonlyArray<ToolRequestUserInputParams>;
  /**
   * Number of times `close()` has been invoked. The integration test
   * asserts this equals 1 after a clean run terminates — covers the
   * `runShutdown` close-lifecycle contract.
   */
  readonly closeCallCount: number;
  close(): void;
}

type QueueEntry =
  | { kind: 'static'; answers: MockOwnerInputStaticAnswers }
  | { kind: 'fn'; fn: MockOwnerInputResponder };

/**
 * Build a fresh `MockOwnerInputProvider`. The queue starts empty;
 * tests call `queueAnswers(...)` or `queueResponder(...)` before
 * invoking the CLI, then read back via `getReceivedRequests()` after.
 *
 * On empty queue, `provideAnswers` rejects with a diagnostic error
 * listing the request's question ids — helpful for "I forgot to queue
 * this" failures.
 */
export function createMockOwnerInputProvider(): MockOwnerInputProvider {
  const queue: QueueEntry[] = [];
  const received: ToolRequestUserInputParams[] = [];
  let closeCallCount = 0;

  const provider: MockOwnerInputProvider = {
    queueAnswers(answers) {
      queue.push({ kind: 'static', answers });
    },
    queueResponder(fn) {
      queue.push({ kind: 'fn', fn });
    },
    getReceivedRequests() {
      return received;
    },
    get closeCallCount() {
      return closeCallCount;
    },
    async provideAnswers(params) {
      received.push(params);
      const next = queue.shift();
      if (next === undefined) {
        const qids = params.questions.map((q) => q.id).join(', ');
        throw new Error(`MockOwnerInputProvider: queue empty (received question(s): ${qids})`);
      }
      if (next.kind === 'fn') {
        return await next.fn(params);
      }
      // Static-map branch: build the double-nested wire shape from
      // {qid -> string[]}. Each entry's array is preserved verbatim so
      // multi-line answers (rare; mostly the M2 two-question shape) pass
      // through without being collapsed.
      const wire: Record<string, { answers: string[] }> = {};
      for (const [qid, lines] of Object.entries(next.answers)) {
        wire[qid] = { answers: [...lines] };
      }
      return { answers: wire } satisfies ToolRequestUserInputResponse;
    },
    close() {
      closeCallCount += 1;
    },
  };

  return provider;
}
